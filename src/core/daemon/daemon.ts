/**
 * `clauctl _daemon` — the per-agent supervisor's composition root. One per
 * agent. It classifies startup (spawn vs revival), owns the AgentRecord and
 * its serialized writes, starts the SDK connection (a long-lived
 * streaming-input `query()`), wires the modules together — EventHub (state),
 * request handler (semantics), sdk-server (transport) — and handles teardown
 * and signals. It deliberately contains no request semantics and no state
 * tracking; only the stream read loop stays (see its section comment).
 */

import type { UUID } from "node:crypto";
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
import { auditAttachEvent, auditEnabled } from "../generated/audit.ts";
import {
  commandNoTarget,
  parsedFlag,
  requiredStringFlag,
  type InferFlags,
} from "../generated/cli.ts";
import { initialAgentState } from "../agent-state.ts";
import { invariantOptions, settingsSeed } from "../options.ts";
import {
  agentDirPath,
  daemonLogPath,
  readAgentRecord,
  readSpawnOptions,
  sdkSocketPath,
  spawnOptionsPath,
  writeAgentRecord,
  type AgentRecord,
  type AttachmentInfo,
} from "../registry.ts";
import { sessionFilePath } from "../session/file.ts";
import { type CommandContext } from "../generated/targets.ts";
import { AnomalyRecorder } from "./anomaly-bundle.ts";
import { EventHub } from "./event-hub.ts";
import { createRequestHandler } from "./request-handlers.ts";
import { RwGate } from "./rw-gate.ts";
import { startSdkServer } from "./sdk-server.ts";
import { TrackedSessionLog } from "./tracked-session-log.ts";
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
    // A crashed predecessor leaves stale attachment state behind.
    record.attachments = [];
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

  // A SIGKILLed predecessor leaves a stale socket file behind, and bind
  // refuses an existing path. Launchers guarantee no live daemon for this dir.
  await rm(sdkSocketPath(agentDir), { force: true });

  // The transcript lives where the CLI child looks for it: CLAUDE_CONFIG_DIR
  // from the child's env (persisted env can override ours), else ~/.claude.
  const configDir =
    childEnv(record.persistedOptions.env, agentId).CLAUDE_CONFIG_DIR ??
    join(homedir(), ".claude");

  // The AgentState seed's settings tier: what the NEXT query would use, for
  // observers of a cold agent (init is only authoritative once a child
  // spawns). Model and effort are display prediction only — the child
  // resolves its own cascade. Permission mode is also forwarded to the
  // child: the SDK spawns `--permission-mode default` whenever
  // permissionMode is unset (its `resolvePermissionModeInCli` switch is
  // private), which would override permissions.defaultMode from every
  // settings file. tests/sdk/permission-mode.test.ts asserts both that
  // the SDK still forces the flag and that the explicit value reaches the
  // CLI; while the former passes, this merge stays.
  const settings = await settingsSeed(record.persistedOptions, record.cwd);

  const buildOptions = (resume: string | undefined): Options => ({
    ...record.persistedOptions,
    ...(record.persistedOptions.permissionMode === undefined &&
      settings.permissionMode !== undefined && {
        permissionMode: settings.permissionMode,
      }),
    ...invariantOptions(),
    cwd: record.cwd,
    env: childEnv(record.persistedOptions.env, agentId),
    ...(resume !== undefined && { resume }),
  });

  // The Query and its TurnQueue are replaced by set-context (restartQuery
  // below), so both are mutable slots; closures over them always see the
  // current instance.
  let turnQueue = new TurnQueue();
  let claudeQuery: Query = query({
    prompt: turnQueue,
    options: buildOptions(resumeSessionId),
  });

  await writeAgentRecord(record);
  // Unconditional delete after the first successful agent.json write: on
  // initial spawn this is the handoff cleanup, and on revival it removes a
  // stale file left by a daemon that died between the write and the delete.
  await rm(spawnOptionsPath(agentDir), { force: true });

  // daemon.log (stdout) carries only exceptional events;
  // the full event stream is observed via sdk.sock subscribers.
  // Observable state (agent-state.ts) is folded by the hub; it is separate
  // from the persisted record — nothing here writes back to agent.json.
  //
  // The seed carries the per-agent settings only; the session file enters
  // through the tracked log's startup scan below. resumeSessionId covers
  // both startup shapes: revival (the last recorded session) and a fresh
  // `spawn -- --resume` (the wrapped session, which is in no record yet).
  // Scanning it is what lets get-context serve the resumed transcript
  // before the first turn — the streaming Query only initializes (and
  // announces a session) once a prompt is sent.
  const seedSessionId = resumeSessionId as UUID | undefined;
  const events: EventHub = new EventHub({
    seed: {
      ...initialAgentState(),
      // model and permissionMode report what the NEXT query will use:
      // explicit persisted options win, then the settings cascade; a
      // file-derived permissionMode would predict nothing (mode entries
      // record a past run's choice, not the next run's default), so the
      // fallback is the literal default.
      model: record.persistedOptions.model ?? settings.model,
      permissionMode:
        record.persistedOptions.permissionMode ??
        settings.permissionMode ??
        "default",
      // Same precedence for effort: an explicit spawn --effort wins.
      effortLevel: record.persistedOptions.effort ?? settings.effortLevel,
      cwd: record.cwd,
      querySessionId: seedSessionId,
    },
    deliver: (message) => turnQueue.push(message),
    tracker: () => trackedLog.tracker,
    log,
    anomalies: new AnomalyRecorder(agentDir),
  });
  // Serializes set-context and the session-log switch (writers) against
  // Query-bound requests and file reads; the shutdown drain takes it last.
  const gate = new RwGate();
  const trackedLog: TrackedSessionLog = new TrackedSessionLog({
    hub: events,
    gate,
    sessionFilePath: (sessionId) =>
      sessionFilePath(configDir, record.cwd, sessionId),
    onInvalid: log,
    log,
  });
  trackedLog.start(seedSessionId);

  // --- stream reader ---------------------------------------------------------
  // What remains of the reader is record bookkeeping plus a trivial loop, and
  // it stays here deliberately — it is the record owner's code, not a module
  // of its own. State tracking lives in the hub's fold (agent-state.ts).
  const observeSessionId = (sessionId: string): void => {
    const currentSessionId = record.sessions.at(-1)?.sessionId;
    // An init fires every turn; a rollover is an id that differs. The history
    // is duplicate-free: re-announcing a known session moves it to the end.
    if (sessionId !== currentSessionId) {
      const previousIndex = record.sessions.findIndex(
        (session) => session.sessionId === sessionId,
      );
      if (previousIndex !== -1) {
        record.sessions.splice(previousIndex, 1);
      }
      record.sessions.push({
        sessionId,
        sessionFile: sessionFilePath(configDir, record.cwd, sessionId as UUID),
      });
      log(`session: ${sessionId}`);
    }
    queueRecordWrite();
  };

  const handleMessage = (message: SDKMessage): void => {
    // Record bookkeeping before the fold: by the time a session-changing
    // event reaches observers, agent.json already has its queued update.
    if (message.type === "system" && message.subtype === "init") {
      // conversation_reset.new_conversation_id is not this transcript id
      // (verified live on 2.1.211); only init is authoritative for agent.json.
      record.claudeCodeVersion = message.claude_code_version;
      observeSessionId(message.session_id);
    }
    events.observeSdkMessage(message);
  };

  const runReader = (q: Query): Promise<void> =>
    (async () => {
      for await (const message of q) {
        handleMessage(message);
      }
    })();

  // set-context replaces the Query; the old reader's intentional completion
  // (tearingDown) is part of that replacement, not a daemon shutdown.
  // daemonStreamDone settles only when a reader ends on its own.
  let tearingDown = false;
  let resolveStreamDone!: () => void;
  let rejectStreamDone!: (error: unknown) => void;
  const daemonStreamDone = new Promise<void>((resolve, reject) => {
    resolveStreamDone = resolve;
    rejectStreamDone = reject;
  });
  // Mark handled: the failure paths below exit without awaiting it.
  void daemonStreamDone.catch(() => undefined);
  const watchReader = (done: Promise<void>): void => {
    done.then(
      () => {
        if (!tearingDown) {
          resolveStreamDone();
        }
      },
      (error: unknown) => {
        if (!tearingDown) {
          rejectStreamDone(error);
        }
      },
    );
  };

  let readerDone = runReader(claudeQuery);
  watchReader(readerDone);

  const teardownQuery = async (): Promise<void> => {
    tearingDown = true;
    turnQueue.close();
    // The stream ends once the child is gone (the SDK's cleanup awaits child
    // exit); an errored stream still means the old child is done.
    await readerDone.catch(() => undefined);
  };

  // Rejects only on synchronous construction failure: streaming-input mode
  // has no readiness signal to await (init fires on the first turn — see the
  // ready barrier below), so an async child-startup failure surfaces as a
  // reader error → daemonStreamDone rejection → daemon exit, the same path
  // as any other stream death; the handler's query-unavailable state covers
  // only the synchronous case, and revival reconstructs the rest.
  const restartQuery = async (resumeSessionId: string): Promise<void> => {
    turnQueue = new TurnQueue();
    claudeQuery = query({
      prompt: turnQueue,
      options: buildOptions(resumeSessionId),
    });
    readerDone = runReader(claudeQuery);
    watchReader(readerDone);
    tearingDown = false;
  };

  // Frozen at daemon start; the attach/detach audit hooks below use it.
  const auditingEnabled = auditEnabled(this.env);

  const sdkServer: Server = startSdkServer(
    sdkSocketPath(agentDir),
    createRequestHandler({
      getQuery: () => claudeQuery,
      events,
      getTurnQueue: () => turnQueue,
      cwd: record.cwd,
      log,
      getPersistedOptions: () => record.persistedOptions,
      setPersistedOptions: (options) => {
        record.persistedOptions = options;
        queueRecordWrite();
      },
      sessionFilePath: (sessionId) =>
        sessionFilePath(configDir, record.cwd, sessionId as UUID),
      teardownQuery,
      restartQuery,
      gate,
      trackedLog,
      registerAttachment: (info) => {
        const attachment: AttachmentInfo = {
          ...info,
          connectedAt: new Date().toISOString(),
        };
        record.attachments.push(attachment);
        queueRecordWrite();
        auditAttachEvent(
          agentDir,
          auditingEnabled,
          "attach",
          { pid: info.pid },
          log,
        );
        return () => {
          const index = record.attachments.indexOf(attachment);
          // Already gone when the shutdown clear below raced this close;
          // then the detach is implied by the shutdown and not audited.
          if (index === -1) {
            return;
          }
          record.attachments.splice(index, 1);
          queueRecordWrite();
          auditAttachEvent(
            agentDir,
            auditingEnabled,
            "detach",
            { pid: info.pid },
            log,
          );
        };
      },
    }),
  );

  // --- teardown --------------------------------------------------------------
  let exiting = false;
  const cleanupAndExit = (code: number, reason: string): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    void (async () => {
      // Criterion 9: an in-flight set-context or switch completes first;
      // entries already on disk reach subscribers before the shutdown line,
      // which precedes the socket close (delivery is best-effort — see
      // AgentEvent).
      const release = await gate.awaitExclusive();
      try {
        trackedLog.drainVisibleBytes();
      } catch (error) {
        log(`shutdown drain failed: ${String(error)}`);
      }
      events.emit({ kind: "shutdown", reason });
      trackedLog.close();
      release();
      claudeQuery.close();
      turnQueue.close();
      // Wait for the stream to end before exiting: the SDK's close() SIGTERMs
      // claude with a SIGKILL escalation timer that dies with this process, so
      // exiting early could orphan a SIGTERM-ignoring child. The stream ends
      // when the child is gone.
      await Promise.allSettled([writeQueue, readerDone]);
      sdkServer.close();
      // Clean shutdown clears the attachment list; a crash leaves stale
      // entries, which readers must ignore for non-running agents. Queued
      // (not written directly) so it serializes behind in-flight writes.
      // Reassigning the array also disarms the per-attachment deregisters:
      // detach on daemon shutdown is implied, not audited.
      record.attachments = [];
      queueRecordWrite();
      await writeQueue.catch(() => undefined);
      await rm(sdkSocketPath(agentDir), { force: true });
      proc.exit(code);
    })();
  };
  // Any termination request to the daemon means "shut the agent down".
  // query.close() SIGTERMs the claude subprocess with SIGKILL escalation.
  proc.on("SIGTERM", () => cleanupAndExit(0, "shut down (SIGTERM)"));
  proc.on("SIGINT", () => cleanupAndExit(0, "shut down (SIGINT)"));

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
      // No subscriber exists this early; the reason is for uniformity.
      cleanupAndExit(1, "failed to start (cannot bind sdk.sock)");
      return;
    }
  }

  signalReady(flags.readyFd, { ok: true });

  try {
    await daemonStreamDone;
    log("stream ended");
  } catch (error) {
    if (!exiting) {
      proc.stderr.write(`[daemon] stream failed: ${String(error)}\n`);
      cleanupAndExit(1, "crashed (claude stream failed)");
      return;
    }
  }
  cleanupAndExit(0, "exited (claude stream ended)");
}

const daemonCommand = commandNoTarget<DaemonFlags>({
  docs: { brief: "Internal command to launch a single-agent claude daemon" },
  parameters: { flags: daemonFlags },
  func: daemon,
});

export const internalRoutes = {
  _daemon: daemonCommand,
} as const;
