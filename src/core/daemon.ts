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
} from "@anthropic-ai/claude-agent-sdk";
import {
  INITIAL_ASSISTANT_STATE,
  nextAssistantState,
  type AssistantState,
  type SdkEvent,
} from "./assistant-state.ts";
import {
  booleanFlag,
  commandNoTarget,
  parsedFlag,
  requiredStringFlag,
  stringFlag,
  type InferFlags,
} from "./cli.ts";
import { invariantOptions, type SpawnOptionsFile } from "./options.ts";
import {
  daemonLogPath,
  readAgentRecord,
  sdkSocketPath,
  spawnOptionsPath,
  writeAgentRecord,
  type AgentRecord,
} from "./registry.ts";
import {
  SDK_SOCKET_PROTOCOL,
  SDK_SOCKET_VERSION,
  type SdkRequestRecord,
  type SdkResponse,
} from "./sdk-socket.ts";
import { type CommandContext } from "./targets.ts";

const daemonFlags = {
  agentDir: requiredStringFlag("Agent directory", "path"),
  agentId: requiredStringFlag("Agent id", "uuid"),
  cwd: requiredStringFlag("Working directory", "path"),
  resume: booleanFlag("Revive from agent.json, resuming the last session"),
  tag: stringFlag("Tag", "str"),
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
  const { agentDir, agentId } = flags;
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

  const existing = await readAgentRecord(agentDir);

  // Initial spawn reads the transient handoff from `spawn`; revival reads the
  // merged persistedOptions the previous daemon left in agent.json.
  let spawnOptions: SpawnOptionsFile;
  if (flags.resume) {
    if (existing.kind !== "ok") {
      fail(
        `cannot revive: ${existing.kind === "missing" ? "no agent.json" : existing.error}`,
      );
      return;
    }
    const lastSession = existing.record.sessions.at(-1);
    spawnOptions = {
      persistedOptions: existing.record.persistedOptions,
      ...(lastSession !== undefined && { resume: lastSession.sessionId }),
    };
  } else {
    try {
      spawnOptions = JSON.parse(
        await readFile(spawnOptionsPath(agentDir), "utf8"),
      ) as SpawnOptionsFile;
    } catch (error) {
      fail(`cannot read spawn-options.json: ${String(error)}`);
      return;
    }
  }

  const record: AgentRecord = {
    id: agentId,
    createdAt:
      existing.kind === "ok"
        ? existing.record.createdAt
        : new Date().toISOString(),
    cwd: flags.cwd,
    // First spawn carries --tag; revival preserves whatever was recorded.
    ...(existing.kind === "ok"
      ? existing.record.tag !== undefined && { tag: existing.record.tag }
      : flags.tag !== undefined && { tag: flags.tag }),
    persistedOptions: spawnOptions.persistedOptions,
    sessions: existing.kind === "ok" ? existing.record.sessions : [],
    daemonPid: proc.pid,
    claudeCodeVersion:
      existing.kind === "ok" ? existing.record.claudeCodeVersion : undefined,
    agentDir,
  };

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
    cwd: flags.cwd,
    env: childEnv(record.persistedOptions.env, agentId),
    ...(spawnOptions.resume !== undefined && { resume: spawnOptions.resume }),
  };

  const turnQueue = new TurnQueue();
  // TDC: don't use one-letter variable names for long-lived objects. Call this something like claudeQuery, claude, or claudeClient.
  const q: Query = query({ prompt: turnQueue, options });

  await writeAgentRecord(record);
  if (!flags.resume) {
    await rm(spawnOptionsPath(agentDir), { force: true });
  }

  // --- assistant-state tracking ---------------------------------------------
  let assistantState: AssistantState = INITIAL_ASSISTANT_STATE;
  const idleWaiters: Array<() => void> = [];
  const applyEvent = (event: SdkEvent): void => {
    const before = assistantState;
    assistantState = nextAssistantState(assistantState, event);
    if (
      before.activity !== assistantState.activity ||
      before.queueDepth !== assistantState.queueDepth
    ) {
      // TDC: isn't this going to be super noisy? It's emitting a message for every assistant state change. Are we logging the daemon output to a file anywhere, or is this process completely detached?
      log(
        `assistant: ${assistantState.activity} (queueDepth ${assistantState.queueDepth})`,
      );
    }
    if (assistantState.activity === "idle") {
      for (const waiter of idleWaiters.splice(0)) {
        waiter();
      }
    }
  };
  const whenIdle = (): Promise<void> => {
    if (assistantState.activity === "idle") {
      return Promise.resolve();
    }
    return new Promise((resolve) => idleWaiters.push(resolve));
  };

  // --- sdk.sock request handlers ---------------------------------------------
  const handleRequest = async (request: SdkRequestRecord): Promise<unknown> => {
    switch (request.type) {
      case "query": {
        const text = request.text;
        const trimmed = text.trim();
        if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
          // Compaction is only valid while Idle; never queued behind turns.
          if (assistantState.activity !== "idle") {
            throw new Error("/compact requires an idle assistant");
          }
          turnQueue.push({
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
          });
          // TDC: This is a problem. You cannot apply an event that's never sent. The assistant state must be a function of the event stream observed by *all* clients. This makes it so that assistant state can change in a way that only the sender of "/compact" is aware of. It's bad. Present a plan to me for how you're going to address this. I don't want just a point fix. I want it to be structurally impossible to make this kind of mistake in the future.
          applyEvent({ kind: "compactSent" });
          return undefined;
        }
        turnQueue.push({
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
          ...(request.priority !== undefined && { priority: request.priority }),
        });
        // 'next' and default behave identically for state tracking: they run
        // only when idle and are merged into a running turn otherwise.
        // TDC: same issue here and in all the cases below.
        applyEvent({
          kind: "turnAccepted",
          ...(request.priority === "now" || request.priority === "later"
            ? { priority: request.priority }
            : {}),
        });
        return undefined;
      }
      case "interrupt":
        await q.interrupt();
        applyEvent({ kind: "interruptSent" });
        return undefined;
      case "set-model":
        await q.setModel(request.model);
        // DECISION-5 persist-on-mutation: record the args of every
        // state-mutating control call as it is made; never read back.
        record.persistedOptions.model = request.model;
        queueRecordWrite();
        return undefined;
      case "set-permission-mode":
        await q.setPermissionMode(request.mode);
        record.persistedOptions.permissionMode = request.mode;
        if (request.mode === "bypassPermissions") {
          // Entering bypass requires the spawn-time dangerous-skip flag; a
          // session that entered it once keeps the capability across respawn.
          record.persistedOptions.allowDangerouslySkipPermissions = true;
        }
        queueRecordWrite();
        return undefined;
      case "wait-idle":
        await whenIdle();
        return undefined;
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
    q.close();
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
    // The raw stream is the Phase-1 observation channel (daemon.log).
    proc.stdout.write(`${JSON.stringify(message)}\n`);
    if (message.type === "system" && message.subtype === "init") {
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
    }
    applyEvent({ kind: "sdkMessage", message });
  };

  const readerDone = (async () => {
    for await (const message of q) {
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

/** JSONL request/response server on sdk.sock; hello on connect. */
function startSdkServer(
  socketPath: string,
  handleRequest: (request: SdkRequestRecord) => Promise<unknown>,
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
    const respond = (response: SdkResponse): void => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(response)}\n`);
      }
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
          void handleRequest(request).then(
            (data) =>
              respond({
                id: request.id,
                ok: true,
                ...(data !== undefined && { data }),
              }),
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
