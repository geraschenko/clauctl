/**
 * `clauctl spawn` — create an agent dir and daemonize a claude agent for it.
 * Also home of launchDaemon, shared with dormant-agent revival (lifecycle.ts).
 */

import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { attach } from "../tui/attach.ts";
import {
  booleanFlag,
  commandNoTarget,
  recordCommandAudit,
  restArgs,
  stringFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { resolveTargets, type CommandContext } from "./generated/targets.ts";
import { mainEntryPath } from "./main-entry-path.ts";
import { parseClaudeFlags } from "./options.ts";
import {
  agentDirPath,
  agentIdError,
  clauctlBaseDir,
  daemonLogPath,
  socketPathLengthError,
  writeSpawnOptions,
} from "./registry.ts";
import { UsageError } from "./generated/util.ts";

async function readAll(stream: Readable): Promise<string> {
  let data = "";
  for await (const chunk of stream) {
    data += chunk.toString();
  }
  return data;
}

/**
 * Launch the per-agent daemon: detached, stdio to daemon.log, plus a pipe on
 * fd 3 that the daemon writes a one-line ready/error message to once socket
 * is up (or startup failed).
 * Awaiting that pipe is what makes spawn exit only after the agent is actually
 * reachable — no fixed sleeps.
 *
 * Everything else the daemon needs is derived, not passed: agentDir from the
 * inherited CLAUCTL_DIR, spawn-vs-revival (and the config for each) from the
 * on-disk agent.json / spawn-options.json (see the daemon's startup
 * classification). `--ready-fd` stays a flag because it is per-launch
 * plumbing, not configuration.
 */
export async function launchDaemon(agentId: string): Promise<void> {
  const agentDir = agentDirPath(agentId);
  const logFd = openSync(daemonLogPath(agentDir), "a");
  const daemonArgs = [
    mainEntryPath(),
    "_daemon",
    "--agent-id",
    agentId,
    "--ready-fd",
    "3", // readiness pipe fd
  ];
  const child = spawnChild(process.execPath, daemonArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd, "pipe"],
  });
  closeSync(logFd);
  child.unref();

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (error) =>
      reject(new Error(`failed to start daemon: ${error.message}`)),
    );
  });
  const readyData = await Promise.race([
    readAll(child.stdio[3] as Readable),
    spawnError,
  ]);

  let ready: { ok: boolean; error?: string } | undefined;
  try {
    ready =
      readyData.trim() === ""
        ? undefined
        : (JSON.parse(readyData) as { ok: boolean; error?: string });
  } catch {
    ready = undefined;
  }
  if (!ready?.ok) {
    // Daemon-reported errors already carry the log path.
    throw new Error(
      ready?.error !== undefined
        ? `daemon failed to start: ${ready.error}`
        : `daemon failed to start: exited before signaling ready (log: ${daemonLogPath(agentDir)})`,
    );
  }
}

const spawnFlags = {
  cwd: stringFlag("Working directory", "path"),
  id: stringFlag("Agent id", "uuid"),
  tag: stringFlag("Agent label", "str"),
  attach: booleanFlag("Attach this terminal to the agent after spawning"),
};

type SpawnFlags = InferFlags<typeof spawnFlags>;

export async function spawn(
  this: CommandContext,
  flags: SpawnFlags,
  ...claudeFlags: string[]
): Promise<void> {
  const agentId = flags.id ?? randomUUID();
  const idError = agentIdError(agentId);
  if (idError) throw new UsageError(idError);
  const cwd = resolve(flags.cwd ?? process.cwd());
  const agentDir = agentDirPath(agentId);

  const pathError = socketPathLengthError(agentDir);
  if (pathError) throw new UsageError(pathError);

  // Parse before touching the filesystem so a flag error leaves no agent dir.
  const parsedFlags = parseClaudeFlags(claudeFlags);

  await mkdir(clauctlBaseDir(), { recursive: true });
  try {
    await mkdir(agentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`agent '${agentId}' already exists`);
    }
    throw error;
  }

  // spawn is audited but has no target: the agent dir only exists now, so
  // it records its own audit event instead of using the `audited` marker.
  await recordCommandAudit(this.env, this.argv, [agentDir]);

  await writeSpawnOptions(agentDir, {
    cwd,
    ...(flags.tag !== undefined && { tag: flags.tag }),
    persistedOptions: parsedFlags.persistedOptions,
    ...(parsedFlags.resume !== undefined && { resume: parsedFlags.resume }),
  });

  // On failure the dir is left in place so daemon.log can be inspected;
  // `clauctl gc` removes dirs that never got an agent.json.
  await launchDaemon(agentId);

  if (flags.attach) {
    // attach reads its target from this.targets and takes over the terminal
    // (exiting via process.exit), so it never returns here.
    this.targets = await resolveTargets([agentId]);
    await attach.call(this);
    return;
  }
  this.process.stdout.write(`${agentId}\n`);
}

const spawnCommand = commandNoTarget<SpawnFlags, string[]>({
  common: true,
  docs: {
    brief: "start an agent, print its id",
    customUsage: [
      "[--cwd <dir>] [--id <id>] [--tag <label>] [-a] [-- <claude flags...>]",
    ],
  },
  parameters: {
    flags: spawnFlags,
    aliases: { a: "attach" },
    positional: restArgs("claude-style flags (see spec)", "claude-flags"),
  },
  func: spawn,
});

export const spawnRoute = {
  spawn: spawnCommand,
} as const;
