/**
 * `clauctl archive | gc` — stopping and cleaning up agents — plus the
 * transparent-revival machinery (`ensureAgentRunning`) that the sdk.sock
 * commands use to revive a dormant agent on demand.
 *
 * archive follows the polite path: wait until the assistant is Idle, SIGTERM
 * the daemon (whose teardown closes the SDK connection cleanly), SIGKILL
 * escalation if it lingers, then mark the dir hidden from `list`. gc removes
 * the leftover dirs of failed spawns and interrupted removals.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import {
  commandMultiTarget,
  commandNoTarget,
  secondsFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { multiTargets, type CommandContext } from "./generated/targets.ts";
import {
  type AgentRecord,
  agentDirPath,
  archivedPath,
  classifyAgentDir,
  daemonLogPath,
  isPidAlive,
  listAgentIds,
  loadAgent,
  reviveLockPath,
  sdkSocketPath,
} from "./registry.ts";
import { connectWithRetry } from "./sdk-socket.ts";
import { launchDaemon } from "./spawn.ts";
import { runStream } from "./generated/streaming/driver.ts";
import {
  secondsToTimerMs,
  UntilTimeoutError,
  type UntilCondition,
} from "./generated/until-engine.ts";
import { untilMetAtSeed, untilMetByEvent } from "./until.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;
const SIGKILL_ESCALATION_MS = 5_000;
const PROCESS_EXIT_DEADLINE_MS = 10_000;

const REVIVAL_WAIT_DEADLINE_MS = 10_000;
const REVIVAL_LOCK_POLL_MS = 100;

/** Set or clear an agent's archived marker (see registry.archivedPath). */
async function setArchived(agentDir: string, archived: boolean): Promise<void> {
  if (archived) {
    await writeFile(archivedPath(agentDir), `${new Date().toISOString()}\n`);
  } else {
    await rm(archivedPath(agentDir), { force: true });
  }
}

/**
 * Revive `agent` via launchDaemon, serialized through an O_EXCL lock file.
 * Two concurrent revivals of the same agent must not both launch daemons: the
 * second daemon's stale-socket cleanup would delete the first's live sdk.sock.
 * The loser waits for the winner instead of spawning. launchDaemon returns
 * only once the daemon signals ready, so holding the lock across it is the
 * readiness barrier. As with waitPidGone, there is no cross-process event
 * channel for "the lock file went away", so the loser polls.
 */
