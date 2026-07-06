/**
 * `clauctl _daemon` — the per-agent supervisor. One per agent. It owns the
 * single programmatic SDK connection (a long-lived streaming-input `query()`),
 * serves the minimal Phase-1 sdk.sock command channel, and is the sole writer
 * of agent.json.
 */

import { once } from "node:events";
import { closeSync, writeSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { numberParser } from "@stricli/core";
import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import {
  INITIAL_ASSISTANT_STATE,
  isBusy,
  nextAssistantState,
  type AssistantState,
} from "./assistant-state.ts";
import {
  acceptUserMessage,
  INITIAL_QUEUE_MODEL_STATE,
  observeSdkMessage,
  type QueueModelState,
  type QueueTransition,
} from "./queue-model.ts";
import {
  commandNoTarget,
  parsedFlag,
  requiredStringFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { invariantOptions } from "./options.ts";
import {
  agentDirPath,
  daemonLogPath,
  readAgentRecord,
  readSpawnOptions,
  sdkSocketPath,
  spawnOptionsPath,
  writeAgentRecord,
  type AgentRecord,
} from "./registry.ts";
import {
  SDK_SOCKET_PROTOCOL,
  SDK_SOCKET_VERSION,
  type SdkControlMutation,
  type SdkEvent,
  type SdkRequestRecord,
  type SdkResponse,
  type StateSnapshot,
} from "./sdk-socket.ts";
import { type CommandContext } from "./generated/targets.ts";

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
 * The held-open input iterable behind `query({ prompt })`: turns pushed by
 * sdk.sock clients (and, until Phase 2, only by the daemon's own handlers) are
 * yielded to the SDK as they arrive; close() ends the stream.
 */
class TurnQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(message: SDKUserMessage): void {
    this.pending.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.pending.length > 0) {
        yield this.pending.shift()!;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * The daemon's single mutation path for observable assistant state. `emit`
 * atomically serializes the event to every subscribed sink and folds it into
 * the state tracker, so state is a function of the emitted stream by
 * construction — an observer holding a StateSnapshot can always reconstruct
 * it by running the same fold. Nothing outside this class may update the
 * tracker: request handlers and the stream reader only have `emit`, making an
 * applied-but-never-emitted event unrepresentable.
 *
 * Events emitted while no subscriber is connected are observable only through
 * their effects (state snapshot, agent.json, session JSONL).
 */
class EventBus {
  private state: AssistantState = INITIAL_ASSISTANT_STATE;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly sinks = new Set<(serializedEventRecord: string) => void>();

  get assistantState(): AssistantState {
    return this.state;
  }

  /** Attach a subscriber sink; returns the unsubscribe function. */
  subscribe(sink: (serializedEventRecord: string) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  emit(event: SdkEvent): void {
    // Serialized once as an SdkEventRecord line, written to every sink.
    const line = `${JSON.stringify({ event })}\n`;
    for (const sink of this.sinks) {
      sink(line);
    }
    this.state = nextAssistantState(this.state, event);
    if (this.state.activity === "idle") {
      for (const waiter of this.idleWaiters.splice(0)) {
        waiter();
      }
    }
  }

  /** Resolves once the assistant is Idle (immediately if it already is). */
  whenIdle(): Promise<void> {
    if (this.state.activity === "idle") {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

/**
 * Returned by a handler that wrote its own response (subscribe): the generic
 * respond path runs in a later microtask, and an event emitted in that window
 * would hit the wire before the response line.
 */
const RESPONSE_SENT: unique symbol = Symbol("response sent");

/** Per-connection handle so subscribe can attach a sink and unhook it on close. */
interface SdkConnection {
  write(line: string): void;
  onClose(cleanup: () => void): void;
}

/**
 * DECISION-5 cumulative shallow-merge for apply-flag-settings: `null` clears a
 * key, everything else replaces it. If the persisted settings is a path string
 * (spawned via `--settings <file>`), the first apply reads and parses that
 * file, then merges; from then on the merged object is what persists.
 */
async function mergeFlagSettings(
  current: Options["settings"],
  applied: { [K in keyof Settings]?: Settings[K] | null },
): Promise<Settings> {
  const base: Record<string, unknown> =
    typeof current === "string"
      ? (JSON.parse(await readFile(current, "utf8")) as Record<string, unknown>)
      : { ...current };
  for (const [key, value] of Object.entries(applied)) {
    if (value === null) {
      delete base[key];
    } else if (value !== undefined) {
      base[key] = value;
    }
  }
  return base as Settings;
}

/**
 * Where claude persists the session transcript: config dir + the project key
 * (cwd with every non-alphanumeric character replaced by '-'). Recorded for
 * Phase-3 tail; nothing in Phase 1 reads it back.
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

  // A SIGKILLed predecessor leaves a stale socket file behind, and bind
  // refuses an existing path. Launchers guarantee no live daemon for this dir.
  await rm(sdkSocketPath(agentDir), { force: true });

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

  // The modeled CLI queue (queue-model.ts). Only the two threading sites below
  // may advance it; the returned events are emitted immediately, keeping the
  // model and the emitted stream in lockstep.
  let queueModel: QueueModelState = INITIAL_QUEUE_MODEL_STATE;
  const applyQueueTransition = (transition: QueueTransition): void => {
    queueModel = transition.state;
    for (const event of transition.events) {
      events.emit(event);
    }
  };

  // --- sdk.sock request handlers ---------------------------------------------
  const controlApplied = (record: SdkRequestRecord): void => {
    // The rest-over-a-union needs the cast; the payload is the request as
    // received, minus the transport id.
    const { id: _id, ...request } = record as SdkControlMutation & {
      id: string;
    };
    events.emit({
      kind: "controlApplied",
      request: request as SdkControlMutation,
    });
  };

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
        };
        const response: SdkResponse = {
          id: request.id,
          ok: true,
          data: snapshot,
        };
        connection.write(`${JSON.stringify(response)}\n`);
        // TDC: why is this only done onClose? Don't we want to subscribe to events immediately?
        connection.onClose(events.subscribe((line) => connection.write(line)));
        return RESPONSE_SENT;
      }

      // --- Query mutations (DECISION-4 passthrough; DECISION-5 persistence) --
      case "set-model":
        await claudeQuery.setModel(request.model);
        controlApplied(request);
        // DECISION-5 persist-on-mutation: record the args of every
        // state-mutating control call as it is made; never read back.
        record.persistedOptions.model = request.model;
        queueRecordWrite();
        return undefined;
      case "set-permission-mode":
        await claudeQuery.setPermissionMode(request.mode);
        controlApplied(request);
        record.persistedOptions.permissionMode = request.mode;
        if (request.mode === "bypassPermissions") {
          // Entering bypass requires the spawn-time dangerous-skip flag; a
          // session that entered it once keeps the capability across respawn.
          record.persistedOptions.allowDangerouslySkipPermissions = true;
        }
        queueRecordWrite();
        return undefined;
      case "set-mcp-permission-mode-override": {
        const data = await claudeQuery.setMcpPermissionModeOverride(
          request.serverName,
          request.mode,
        );
        controlApplied(request);
        return data;
      }
      case "set-max-thinking-tokens":
        // Deprecated SDK-side, but kept: the only runtime thinking control
        // (the `thinking` option is spawn-time only).
        await claudeQuery.setMaxThinkingTokens(
          request.maxThinkingTokens,
          request.thinkingDisplay,
        );
        controlApplied(request);
        // thinkingDisplay has no Options home; accepted as lost across respawn.
        if (request.maxThinkingTokens === null) {
          delete record.persistedOptions.maxThinkingTokens;
        } else {
          record.persistedOptions.maxThinkingTokens = request.maxThinkingTokens;
        }
        queueRecordWrite();
        return undefined;
      case "apply-flag-settings": {
        await claudeQuery.applyFlagSettings(request.settings);
        controlApplied(request);
        record.persistedOptions.settings = await mergeFlagSettings(
          record.persistedOptions.settings,
          request.settings,
        );
        queueRecordWrite();
        return undefined;
      }
      case "set-mcp-servers": {
        const data = await claudeQuery.setMcpServers(request.servers);
        controlApplied(request);
        // All entries arrived over JSON, so all are serializable by
        // construction (in-process SdkMcpServer entries cannot reach here).
        record.persistedOptions.mcpServers = request.servers;
        queueRecordWrite();
        return data;
      }
      case "toggle-mcp-server":
        await claudeQuery.toggleMcpServer(request.serverName, request.enabled);
        controlApplied(request);
        return undefined;
      case "reconnect-mcp-server":
        await claudeQuery.reconnectMcpServer(request.serverName);
        controlApplied(request);
        return undefined;
      case "stop-task":
        await claudeQuery.stopTask(request.taskId);
        controlApplied(request);
        return undefined;
      case "background-tasks": {
        const data = await claudeQuery.backgroundTasks(request.toolUseId);
        controlApplied(request);
        return data;
      }
      case "rewind-files": {
        const data = await claudeQuery.rewindFiles(request.userMessageId, {
          ...(request.dryRun !== undefined && { dryRun: request.dryRun }),
        });
        controlApplied(request);
        return data;
      }
      case "seed-read-state":
        await claudeQuery.seedReadState(request.path, request.mtime);
        controlApplied(request);
        return undefined;
      case "reload-plugins": {
        const data = await claudeQuery.reloadPlugins();
        controlApplied(request);
        return data;
      }
      case "reload-skills": {
        const data = await claudeQuery.reloadSkills();
        controlApplied(request);
        return data;
      }

      // --- Query reads (no controlApplied; reads emit nothing) --------------
      case "initialization-result":
        return await claudeQuery.initializationResult();
      case "supported-commands":
        return await claudeQuery.supportedCommands();
      case "supported-models":
        return await claudeQuery.supportedModels();
      case "supported-agents":
        return await claudeQuery.supportedAgents();
      case "mcp-server-status":
        return await claudeQuery.mcpServerStatus();
      case "get-context-usage":
        return await claudeQuery.getContextUsage();
      case "usage":
        // Stable alias for the experimental method; rename here when the SDK
        // stabilizes it.
        return await claudeQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      case "account-info":
        return await claudeQuery.accountInfo();
      case "read-file":
        return await claudeQuery.readFile(request.path, {
          ...(request.maxBytes !== undefined && { maxBytes: request.maxBytes }),
          ...(request.encoding !== undefined && { encoding: request.encoding }),
        });
      // Coverage invariant (DECISION-4): every Query method is reachable above
      // except close (the daemon's teardown owns the connection lifecycle),
      // streamInput (the daemon's TurnQueue IS the input stream), and
      // reinitialize (a transport-gap recovery tool for ring-buffer clients;
      // the daemon never has a transport gap with its own SDK).
    }
  };

  const sdkServer: Server = startSdkServer(
    sdkSocketPath(agentDir),
    handleRequest,
  );

  // --- teardown --------------------------------------------------------------
  let exiting = false;
  const cleanupAndExit = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    claudeQuery.close();
    turnQueue.close();
    // Wait for the stream to end before exiting: the SDK's close() SIGTERMs
    // claude with a SIGKILL escalation timer that dies with this process, so
    // exiting early could orphan a SIGTERM-ignoring child. The stream ends
    // when the child is gone.
    void Promise.allSettled([writeQueue, readerDone]).then(async () => {
      sdkServer.close();
      await rm(sdkSocketPath(agentDir), { force: true });
      proc.exit(code);
    });
  };
  // Any termination request to the daemon means "shut the agent down".
  // query.close() SIGTERMs the claude subprocess with SIGKILL escalation.
  proc.on("SIGTERM", () => cleanupAndExit(0));
  proc.on("SIGINT", () => cleanupAndExit(0));

  // --- stream reader ---------------------------------------------------------
  const handleMessage = (message: SDKMessage): void => {
    if (message.type === "system" && message.subtype === "init") {
      handleSessionInit(message);
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

/**
 * JSONL server on sdk.sock; hello on connect. Requests get responses; a
 * subscribed connection additionally receives pushed SdkEventRecord lines
 * (written by the EventBus sink the subscribe handler attaches). Sinks are
 * fire-and-forget socket writes: a slow subscriber buffers in its socket,
 * never blocks the daemon or other clients.
 */
function startSdkServer(
  socketPath: string,
  handleRequest: (
    request: SdkRequestRecord,
    connection: SdkConnection,
  ) => Promise<unknown>,
): Server {
  const server = createServer((socket: Socket) => {
    socket.on("error", () => socket.destroy());
    socket.write(
      `${JSON.stringify({
        type: "hello",
        protocol: SDK_SOCKET_PROTOCOL,
        version: SDK_SOCKET_VERSION,
      })}\n`,
    );
    const connection: SdkConnection = {
      write: (line) => {
        if (!socket.destroyed) {
          socket.write(line);
        }
      },
      onClose: (cleanup) => {
        socket.on("close", cleanup);
      },
    };
    const respond = (response: SdkResponse): void => {
      connection.write(`${JSON.stringify(response)}\n`);
    };
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() !== "") {
          let request: SdkRequestRecord;
          try {
            request = JSON.parse(line) as SdkRequestRecord;
          } catch {
            continue;
          }
          void handleRequest(request, connection).then(
            (data) => {
              if (data !== RESPONSE_SENT) {
                respond({
                  id: request.id,
                  ok: true,
                  ...(data !== undefined && { data }),
                });
              }
            },
            (error: unknown) =>
              respond({
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });
  server.listen(socketPath);
  return server;
}

const daemonCommand = commandNoTarget<DaemonFlags>({
  docs: { brief: "Internal command to launch a single-agent claude daemon" },
  parameters: { flags: daemonFlags },
  func: daemon,
});

export const internalRoutes = {
  _daemon: daemonCommand,
} as const;
