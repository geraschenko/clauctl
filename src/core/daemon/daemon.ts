/**
 * `clauctl _daemon` — the per-agent supervisor's composition root. One per
 * agent. It classifies startup (spawn vs revival), owns the AgentRecord and
 * its serialized writes, starts the SDK connection (a long-lived
 * streaming-input `query()`), wires the modules together — EventHub (state),
 * request handler (semantics), sdk-server (transport), tty-service (shared
 * tui) — and handles teardown and signals. It deliberately contains no
 * request semantics, no state tracking, and no tui management; only the
 * stream read loop stays (see its section comment).
 */

import { once } from "node:events";
import { closeSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { type Server } from "node:net";
import { join } from "node:path";
import { numberParser } from "@stricli/core";
import {
  query,
  type Options,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { auditEnabled } from "../generated/audit.ts";
import {
  commandNoTarget,
  parsedFlag,
  requiredStringFlag,
  type InferFlags,
} from "../generated/cli.ts";
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
import { type CommandContext } from "../generated/targets.ts";
import { EventHub } from "./event-hub.ts";
import { createRequestHandler } from "./request-handlers.ts";
import { startSdkServer } from "./sdk-server.ts";
import { startTtyService, type TtyService } from "./tty-service.ts";
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
  env.CLAUCTL_ID = agentId;
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
  // Observable state (agent-state.ts) is folded by the hub; it is separate
  // from the persisted record — nothing here writes back to agent.json.
  const events = new EventHub({
    seed: {
      cwd: record.cwd,
      sessionId: record.sessions.at(-1)?.sessionId,
    },
    deliver: (message) => turnQueue.push(message),
  });

  const sdkServer: Server = startSdkServer(
    sdkSocketPath(agentDir),
    createRequestHandler({
      claudeQuery,
      events,
      turnQueue,
      cwd: record.cwd,
      getPersistedOptions: () => record.persistedOptions,
      setPersistedOptions: (options) => {
        record.persistedOptions = options;
        queueRecordWrite();
      },
    }),
  );

  // --- teardown --------------------------------------------------------------
  // Started after sdk.sock is listening (the tui connects to it), so the
  // teardown closes over a slot that is still unset on early failure paths.
  let ttyService: TtyService | undefined;
  let exiting = false;
  const cleanupAndExit = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    ttyService?.stopTui();
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
      await ttyService?.shutdown(`agent shut down (code ${code})`);
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
  // What remains of the reader is record bookkeeping plus a trivial loop, and
  // it stays here deliberately — it is the record owner's code, not a module
  // of its own. State tracking lives in the hub's fold (agent-state.ts).
  const handleMessage = (message: SDKMessage): void => {
    // Record bookkeeping before the fold: by the time the init event reaches
    // any observer, the record (and its queued agent.json write) already
    // reflects the new session.
    if (message.type === "system" && message.subtype === "init") {
      handleSessionInit(message);
    }
    events.observeSdkMessage(message);
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
  // The tui connects to sdk.sock, which is listening by now.
  try {
    ttyService = await startTtyService({
      agentDir,
      cwd: record.cwd,
      // No persisted SDK env: that is claude-subprocess configuration, not
      // tui configuration.
      env: childEnv(undefined, agentId),
      sdkSocket: sdkSocketPath(agentDir),
      auditEnabled: auditEnabled(this.env),
      onAttachmentsChanged: (attachments) => {
        record.attachments = attachments;
        queueRecordWrite();
      },
      onTuiFailedChanged: (failedAt) => {
        if (failedAt === undefined) {
          delete record.tuiFailedAt;
        } else {
          record.tuiFailedAt = failedAt;
        }
        queueRecordWrite();
      },
      log,
    });
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
