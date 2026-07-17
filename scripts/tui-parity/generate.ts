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
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeConfigDir,
  claudeEnv,
  ensureClaudeConfigDir,
  manifestPath,
  outDir,
  resolveBundledClaude,
  sessionFilePathFor,
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
  /** Where claude reads the session from (under claudeConfigDir/projects). */
  sessionFilePath: string;
  /**
   * Pristine copy taken right after generation. Capture renders the live
   * file (interactive resume only appends convergent metadata, which is
   * harmless — see captureScenario); the snapshot is a manual-recovery
   * point if a session is ever mutated for real.
   */
  snapshotPath: string;
}

/**
 * Run the scenario's prompts sequentially, each as its own query() resuming
 * the previous one. Serialization comes from the drain: each iteration
 * consumes its query to completion before the next resume starts, so the
 * prompts chain linearly instead of forking siblings off one parent (which
 * is what concurrent resumes of the same session would do). Each resume
 * forks to a NEW session id, so the id recorded for --resume is the one
 * observed on the final prompt.
 */
export async function generateSession(
  scenario: Scenario,
  workdir: string,
  claudeVersion: string,
): Promise<GeneratedSession> {
  let sessionId: string | undefined;
  for (const prompt of scenario.prompts) {
    const turn = query({
      prompt,
      options: {
        permissionMode: "dontAsk",
        ...scenario.options,
        cwd: workdir,
        resume: sessionId,
        env: { ...process.env, ...claudeEnv },
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
  const sessionFilePath = sessionFilePathFor(
    claudeConfigDir,
    workdir,
    sessionId,
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
  await ensureClaudeConfigDir();
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