async function reviveAgent(agent: AgentRecord): Promise<AgentRecord> {
  const lockPath = reviveLockPath(agent.agentDir);
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return await awaitConcurrentRevival(agent, lockPath);
  }

  try {
    // Re-read under the lock: another process may have completed a revival
    // between our dormancy check and the lock acquisition.
    agent = await loadAgent(agent.id);
    if (isPidAlive(agent.daemonPid)) {
      return agent;
    }
    process.stderr.write(`clauctl: reviving dormant agent ${agent.id}\n`);
    // Reviving an archived agent — including implicitly, by sending it a
    // command — un-archives it.
    await setArchived(agent.agentDir, false);
    // The daemon classifies this as a revival by the presence of agent.json.
    await launchDaemon(agent.id);
    return await loadAgent(agent.id);
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function awaitConcurrentRevival(
  agent: AgentRecord,
  lockPath: string,
): Promise<AgentRecord> {
  const deadline = Date.now() + REVIVAL_WAIT_DEADLINE_MS;
  while (true) {
    let lockContent: string;
    try {
      lockContent = await readFile(lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
    const lockProcessPid = Number(lockContent.trim());
    if (lockProcessPid > 0 && !isPidAlive(lockProcessPid)) {
      throw new Error(
        `stale revival lock for '${agent.id}' (process ${lockProcessPid} is gone); remove ${lockPath} and retry`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for a concurrent revival of '${agent.id}' (lock: ${lockPath})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, REVIVAL_LOCK_POLL_MS));
  }
  agent = await loadAgent(agent.id);
  if (!isPidAlive(agent.daemonPid)) {
    throw new Error(
      `concurrent revival of '${agent.id}' failed; see ${daemonLogPath(agent.agentDir)}`,
    );
  }
  return agent;
}

/**
 * The transparent-revival entry point for commands that need the agent's
 * sdk.sock. list/status/gc never revive by design.
 */
export async function ensureAgentRunning(
  agentIdPrefix: string,
): Promise<AgentRecord> {
  const agent = await loadAgent(agentIdPrefix);
  if (isPidAlive(agent.daemonPid)) {
    return agent;
  }
  return await reviveAgent(agent);
}

function killSilently(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Wait for a pid to disappear. There is no channel to a non-child process, so
 * this polls kill(pid, 0) with a short interval; SIGKILL on deadline.
 */
async function waitPidGone(pid: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (isPidAlive(pid)) {
    if (Date.now() > deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Resolve all prefixes before acting (so a typo aborts before anything is
 * touched), then run `action` on every agent concurrently — agents are
 * independent, and concurrency keeps idle waits from compounding.
 * Failures are collected and reported in input order.
 */
async function forEachAgent(
  agents: readonly AgentRecord[],
  action: (agent: AgentRecord) => Promise<void>,
): Promise<void> {
  const failures = await Promise.all(
    agents.map((agent) =>
      action(agent).then(
        () => undefined,
        (error) =>
          `${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ),
  );
  const messages = failures.filter((failure) => failure !== undefined);
  if (messages.length > 0) {
    throw new Error(messages.join("\n"));
  }
}

/**
 * The polite stop: wait until Idle over sdk.sock, SIGTERM the daemon (its
 * teardown runs query.close(), which SIGTERMs claude with SIGKILL escalation),
 * then wait for the daemon pid to disappear, escalating ourselves if needed.
 */
async function stopRunningAgent(
  agent: AgentRecord,
  timeoutMs: number | undefined,
): Promise<void> {
  const client = await connectWithRetry(
    sdkSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  const idle: UntilCondition = { kind: "idle" };
  try {
    const { outcome } = await runStream(
      client,
      {
        onSeed: (seed) => untilMetAtSeed(idle, seed),
        onEvent: (event, state) => untilMetByEvent(idle, event, state),
      },
      timeoutMs,
    );
    if (outcome === "closed") {
      throw new Error("sdk socket closed while waiting for idle");
    }
    // Signalled as UntilTimeoutError so callers can distinguish "never went
    // idle" from a transport failure and word their own message.
    if (outcome === "timeout") {
      throw new UntilTimeoutError(
        `agent still busy after ${timeoutMs! / 1000}s`,
      );
    }
  } finally {
    client.close();
  }
  killSilently(agent.daemonPid, "SIGTERM");
  await waitPidGone(
    agent.daemonPid,
    Math.min(SIGKILL_ESCALATION_MS, PROCESS_EXIT_DEADLINE_MS),
  );
}

const timeoutFlags = {
  timeout: secondsFlag(),
};

type TimeoutFlags = InferFlags<typeof timeoutFlags>;

/**
 * Stop a running agent politely and mark it archived so `list` hides it by
 * default; the record and its sessions are kept and any revival (implicit, via
 * an sdk command) clears the flag.
 */
async function archive(
  this: CommandContext,
  flags: TimeoutFlags,
): Promise<void> {
  const timeoutMs =
    flags.timeout === undefined ? undefined : secondsToTimerMs(flags.timeout);
  await forEachAgent(multiTargets(this), async (agent) => {
    if (isPidAlive(agent.daemonPid)) {
      try {
        await stopRunningAgent(agent, timeoutMs);
      } catch (error) {
        if (error instanceof UntilTimeoutError) {
          throw new Error(
            `still busy after ${timeoutMs! / 1000}s; not archived`,
          );
        }
        throw error;
      }
    }
    await setArchived(agent.agentDir, true);
    this.process.stdout.write(`archived ${agent.id}\n`);
  });
}

const archiveCommand = commandMultiTarget<TimeoutFlags>({
  common: true,
  docs: { brief: "stop politely, then hide from list" },
  parameters: { flags: timeoutFlags },
  audited: true,
  func: archive,
});

async function gc(this: CommandContext): Promise<void> {
  const agentIds = await listAgentIds();
  let removed = 0;
  for (const agentId of agentIds) {
    const status = await classifyAgentDir(agentId);
    if (status.kind === "tombstoned" || status.kind === "corrupt") {
      await rm(agentDirPath(agentId), { recursive: true, force: true });
      this.process.stdout.write(`removed ${agentId} (${status.kind})\n`);
      removed += 1;
    }
  }
  this.process.stdout.write(
    removed === 0 ? "nothing to remove\n" : `removed ${removed} agent dir(s)\n`,
  );
}

const gcCommand = commandNoTarget({
  docs: { brief: "remove tombstoned or corrupt agent dirs" },
  func: gc,
});

export const lifecycleRoutes = {
  archive: archiveCommand,
} as const;

export const gcRoute = {
  gc: gcCommand,
} as const;
