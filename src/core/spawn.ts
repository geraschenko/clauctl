/**
 * `clauctl spawn` — create an agent dir and daemonize a claude agent for it.
 * Also home of launchDaemon, shared with dormant-agent revival (lifecycle.ts).
 */

import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  commandNoTarget,
  restArgs,
  stringFlag,
  type InferFlags,
} from "./cli.ts";
import { type CommandContext } from "./targets.ts";
import { parseClaudeFlags } from "./options.ts";
import {
  agentDirPath,
  agentIdError,
  clauctlBaseDir,
  daemonLogPath,
  socketPathLengthError,
  spawnOptionsPath,
} from "./registry.ts";
import { UsageError } from "./util.ts";

interface DaemonLaunch {
  agentDir: string;
  agentId: string;
  cwd: string;
  // TDC: isn't resume just whether the agentDir/agentId already exists? We shouldn't redundantly pass what can be easily derived. This also suggests we shouldn't have agentDir here, since it's purely derivable from agentId. Same for pictl.
  /** Revival: daemon reads persistedOptions from agent.json and resumes the last session. */
  resume: boolean;
  /** Set only on initial spawn; revival preserves the recorded tag. */
  tag?: string;
}

/**
 * The script Node was invoked with, re-execed for the detached daemon. Using
 * process.argv[1] (rather than a path derived from import.meta.url) keeps the
 * re-exec correct whether clauctl runs from the built `dist/` (`main.js`) or
 * from `.ts` source under type-stripping (`main.ts`), where a hardcoded
 * `./main.js` would point at a nonexistent file.
 */
function mainEntryPath(): string {
  const entry = process.argv[1];
  if (entry === undefined) {
    throw new Error("cannot determine clauctl entry script (process.argv[1])");
  }
  return entry;
}

async function readAll(stream: Readable): Promise<string> {
  let data = "";
  for await (const chunk of stream) {
    data += chunk.toString();
  }
  return data;
}

/**
 * Launch the per-agent daemon: detached, stdio to daemon.log, plus a pipe on
 * fd 3 that the daemon writes a one-line ready/error message to once sdk.sock
 * is up (or startup failed).
 * Awaiting that pipe is what makes spawn exit only after the agent is actually
 * reachable — no fixed sleeps.
 */
export async function launchDaemon(launch: DaemonLaunch): Promise<void> {
  const logFd = openSync(daemonLogPath(launch.agentDir), "a");
  // TDC: I think I understood this before, but am confused now. Why is it necessary to have a _daemon subcommand which is used by spawn? It seems like it'd be clearer to just call a function here to create the child process rather than re-entering the binary from command line, parsing flags, etc. If we change it here, we should also change in pictl.
  const daemonArgs = [
    mainEntryPath(),
    "_daemon",
    "--agent-dir",
    launch.agentDir,
    "--agent-id",
    launch.agentId,
    "--cwd",
    launch.cwd,
    "--ready-fd",
    "3", // readiness pipe fd
    ...(launch.tag !== undefined ? ["--tag", launch.tag] : []),
    ...(launch.resume ? ["--resume"] : []),
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
        : `daemon failed to start: exited before signaling ready (log: ${daemonLogPath(launch.agentDir)})`,
    );
  }
}

const spawnFlags = {
  cwd: stringFlag("Working directory", "path"),
  id: stringFlag("Agent id", "uuid"),
  tag: stringFlag("Agent label", "str"),
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
  const spawnOptions = parseClaudeFlags(claudeFlags);
  spawnOptions.persistedOptions.cwd = cwd;

  await mkdir(clauctlBaseDir(), { recursive: true });
  try {
    await mkdir(agentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`agent '${agentId}' already exists`);
    }
    throw error;
  }

  await writeFile(
    spawnOptionsPath(agentDir),
    `${JSON.stringify(spawnOptions, null, "\t")}\n`,
  );

  // On failure the dir is left in place so daemon.log can be inspected;
  // `clauctl gc` removes dirs that never got an agent.json.
  await launchDaemon({
    agentDir,
    agentId,
    cwd,
    resume: false,
    tag: flags.tag,
  });
  this.process.stdout.write(`${agentId}\n`);
}

const spawnCommand = commandNoTarget<SpawnFlags, string[]>({
  common: true,
  docs: {
    brief: "start an agent, print its id",
    customUsage: [
      "[--cwd <dir>] [--id <id>] [--tag <label>] [-- <claude flags...>]",
    ],
  },
  parameters: {
    flags: spawnFlags,
    positional: restArgs("claude-style flags (see spec)", "claude-flags"),
  },
  func: spawn,
});

export const spawnRoute = {
  spawn: spawnCommand,
} as const;
