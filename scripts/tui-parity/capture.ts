/**
 * Capture side of the TUI parity harness (docs/specs/tui-parity.md): render
 * each generated session in native claude and in the clauctl TUI inside
 * tmux, capture both panes, normalize, and diff.
 *
 * Entry point: node scripts/tui-parity/capture.ts [scenario…]
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { GeneratedSession } from "./generate.ts";

const execFileAsync = promisify(execFile);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");
export const outDir = join(scriptDir, "out");
export const manifestPath = join(outDir, "manifest.json");
/**
 * Scenario workdirs live outside the repo: inside it, claude walks up to the
 * repo's CLAUDE.md, which both pollutes generated sessions with clauctl's
 * own instructions and triggers the external-import trust dialog on
 * interactive resume.
 */
export const workdirBase = join(
  homedir(),
  ".cache",
  "clauctl-tui-parity",
  "workdir",
);

const clauctlMain = join(repoRoot, "src", "core", "main.ts");

/** Dedicated tmux server so the harness never disturbs the user's sessions. */
const TMUX_SOCKET = "clauctl-tui-parity";
const PANE_ROWS = 50;
const CAPTURE_COLS = 100;
const SETTLE_POLLS = 3;
const SETTLE_TIMEOUT_MS = 90_000;

export function resolveBundledClaude(): string {
  const binary = join(
    repoRoot,
    "node_modules",
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
    "claude",
  );
  if (!existsSync(binary)) {
    throw new Error(`bundled claude binary not found at ${binary}`);
  }
  return binary;
}

export interface CaptureTarget {
  /** claude --resume <id>, or the clauctl spawn/attach sequence. */
  command: string[];
  cwd: string;
}

