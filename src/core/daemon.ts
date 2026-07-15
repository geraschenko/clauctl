/**
 * `clauctl _daemon` — the per-agent supervisor. One per agent. It owns the
 * single programmatic SDK connection (a long-lived streaming-input `query()`),
 * serves the minimal Phase-1 sdk.sock command channel, and is the sole writer
 * of agent.json.
 */

import { once } from "node:events";
import { closeSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer, type Server, type Socket } from "node:net";
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
import {
  INITIAL_ASSISTANT_STATE,
  isBusy,
  nextAssistantState,
  type AssistantState,
} from "./assistant-state.ts";
import {
  acceptUserMessage,
  deliveredMessages,
  INITIAL_QUEUE_MODEL_STATE,
  observeSdkMessage,
  type QueueModelState,
  type QueueTransition,
} from "./queue-model.ts";
import { CURSOR_HOME, ERASE_SCREEN } from "./generated/ansi.ts";
import {
  auditEnabled,
  recordAuditEvent,
  resolveCallerSourceForPid,
} from "./generated/audit.ts";
import {
  commandNoTarget,
  parsedFlag,
  requiredStringFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { PtyScreen } from "./generated/pty-screen.ts";
import { TtyServer, type AttachmentInfo } from "./generated/tty-server.ts";
import { mainEntryPath } from "./main-entry-path.ts";
import { invariantOptions } from "./options.ts";
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
} from "./registry.ts";
import {
  applyMutation,
  isControlMutation,
  persistedOptionsAfter,
  runRead,
} from "./sdk-passthrough.ts";
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
 * sdk.sock clients are yielded to the SDK as they arrive; close() ends the
 * stream.
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

export const RAPID_EXIT_MS = 5_000;
export const MAX_CONSECUTIVE_RAPID_EXITS = 3;

/**
 * Fold one tui exit into the respawn decision. A "rapid" exit is one within
 * RAPID_EXIT_MS of its spawn; MAX_CONSECUTIVE_RAPID_EXITS of them in a row
 * means the tui is broken — stop respawning instead of crash-looping.
 */
export function nextRespawnState(
  consecutiveRapidExits: number,
  spawnedAtMs: number,
  exitedAtMs: number,
): { consecutiveRapidExits: number; respawn: boolean } {
  const next =
    exitedAtMs - spawnedAtMs < RAPID_EXIT_MS ? consecutiveRapidExits + 1 : 0;
  return {
    consecutiveRapidExits: next,
    // TDC: if respawn is a derivable from consecutiveRapidExits, why include it as a field rather than making it a method?
    respawn: next < MAX_CONSECUTIVE_RAPID_EXITS,
  };
}

// TDC: this file is getting pretty big and gnarly. Let's make a daemon subdirectory which contains separate files for the logical units of the daemon.
interface TuiHostOptions {
  sdkSocket: string;
  cwd: string;
  env: Record<string, string>;
  /** Wired to ttyServer.broadcastOutput. */
  onOutput: (data: string) => void;
  /** Called with a timestamp when respawning stops, and with undefined
   *  whenever a respawn is attempted (the failure is cleared at the attempt,
   *  not on survival — if the tui crash-loops again the field briefly flaps,
   *  which self-corrects within the rapid-exit window). */
  onFailedChanged: (failedAt: string | undefined) => void;
  log: (message: string) => void;
}

/**
 * Runs `clauctl _tui --managed` in a PtyScreen (generated/pty-screen.ts);
 * respawns on exit per nextRespawnState. Each (re)spawn is a fresh PtyScreen;
 * the last one is kept after exit so its screen — including crash output —
 * remains snapshotable while the tui is failed.
 */
class TuiHost {
  private readonly opts: TuiHostOptions;
  private screen!: PtyScreen;
  private spawnedAtMs = 0;
  private consecutiveRapidExits = 0;
  private tuiExited = false;
  private failed = false;
  private shuttingDown = false;
  /** Last size applied via resize(), re-applied to every fresh PtyScreen:
   *  TtyServer only calls the resize hook when the min across attachers
   *  *changes*, so without this a respawned tui would stay at the pty
   *  default while the attachers keep their old geometry. */
  private lastSize: { cols: number; rows: number } | undefined;

  constructor(opts: TuiHostOptions) {
    this.opts = opts;
    this.spawnTui();
  }

  private spawnTui(): void {
    this.spawnedAtMs = Date.now();
    this.tuiExited = false;
    this.screen = new PtyScreen(
      process.execPath,
      [
        mainEntryPath(),
        "_tui",
        "--sdk-socket",
        this.opts.sdkSocket,
        "--managed",
      ],
      { cwd: this.opts.cwd, env: this.opts.env },
    );
    // Listener registration must stay synchronous with construction (no await
    // in between): PtyScreen holds a single listener slot per event, and pty
    // data arriving in an await gap would bypass the broadcast.
    this.screen.onData(this.opts.onOutput);
    this.screen.onExit((exitCode) => this.handleExit(exitCode));
    if (this.lastSize !== undefined) {
      this.screen.resize(this.lastSize.cols, this.lastSize.rows);
    }
  }

  private respawn(): void {
    this.failed = false;
    this.opts.onFailedChanged(undefined);
    // The fresh emulator starts blank; clearing the attachers' screens first
    // keeps them in lockstep with it.
    this.opts.onOutput(`${CURSOR_HOME}${ERASE_SCREEN}`);
    this.spawnTui();
  }

  private handleExit(exitCode: number): void {
    this.tuiExited = true;
    if (this.shuttingDown) {
      return;
    }
    this.opts.log(`tui exited with code ${exitCode}`);
    const next = nextRespawnState(
      this.consecutiveRapidExits,
      this.spawnedAtMs,
      Date.now(),
    );
    this.consecutiveRapidExits = next.consecutiveRapidExits;
    if (next.respawn) {
      this.respawn();
    } else {
      this.failed = true;
      this.opts.log(
        `tui exited rapidly ${next.consecutiveRapidExits} times in a row; ` +
          `not respawning until the next attach`,
      );
      this.opts.onFailedChanged(new Date().toISOString());
    }
  }

  // write/resize are dropped after tui exit: the pty fd is gone, and the
  // frozen crash screen has nothing to receive them. serializeScreen stays
  // valid — PtyScreen's emulator survives process exit.
  write(data: string): void {
    if (!this.tuiExited) {
      this.screen.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    this.lastSize = { cols, rows };
    if (!this.tuiExited) {
      this.screen.resize(cols, rows);
    }
  }

  serializeScreen(): Promise<string> {
    return this.screen.serializeScreen();
  }

  /** Wakes a failed host: resets the crash counter and respawns. No-op while
   *  the tui is running. */
  notifyAttach(): void {
    if (!this.failed || this.shuttingDown) {
      return;
    }
    this.consecutiveRapidExits = 0;
    this.respawn();
  }

  /** Stop respawning and SIGTERM the current pty (daemon shutdown). */
  shutdown(): void {
    this.shuttingDown = true;
    if (!this.tuiExited) {
      this.screen.kill("SIGTERM");
    }
  }
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
