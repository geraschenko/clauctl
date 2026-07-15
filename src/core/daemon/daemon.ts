/**
 * `clauctl _daemon` — the per-agent supervisor. One per agent. It owns the
 * single programmatic SDK connection (a long-lived streaming-input `query()`),
 * serves the sdk.sock command channel, and is the sole writer of agent.json.
 */

import { once } from "node:events";
import { closeSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { type Server } from "node:net";
import { join } from "node:path";
import { numberParser } from "@stricli/core";
import {
  getSessionMessages,
  query,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isBusy } from "../assistant-state.ts";
import {
  acceptUserMessage,
  deliveredMessages,
  INITIAL_QUEUE_MODEL_STATE,
  observeSdkMessage,
  type QueueModelState,
  type QueueTransition,
} from "../queue-model.ts";
import {
  auditEnabled,
  recordAuditEvent,
  resolveCallerSourceForPid,
} from "../generated/audit.ts";
import {
  commandNoTarget,
  parsedFlag,
  requiredStringFlag,
  type InferFlags,
} from "../generated/cli.ts";
import { TtyServer, type AttachmentInfo } from "../generated/tty-server.ts";
import { invariantOptions } from "../options.ts";
import {
  agentDirPath,
  daemonLogPath,
  readAgentRecord,
  readSpawnOptions,
  sdkSocketPath,
  spawnOptionsPath,
  ttySocketPath,
  writeAgentRecord,
  type AgentRecord,
} from "../registry.ts";
import {
  applyMutation,
  isControlMutation,
  persistedOptionsAfter,
  runRead,
} from "../sdk-passthrough.ts";
import {
  type SdkControlMutation,
  type SdkRequestRecord,
  type SdkResponse,
  type StateSnapshot,
} from "../sdk-socket.ts";
import { type CommandContext } from "../generated/targets.ts";
import { EventBus } from "./event-bus.ts";
import {
  RESPONSE_SENT,
  startSdkServer,
  type SdkConnection,
} from "./sdk-server.ts";
import { TuiHost } from "./tui-host.ts";
import { TurnQueue } from "./turn-queue.ts";

const daemonFlags = {
  agentId: requiredStringFlag("Agent id", "uuid"),
  readyFd: parsedFlag("Ready fd", numberParser, "int"),
};

type DaemonFlags = InferFlags<typeof daemonFlags>;

function signalReady(
  readyFd: number | undefined,
  message: { ok: boolean; error?: string },
): void {
  if (readyFd === undefined) {
    return;
  }
  try {
    writeSync(readyFd, `${JSON.stringify(message)}\n`);
    closeSync(readyFd);
  } catch {
    // Spawner already gone; the daemon runs on regardless.
  }
}

/**
 * Where claude persists the session transcript: config dir + the project key
 * (cwd with every non-alphanumeric character replaced by '-'). Recorded in
 * the registry so the transcript is findable on disk; clauctl itself never
 * reads it back.
 */
function sessionFilePath(cwd: string, sessionId: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const projectKey = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return join(configDir, "projects", projectKey, `${sessionId}.jsonl`);
}

/** `Options.env` replaces the subprocess env entirely, so rebuild it fully. */
function childEnv(
  persistedEnv: Record<string, string | undefined> | undefined,
  agentId: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...process.env,
    ...persistedEnv,
  })) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.CLAUCTL_AGENT_ID = agentId;
  return env;
}

