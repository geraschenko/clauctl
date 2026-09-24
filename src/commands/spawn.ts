/**
 * `clauctl spawn` — create an agent dir and daemonize a claude agent for it.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { attach } from "./attach.ts";
import { launchDaemon } from "./launch-daemon.ts";
import {
  booleanFlag,
  commandNoTarget,
  recordCommandAudit,
  restArgs,
  stringFlag,
  type InferFlags,
} from "../core/generated/cli.ts";
import {
  resolveTargets,
  type CommandContext,
} from "../core/generated/targets.ts";
import { parseClaudeFlags } from "../core/options.ts";
import {
  agentDirPath,
  agentIdError,
  clauctlBaseDir,
  socketPathLengthError,
  writeSpawnOptions,
} from "../core/registry.ts";
import { UsageError } from "../core/generated/util.ts";

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