async function tmux(...args: string[]): Promise<string> {
  // maxBuffer: full-scrollback captures of long sessions can exceed the
  // 1 MiB execFile default.
  const { stdout } = await execFileAsync("tmux", ["-L", TMUX_SOCKET, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function shQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Launches the target in a fresh tmux session `cols` wide, polls
 * `capture-pane -S -` (full scrollback — pane height is an internal
 * constant, irrelevant to captured content) with backoff until the
 * normalized capture is identical for SETTLE_POLLS consecutive polls (hard
 * timeout), then captures once plain and once with -e.
 *
 * Polling with backoff is the sanctioned pattern here: neither TUI exposes a
 * "render finished" signal observable from outside the pane (spec, Design
 * notes).
 */
export async function captureInTmux(
  target: CaptureTarget,
  cols: number,
): Promise<{ plain: string; ansi: string }> {
  const session = `cap-${randomUUID().slice(0, 8)}`;
  await tmux(
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    String(cols),
    "-y",
    String(PANE_ROWS),
    "-c",
    target.cwd,
    target.command.map(shQuote).join(" "),
  );
  try {
    // Keep the pane around if the command exits, so a crash is capturable
    // instead of tearing down the session mid-poll.
    await tmux("set-option", "-t", session, "remain-on-exit", "on");
    let last: string | undefined;
    let stable = 0;
    let delayMs = 300;
    let dialogsDismissed = 0;
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (stable < SETTLE_POLLS) {
      if (Date.now() > deadline) {
        throw new Error(
          `pane did not settle within ${SETTLE_TIMEOUT_MS}ms; last capture:\n${last}`,
        );
      }
      await delay(delayMs);
      delayMs = Math.min(delayMs * 1.5, 2_000);
      const current = normalize(
        await tmux("capture-pane", "-p", "-t", session, "-S", "-"),
      );
      stable = current === last ? stable + 1 : 0;
      last = current;
      // First-open dialogs (folder trust, external CLAUDE.md imports) settle
      // like any screen; accept the default and keep polling. Trust answers
      // persist per directory, so this normally fires once per workdir.
      if (stable >= SETTLE_POLLS && current.includes("Enter to confirm")) {
        if (dialogsDismissed >= 3) {
          throw new Error(`pane stuck on a dialog:\n${current}`);
        }
        dialogsDismissed += 1;
        await tmux("send-keys", "-t", session, "Enter");
        stable = 0;
        last = undefined;
        delayMs = 300;
      }
    }
    const plain = await tmux("capture-pane", "-p", "-t", session, "-S", "-");
    const ansi = await tmux(
      "capture-pane",
      "-p",
      "-e",
      "-t",
      session,
      "-S",
      "-",
    );
    return { plain, ansi };
  } finally {
    await tmux("kill-session", "-t", session).catch(() => {});
  }
}

/**
 * Strips animated/unstable regions so captures are comparable across runs
 * and across the two TUIs: spinner frames (braille and claude's star
 * glyphs), uuids, the home directory, trailing whitespace. Expected to
 * evolve as triage surfaces more unstable regions.
 */
export function normalize(capture: string): string {
  return (
    capture
      .replaceAll(/[⠁⠂⠄⡀⢀⠠⠐⠈⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✢✳✶✻✽]/gu, "·")
      .replaceAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        "<uuid>",
      )
      .replaceAll(homedir(), "~")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Collapse the blank tail (panes are padded to full height).
      .replace(/\n+$/, "\n")
  );
}

async function captureClauctl(
  entry: GeneratedSession,
): Promise<{ plain: string; ansi: string }> {
  const agentId = randomUUID();
  await execFileAsync(process.execPath, [
    clauctlMain,
    "spawn",
    "--cwd",
    entry.cwd,
    "--id",
    agentId,
    "--",
    "--resume",
    entry.sessionId,
  ]);
  try {
    return await captureInTmux(
      {
        command: [process.execPath, clauctlMain, "attach", "-t", agentId],
        cwd: entry.cwd,
      },
      CAPTURE_COLS,
    );
  } finally {
    await execFileAsync(process.execPath, [
      clauctlMain,
      "archive",
      "-t",
      agentId,
    ]).catch((error: unknown) => {
      console.error(`warning: archive of agent ${agentId} failed:`, error);
    });
  }
}

/** Unified diff of the two normalized captures; empty string if identical. */
async function diffFiles(fileA: string, fileB: string): Promise<string> {
  try {
    await execFileAsync("diff", ["-u", fileA, fileB]);
    return "";
  } catch (error) {
    const { code, stdout } = error as { code?: number; stdout?: string };
    if (code === 1 && stdout !== undefined) {
      return stdout;
    }
    throw error;
  }
}

async function captureScenario(entry: GeneratedSession): Promise<boolean> {
  // Interactive resume mutates the live session file (verified during
  // bring-up), so each side renders from a fresh restore of the pristine
  // generation-time snapshot.
  await copyFile(entry.snapshotPath, entry.sessionFilePath);
  const claude = await captureInTmux(
    {
      command: [resolveBundledClaude(), "--resume", entry.sessionId],
      cwd: entry.cwd,
    },
    CAPTURE_COLS,
  );
  await copyFile(entry.snapshotPath, entry.sessionFilePath);
  const clauctl = await captureClauctl(entry);
  const base = join(outDir, entry.scenario);
  await writeFile(`${base}.claude.txt`, normalize(claude.plain));
  await writeFile(`${base}.clauctl.txt`, normalize(clauctl.plain));
  await writeFile(`${base}.claude.ansi`, claude.ansi);
  await writeFile(`${base}.clauctl.ansi`, clauctl.ansi);
  const diff = await diffFiles(`${base}.claude.txt`, `${base}.clauctl.txt`);
  await writeFile(`${base}.diff`, diff);
  const differingLines = diff
    .split("\n")
    .filter((line) => /^[+-][^+-]/.test(line)).length;
  console.log(
    diff === ""
      ? `${entry.scenario}: identical`
      : `${entry.scenario}: ${differingLines} differing lines (${base}.diff)`,
  );
  return diff === "";
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as GeneratedSession[];
  const requested = process.argv.slice(2);
  const unknown = requested.filter(
    (name) => !manifest.some((entry) => entry.scenario === name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `not in manifest: ${unknown.join(", ")} (run generate.ts first?)`,
    );
  }
  const entries =
    requested.length === 0
      ? manifest
      : manifest.filter((entry) => requested.includes(entry.scenario));
  let identical = 0;
  for (const entry of entries) {
    if (await captureScenario(entry)) {
      identical += 1;
    }
  }
  console.log(`${identical}/${entries.length} scenarios identical`);
}

if (process.argv[1] !== undefined) {
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