async function daemon(this: CommandContext, flags: DaemonFlags): Promise<void> {
  const { agentId } = flags;
  const agentDir = agentDirPath(agentId);
  // _daemon is a Node daemon and needs pid/signals/exit; Stricli's process type
  // intentionally only models portable stdio, so use Node's process here.
  const proc = this.process as NodeJS.Process;
  const log = (message: string): void => {
    proc.stdout.write(`[daemon] ${message}\n`);
  };
  const fail = (error: string): void => {
    proc.stderr.write(`[daemon] ${error}\n`);
    signalReady(flags.readyFd, { ok: false, error });
  };

  // Startup classification, from disk state alone: agent.json present →
  // revival (its recorded state wins over any stale spawn file — once it
  // exists, the first spawn got far enough that reviving from recorded state
  // is strictly safer than re-running the initial-spawn path); otherwise
  // spawn-options.json present → initial spawn; otherwise fail via ready-fd.
  const existing = await readAgentRecord(agentDir);
  if (existing.kind === "corrupt") {
    fail(`cannot revive: ${existing.error}`);
    return;
  }

  let record: AgentRecord;
  let resumeSessionId: string | undefined;
  if (existing.kind === "ok") {
    record = existing.record;
    record.daemonPid = proc.pid;
    // A crashed predecessor leaves stale attachment/tui-failure state behind.
    record.attachments = [];
    delete record.tuiFailedAt;
    resumeSessionId = record.sessions.at(-1)?.sessionId;
  } else {
    const spawnRead = await readSpawnOptions(agentDir);
    if (spawnRead.kind !== "ok") {
      fail(
        `cannot start: no agent.json and ${
          spawnRead.kind === "missing"
            ? "no spawn-options.json"
            : spawnRead.error
        }`,
      );
      return;
    }
    const spawnOptions = spawnRead.options;
    record = {
      id: agentId,
      createdAt: new Date().toISOString(),
      cwd: spawnOptions.cwd,
      ...(spawnOptions.tag !== undefined && { tag: spawnOptions.tag }),
      persistedOptions: spawnOptions.persistedOptions,
      sessions: [],
      daemonPid: proc.pid,
      attachments: [],
      agentDir,
    };
    resumeSessionId = spawnOptions.resume;
  }

  // agent.json writes are serialized through this chain; session and merge
  // events can arrive faster than a write completes.
  let writeQueue: Promise<void> = Promise.resolve();
  const queueRecordWrite = (): void => {
    writeQueue = writeQueue.then(
      () => writeAgentRecord(record),
      () => writeAgentRecord(record),
    );
  };

  // A SIGKILLed predecessor leaves stale socket files behind, and bind
  // refuses an existing path. Launchers guarantee no live daemon for this dir.
  await Promise.all([
    rm(sdkSocketPath(agentDir), { force: true }),
    rm(ttySocketPath(agentDir), { force: true }),
  ]);

  const options: Options = {
    ...record.persistedOptions,
    ...invariantOptions(),
    cwd: record.cwd,
    env: childEnv(record.persistedOptions.env, agentId),
    ...(resumeSessionId !== undefined && { resume: resumeSessionId }),
  };

  const turnQueue = new TurnQueue();
  const claudeQuery: Query = query({ prompt: turnQueue, options });

  await writeAgentRecord(record);
  // Unconditional delete after the first successful agent.json write: on
  // initial spawn this is the handoff cleanup, and on revival it removes a
  // stale file left by a daemon that died between the write and the delete.
  await rm(spawnOptionsPath(agentDir), { force: true });

  // daemon.log (stdout) carries only exceptional events;
  // the full event stream is observed via sdk.sock subscribers.
  const events = new EventBus();

  // Stream-observed state feeding the subscribe snapshot. Separate from the
  // persisted record: nothing here writes back to agent.json.
  // observedPermissionModes spans this daemon process only.
  const trackedState: {
    model?: string;
    permissionMode?: PermissionMode;
    observedPermissionModes: PermissionMode[];
    cwd: string;
    /** Uuid of the last user/assistant message emitted (StateSnapshot's attach boundary). */
    lastTranscriptUuid?: string;
  } = { observedPermissionModes: [], cwd: record.cwd };
  const observePermissionMode = (mode: PermissionMode): void => {
    trackedState.permissionMode = mode;
    if (!trackedState.observedPermissionModes.includes(mode)) {
      trackedState.observedPermissionModes.push(mode);
    }
  };

  // The modeled CLI queue (queue-model.ts). Only the two threading sites below
  // may advance it; the returned events are emitted immediately, keeping the
  // model and the emitted stream in lockstep.
  let queueModel: QueueModelState = INITIAL_QUEUE_MODEL_STATE;
  // Prompts handed to the CLI, not yet confirmed by a later stream emission.
  // With queuedMessages and lastTranscriptUuid this maintains StateSnapshot's
  // prompt-visibility invariant (sdk-socket.ts): a turn/append dequeue moves a
  // prompt from the modeled queue into this list, and the next user/assistant
  // emission moves it behind the attach boundary and clears the list.
  const deliveredPending: SDKUserMessage[] = [];
  const applyQueueTransition = (transition: QueueTransition): void => {
    deliveredPending.push(...deliveredMessages(queueModel, transition));
    queueModel = transition.state;
    for (const event of transition.events) {
      events.emit(event);
    }
  };

  // --- sdk.sock request handlers ---------------------------------------------
  // TDC: doesn't this logically belong in sdk-server.ts?
  const controlApplied = (record: SdkRequestRecord): void => {
    // The rest-over-a-union needs the cast; the payload is the request as
    // received, minus the transport id.
    const { id: _id, ...request } = record as SdkControlMutation & {
      id: string;
    };
    const mutation = request as SdkControlMutation;
    if (mutation.type === "set-model") {
      // undefined model → the SDK's default; tracked as unset.
      trackedState.model = mutation.model;
    } else if (mutation.type === "set-permission-mode") {
      observePermissionMode(mutation.mode);
    }
    events.emit({ kind: "controlApplied", request: mutation });
  };

  // Request dispatch is deliberately concurrent (a pending wait-idle must not
  // block the interrupt that would resolve it), so the mutation branch's
  // read-modify-write of record.persistedOptions — spanning awaits — would
  // lose updates if two mutations were in flight. Chaining restores the actor
  // property for mutations only; they never wait on daemon state, so the
  // chain cannot deadlock.
  let mutationChain: Promise<unknown> = Promise.resolve();

  // TDC: doesn't this logically belong in sdk-server.ts?
  const handleRequest = async (
    request: SdkRequestRecord,
    connection: SdkConnection,
  ): Promise<unknown> => {
    switch (request.type) {
      case "query": {
        const content = request.content;
        const trimmed = typeof content === "string" ? content.trim() : "";
        if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
          // Compaction is only valid while Idle; never queued behind turns.
          if (events.assistantState.activity !== "idle") {
            throw new Error("/compact requires an idle assistant");
          }
          const message: SDKUserMessage = {
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
          };
          turnQueue.push(message);
          events.emit({ kind: "compactSent", message });
          return undefined;
        }
        const message: SDKUserMessage = {
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          ...(request.priority !== undefined && { priority: request.priority }),
          ...(request.shouldQuery === false && { shouldQuery: false }),
        };
        turnQueue.push(message);
        applyQueueTransition(
          acceptUserMessage(queueModel, message, isBusy(events.assistantState)),
        );
        // The response makes no delivery claim: a demotable message's fate is
        // unknown at accept time, and blocking until the next boundary could
        // hang for minutes. The queued/dequeued events on the stream are the
        // truth.
        return undefined;
      }
      case "interrupt":
        await claudeQuery.interrupt();
        events.emit({ kind: "interruptSent" });
        return undefined;
      case "wait-idle":
        await events.whenIdle();
        return undefined;
      case "get-messages": {
        const sessionId = record.sessions.at(-1)?.sessionId;
        if (sessionId === undefined) {
          return [];
        }
        return await getSessionMessages(sessionId, { dir: record.cwd });
      }
      case "subscribe": {
        // Snapshot capture, response write, and sink attach happen in one
        // synchronous section, so the snapshot is exact: no event is lost or
        // duplicated between the response line and the first pushed event.
        // The generic respond path runs in a later microtask — an event
        // emitted in between would hit the wire before the response — so this
        // handler writes its own response and returns RESPONSE_SENT.
        const snapshot: StateSnapshot = {
          assistantState: events.assistantState,
          ...(record.sessions.at(-1) !== undefined && {
            sessionId: record.sessions.at(-1)!.sessionId,
          }),
          ...(trackedState.model !== undefined && {
            model: trackedState.model,
          }),
          ...(trackedState.permissionMode !== undefined && {
            permissionMode: trackedState.permissionMode,
          }),
          ...(trackedState.observedPermissionModes.length > 0 && {
            observedPermissionModes: [...trackedState.observedPermissionModes],
          }),
          cwd: trackedState.cwd,
          ...(queueModel.queued.length > 0 && {
            queuedMessages: queueModel.queued.map(({ id, message }) => ({
              id,
              message,
            })),
          }),
          ...(deliveredPending.length > 0 && {
            deliveredMessages: [...deliveredPending],
          }),
          ...(trackedState.lastTranscriptUuid !== undefined && {
            lastTranscriptUuid: trackedState.lastTranscriptUuid,
          }),
        };
        const response: SdkResponse = {
          id: request.id,
          ok: true,
          data: snapshot,
        };
        connection.write(`${JSON.stringify(response)}\n`);
        const unsubscribe = events.subscribe((line) => connection.write(line));
        connection.onClose(unsubscribe);
        return RESPONSE_SENT;
      }
    }
    // Everything else is the Query passthrough (DECISION-4), delegated to
    // sdk-passthrough.ts: mutations emit controlApplied and persist per
    // DECISION-5; reads emit nothing.
    if (isControlMutation(request)) {
      const run = async (): Promise<unknown> => {
        const data = await applyMutation(claudeQuery, request);
        controlApplied(request);
        const persisted = await persistedOptionsAfter(
          request,
          record.persistedOptions,
        );
        if (persisted !== undefined) {
          record.persistedOptions = persisted;
          queueRecordWrite();
        }
        return data;
      };
      // Run after the previous mutation regardless of its outcome; a failed
      // mutation rejects its own requester without poisoning the chain.
      const result = mutationChain.then(run, run);
      mutationChain = result.catch(() => undefined);
      return await result;
    }
    return await runRead(claudeQuery, request);
  };

  const sdkServer: Server = startSdkServer(
    sdkSocketPath(agentDir),
    handleRequest,
  );

  // --- teardown --------------------------------------------------------------
  // Constructed after sdk.sock is listening (the tui connects to it), so the
  // teardown closes over slots that are still unset on early failure paths.
  /* eslint-disable prefer-const -- assigned once post-listen, but read by cleanupAndExit above the assignment */
  let tuiHost: TuiHost | undefined;
  let ttyServer: TtyServer | undefined;
  /* eslint-enable prefer-const */
  let exiting = false;
  const cleanupAndExit = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    tuiHost?.shutdown();
    claudeQuery.close();
    turnQueue.close();
    // Wait for the stream to end before exiting: the SDK's close() SIGTERMs
    // claude with a SIGKILL escalation timer that dies with this process, so
    // exiting early could orphan a SIGTERM-ignoring child. The stream ends
    // when the child is gone.
    void Promise.allSettled([writeQueue, readerDone]).then(async () => {
      sdkServer.close();
      // Exit frames to attachers, bounded flush; suppresses detach hooks, so
      // the attachment clear below is final.
      await ttyServer?.shutdown(`agent shut down (code ${code})`);
      // Clean shutdown clears the attachment list; a crash leaves stale
      // entries, which readers must ignore for non-running agents. Queued
      // (not written directly) so it serializes behind in-flight writes.
      record.attachments = [];
      queueRecordWrite();
      await writeQueue.catch(() => undefined);
      await Promise.all([
        rm(sdkSocketPath(agentDir), { force: true }),
        rm(ttySocketPath(agentDir), { force: true }),
      ]);
      proc.exit(code);
    });
  };
  // Any termination request to the daemon means "shut the agent down".
  // query.close() SIGTERMs the claude subprocess with SIGKILL escalation.
  proc.on("SIGTERM", () => cleanupAndExit(0));
  proc.on("SIGINT", () => cleanupAndExit(0));

  // --- stream reader ---------------------------------------------------------
  // TDC: Does this section logically belong in another file? What is the responsibility of each file? It looks like this has to do with assistant state tracking and rebroadcasting events from the sdk.
  const handleMessage = (message: SDKMessage): void => {
    if (
      (message.type === "user" || message.type === "assistant") &&
      message.uuid !== undefined
    ) {
      // The uuid guard is for the type only: stream user/assistant messages
      // always carry the transcript uuid (verified in the CLI binary; the
      // optional uuid on SDKUserMessage is for host-pushed input).
      trackedState.lastTranscriptUuid = message.uuid;
      // A delivered prompt's transcript entry is written at consumption, and
      // entries land in file-append order, so every pending delivered prompt
      // precedes this message in the file (the prompt itself is never
      // re-emitted — this later message is the confirmation): once the
      // boundary is here, a history read covers them all. Clearing in the
      // same synchronous step as the boundary advance is what makes the
      // snapshot's exactly-once prompt-visibility invariant hold
      // (sdk-socket.ts).
      deliveredPending.length = 0;
    }
    if (message.type === "system" && message.subtype === "init") {
      handleSessionInit(message);
      trackedState.model = message.model;
      trackedState.cwd = message.cwd;
      observePermissionMode(message.permissionMode);
    } else if (
      message.type === "system" &&
      message.subtype === "status" &&
      message.permissionMode !== undefined
    ) {
      // Mode changes not initiated over sdk.sock (e.g. plan-mode transitions).
      observePermissionMode(message.permissionMode);
    }
    events.emit({ kind: "sdkMessage", message });
    // Dequeues follow their trigger: the model observes the message after its
    // own sdkMessage event is on the stream, so any userMessageDequeued it
    // implies lands immediately after.
    applyQueueTransition(observeSdkMessage(queueModel, message));
  };

  const handleSessionInit = (
    message: SDKMessage & { type: "system"; subtype: "init" },
  ): void => {
    record.claudeCodeVersion = message.claude_code_version;
    const currentSessionId = record.sessions.at(-1)?.sessionId;
    // An init fires every turn; a rollover is an init whose session_id
    // *differs*. The history is duplicate-free: re-announcing a known
    // session moves it to the end (most recent).
    if (message.session_id !== currentSessionId) {
      const previousIndex = record.sessions.findIndex(
        (s) => s.sessionId === message.session_id,
      );
      if (previousIndex !== -1) {
        record.sessions.splice(previousIndex, 1);
      }
      record.sessions.push({
        sessionId: message.session_id,
        sessionFile: sessionFilePath(record.cwd, message.session_id),
      });
      log(`session: ${message.session_id}`);
    }
    queueRecordWrite();
  };

  const readerDone = (async () => {
    for await (const message of claudeQuery) {
      handleMessage(message);
    }
  })();
  // Mark handled: the failure paths below exit without awaiting readerDone.
  void readerDone.catch(() => undefined);

  // Ready once sdk.sock is bound. The barrier cannot include the first
  // system/init: in streaming-input mode claude does not announce itself until
  // the first user turn arrives, so waiting for init deadlocks spawn (and
  // revival — the reviving CLI holds the turn that would trigger init).
  // Startup failures after this point surface in daemon.log.
  if (!sdkServer.listening) {
    try {
      await once(sdkServer, "listening");
    } catch (error) {
      fail(
        `cannot bind ${sdkSocketPath(agentDir)}: ${String(error)}; log: ${daemonLogPath(agentDir)}`,
      );
      cleanupAndExit(1);
      return;
    }
  }
  // --- tty.sock: the shared tui and its attach server -------------------------
  // Attach auditing never kills the daemon: failures are logged (stdout goes
  // to daemon.log) and otherwise ignored.
  // TDC: Can we put all this tui-management related stuff in a separate file?
  const auditAttachEvent = (
    event: "attach" | "detach",
    info: AttachmentInfo,
  ): void => {
    if (!auditEnabled(this.env)) {
      return;
    }
    const { source, manager } = resolveCallerSourceForPid(info.pid);
    const auditRecord = {
      ts: new Date().toISOString(),
      source,
      event,
      pid: info.pid,
    };
    void recordAuditEvent(agentDir, auditRecord, manager).catch((error) =>
      proc.stdout.write(`[daemon] ${event} audit failed: ${String(error)}\n`),
    );
  };

  // Hooks fire only once listen() succeeds, after both assignments below;
  // the non-null assertions record that ordering.
  ttyServer = new TtyServer({
    serializeScreen: () => tuiHost!.serializeScreen(),
    writeInput: (data) => tuiHost!.write(data),
    // The size itself is computed by TtyServer (min across attached clients).
    resize: (cols, rows) => tuiHost!.resize(cols, rows),
    onAttach: (info) => {
      // A new attacher wakes a failed tui host (retries the spawn).
      tuiHost!.notifyAttach();
      auditAttachEvent("attach", info);
    },
    onDetach: (info) => auditAttachEvent("detach", info),
    onAttachmentsChanged: (attachments) => {
      record.attachments = attachments;
      queueRecordWrite();
    },
  });
  // The tui connects to sdk.sock, which is listening by now.
  tuiHost = new TuiHost({
    sdkSocket: sdkSocketPath(agentDir),
    cwd: record.cwd,
    // No persisted SDK env: that is claude-subprocess configuration, not tui
    // configuration.
    env: childEnv(undefined, agentId),
    onOutput: (data) => ttyServer!.broadcastOutput(data),
    onFailedChanged: (failedAt) => {
      if (failedAt === undefined) {
        delete record.tuiFailedAt;
      } else {
        record.tuiFailedAt = failedAt;
      }
      queueRecordWrite();
    },
    log,
  });
  try {
    await ttyServer.listen(ttySocketPath(agentDir));
  } catch (error) {
    fail(
      `cannot bind ${ttySocketPath(agentDir)}: ${String(error)}; log: ${daemonLogPath(agentDir)}`,
    );
    cleanupAndExit(1);
    return;
  }

  signalReady(flags.readyFd, { ok: true });

  try {
    await readerDone;
    log("stream ended");
  } catch (error) {
    if (!exiting) {
      proc.stderr.write(`[daemon] stream failed: ${String(error)}\n`);
      cleanupAndExit(1);
      return;
    }
  }
  cleanupAndExit(0);
}

const daemonCommand = commandNoTarget<DaemonFlags>({
  docs: { brief: "Internal command to launch a single-agent claude daemon" },
  parameters: { flags: daemonFlags },
  func: daemon,
});

export const internalRoutes = {
  _daemon: daemonCommand,
} as const;
