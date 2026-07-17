/**
 * Generation side of the TUI parity harness (docs/specs/tui-parity.md):
 * materialize the scenario corpus (scenarios.ts) as real claude sessions via
 * the SDK, in fixed per-scenario workdirs so --resume finds them by cwd.
 * This is the only step that costs API calls; capture/diff is free to
 * repeat.
 *
 * Entry point: node scripts/tui-parity/generate.ts [scenario…]
 */

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  manifestPath,
  outDir,
  resolveBundledClaude,
  workdirBase,
} from "./capture.ts";
import { scenarios, type Scenario } from "./scenarios.ts";

const execFileAsync = promisify(execFile);

export interface GeneratedSession {
  scenario: string;
  sessionId: string;
  cwd: string;
  /** Provenance: which bundled claude version produced it. */
  claudeVersion: string;
  /** Where claude reads the session from (under ~/.claude/projects). */
  sessionFilePath: string;
  /**
   * Pristine copy taken right after generation. Interactive resume MUTATES
   * the live session file (verified empirically), so capture restores from
   * this snapshot before rendering each side.
   */
  snapshotPath: string;
}

/**
 * Run the scenario's prompts sequentially, each as its own query() resuming
 * the previous one. Each resume forks to a NEW session id, so the id
 * recorded for --resume is the one observed on the final prompt.
 */
export async function generateSession(
  scenario: Scenario,
  workdir: string,
  claudeVersion: string,
): Promise<GeneratedSession> {
  let sessionId: string | undefined;
  for (const prompt of scenario.prompts) {
    // TDC: Huh? You're re-creating the Query object for each prompt? Why not put the prompts in an async iterator or TurnQueue as usual? By creating separate Query objects in quick succession, I suspect you're rooting all the prompts to the same parent rather than executing one after the other (which is what happens if you resume a session interactively from multiple terminals at the same time). Ah, I guess you await the resulting messages below, so it's fine.
    const turn = query({
      prompt,
      options: {
        // TDC: NEVER use bypassPermissions. There's no good reason to use this mode. I consider it dangerous. If you don't want to deal with permission prompts, use dontAsk or auto
        permissionMode: "bypassPermissions",
        ...scenario.options,
        cwd: workdir,
        resume: sessionId,
      },
    });
    for await (const message of turn) {
      if ("session_id" in message) {
        sessionId = message.session_id;
      }
    }
  }
  if (sessionId === undefined) {
    throw new Error(`${scenario.name}: no session id observed`);
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const sessionFilePath = join(
    configDir,
    "projects",
    workdir.replaceAll(/[/.]/g, "-"),
    `${sessionId}.jsonl`,
  );
  const snapshotPath = join(outDir, "sessions", `${scenario.name}.jsonl`);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await copyFile(sessionFilePath, snapshotPath);
  return {
    scenario: scenario.name,
    sessionId,
    cwd: workdir,
    claudeVersion,
    sessionFilePath,
    snapshotPath,
  };
}

async function readManifest(): Promise<GeneratedSession[]> {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const unknown = requested.filter(
    (name) => !scenarios.some((scenario) => scenario.name === name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `unknown scenarios: ${unknown.join(", ")} (available: ${scenarios
        .map((scenario) => scenario.name)
        .join(", ")})`,
    );
  }
  const selected =
    requested.length === 0
      ? scenarios
      : scenarios.filter((scenario) => requested.includes(scenario.name));

  const { stdout } = await execFileAsync(resolveBundledClaude(), ["--version"]);
  const claudeVersion = stdout.trim().split(" ")[0]!;

  await mkdir(outDir, { recursive: true });
  const manifest = await readManifest();
  for (const scenario of selected) {
    const workdir = join(workdirBase, scenario.name);
    await mkdir(workdir, { recursive: true });
    console.log(`generating ${scenario.name}…`);
    const generated = await generateSession(scenario, workdir, claudeVersion);
    const existing = manifest.findIndex(
      (entry) => entry.scenario === scenario.name,
    );
    if (existing === -1) {
      manifest.push(generated);
    } else {
      manifest[existing] = generated;
    }
    console.log(`  session ${generated.sessionId}`);
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${manifestPath} (${manifest.length} entries)`);
}

if (process.argv[1] !== undefined) {
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
