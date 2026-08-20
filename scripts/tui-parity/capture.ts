/**
 * Capture side of the TUI parity harness (docs/specs/tui-parity.md): render
 * each generated session in native claude and in the clauctl TUI inside
 * tmux, capture both panes, normalize, and diff.
 *
 * Entry point: node scripts/tui-parity/capture.ts [scenario…]
 *   [--session <id-or-jsonl-path>]… [--clauctl-in-tmux] [--recapture-claude]
 *
 * `--session` imports a copy of a real session (from the real ~/.claude)
 * into the isolated config dir and captures both views of it — for turning
 * unexpected rendering in day-to-day sessions into comparison cases.
 *
 * The claude side (tmux resume of the native TUI) is captured once per
 * subject and cached in out/: it only changes when the session content or
 * the pinned claude version changes, not while iterating on clauctl
 * rendering. A cached capture is reused when the session file's hash still
 * matches (`<name>.claude.meta.json`); `--recapture-claude` forces a fresh
 * one (e.g. after a claude version bump or a normalize() change).
 *
 * The clauctl side renders directly from the session file by default
 * (render-session.ts, no tmux) — fast iteration on transcript rendering;
 * direct output is the transcript only, so footer/editor chrome shows up in
 * the diff by construction. `--clauctl-in-tmux` spawns a real agent and
 * captures a tmux attach instead — the full-chrome end-to-end path.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { GeneratedSession } from "./generate.ts";
import { renderSessionFile } from "./render-session.ts";

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
  /** Extra environment for the pane (tmux new-session -e). */
  env?: Record<string, string>;
}

/**
 * Generated sessions live in their own claude config dir, not the user's
 * real ~/.claude. Every claude invocation in the harness (SDK generation,
 * interactive capture, and the daemon's claude child) runs with this
 * CLAUDE_CONFIG_DIR.
 */
export const claudeConfigDir = join(
  homedir(),
  ".cache",
  "clauctl-tui-parity",
  "config",
);
/**
 * Environment for every claude invocation in the harness. Besides the
 * config-dir isolation, auto-compaction is disabled: resuming a
 * near-context-limit session would otherwise compact on open — rewriting
 * the transcript being compared, burning tokens, and animating a progress
 * bar that defeats settle detection.
 */
export const claudeEnv = {
  CLAUDE_CONFIG_DIR: claudeConfigDir,
  DISABLE_AUTO_COMPACT: "1",
};

/**
 * Seeds the isolated config dir ONCE from the real credentials and
 * top-level config (login + onboarding state; without them claude blocks on
 * the login/onboarding wizard). The seeded `.claude.json` drops the user's
 * per-project map — the harness shouldn't inherit per-project MCP servers
 * or history — and marks the fullscreen-renderer upsell as already seen:
 * that dialog's default answer OPTS IN to a different renderer, so the
 * generic Enter-dismissal must never reach it. Existing copies are never
 * overwritten — claude refreshes tokens and records trust in the copies, so
 * re-copying could clobber fresher state. Delete the dir to re-seed.
 */
export async function ensureClaudeConfigDir(): Promise<void> {
  await mkdir(claudeConfigDir, { recursive: true });
  const credentialsSource = join(homedir(), ".claude", ".credentials.json");
  const credentialsDestination = join(claudeConfigDir, ".credentials.json");
  if (existsSync(credentialsSource) && !existsSync(credentialsDestination)) {
    await copyFile(credentialsSource, credentialsDestination);
  }
  const configSource = join(homedir(), ".claude.json");
  const configDestination = join(claudeConfigDir, ".claude.json");
  if (existsSync(configSource) && !existsSync(configDestination)) {
    const config = JSON.parse(await readFile(configSource, "utf8")) as Record<
      string,
      unknown
    >;
    config.projects = {};
    config.fullscreenUpsellSeenCount = 3;
    await writeFile(configDestination, JSON.stringify(config, null, 2));
  }
}

/**
 * Harness agents live in their own registry, not the user's real
 * CLAUCTL_DIR. /tmp keeps the path short enough for the unix socket budget
 * (agentDir/sdk.sock), which an out/-based registry would exceed.
 *
 * The config dir is isolated too, so captures use clauctl's default
 * keybindings and the settings pinned by ensureClauctlConfigDir instead of
 * whatever the developer's real config holds.
 */
const clauctlDir = "/tmp/clauctl-tui-parity";
const clauctlConfigDir = join(clauctlDir, "config");
const clauctlEnv = {
  CLAUCTL_DIR: clauctlDir,
  CLAUCTL_CONFIG_DIR: clauctlConfigDir,
  ...claudeEnv,
};

/**
 * Pin the harness TUI to regular mode (rewritten on every run — the file is
 * harness-owned). Parity compares clauctl's rendering against native
 * claude's main-buffer document; the fullscreen default would capture an
 * alternate-screen viewport instead.
 */
async function ensureClauctlConfigDir(): Promise<void> {
  await mkdir(clauctlConfigDir, { recursive: true });
  await writeFile(
    join(clauctlConfigDir, "settings.json"),
    `${JSON.stringify({ tuiMode: "regular" }, null, 2)}\n`,
  );
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
  const envArgs = Object.entries(target.env ?? {}).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
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
    ...envArgs,
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
      // A live dialog's "Enter to confirm…" hint is the LAST line of the
      // visible viewport; anchoring there keeps transcripts that merely
      // QUOTE dialog text (e.g. a session about this very harness, where
      // the string appears mid-scrollback and even mid-viewport) from
      // being mistaken for a stuck dialog.
      if (stable >= SETTLE_POLLS) {
        const viewport = await tmux("capture-pane", "-p", "-t", session);
        const lastLine =
          viewport
            .split("\n")
            .map((line) => line.trim())
            .findLast((line) => line !== "") ?? "";
        if (lastLine.startsWith("Enter to confirm")) {
          if (dialogsDismissed >= 3) {
            throw new Error(`pane stuck on a dialog:\n${viewport}`);
          }
          dialogsDismissed += 1;
          await tmux("send-keys", "-t", session, "Enter");
          stable = 0;
          last = undefined;
          delayMs = 300;
        }
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
      // Auth-state-dependent chrome from account-level (claude.ai) MCP
      // connectors; comes and goes with login/token state.
      .replaceAll(/^.*⚠ \d+ MCP servers? need authentication.*\n/gmu, "")
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

/**
 * What a capture run renders: a generated scenario or an imported real
 * session. `name` is the basename for the out/ files.
 */
interface CaptureSubject {
  name: string;
  sessionId: string;
  cwd: string;
}

/** Where claude persists/reads a session for `cwd` under `configDir`. */
export function sessionFilePathFor(
  configDir: string,
  cwd: string,
  sessionId: string,
): string {
  return join(
    configDir,
    "projects",
    cwd.replaceAll(/[/.]/g, "-"),
    `${sessionId}.jsonl`,
  );
}

/**
 * Imports a session into the isolated config dir so both TUIs render a
 * COPY — the original under the real ~/.claude is never opened or mutated.
 * Accepts a path to the session jsonl, or a bare session id (searched under
 * the real config dir's projects/). The session's cwd is read from its
 * entries. Re-importing overwrites the copy, so the capture always reflects
 * the session's current content.
 */
async function importSession(idOrPath: string): Promise<CaptureSubject> {
  const realConfigDir =
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  let sourcePath: string;
  if (idOrPath.endsWith(".jsonl")) {
    sourcePath = idOrPath;
  } else {
    const projectsDir = join(realConfigDir, "projects");
    const matches = (
      await readdir(projectsDir, { withFileTypes: true })
    ).flatMap((dirent) => {
      const candidate = join(projectsDir, dirent.name, `${idOrPath}.jsonl`);
      return dirent.isDirectory() && existsSync(candidate) ? [candidate] : [];
    });
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `session ${idOrPath} not found under ${projectsDir}`
          : `session ${idOrPath} is ambiguous: ${matches.join(", ")}`,
      );
    }
    sourcePath = matches[0]!;
  }
  const sessionId = basename(sourcePath, ".jsonl");
  const entryWithCwd = (await readFile(sourcePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cwd?: string })
    .find((entry) => entry.cwd !== undefined);
  if (entryWithCwd?.cwd === undefined) {
    throw new Error(`no cwd found in any entry of ${sourcePath}`);
  }
  const { cwd } = entryWithCwd;
  const destination = sessionFilePathFor(claudeConfigDir, cwd, sessionId);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(sourcePath, destination);
  return { name: `session-${sessionId.slice(0, 8)}`, sessionId, cwd };
}

async function captureClauctlInTmux(
  subject: CaptureSubject,
): Promise<{ plain: string; ansi: string }> {
  const agentId = randomUUID();
  const spawnEnv = { ...process.env, ...clauctlEnv };
  await execFileAsync(
    process.execPath,
    [
      clauctlMain,
      "spawn",
      "--cwd",
      subject.cwd,
      "--id",
      agentId,
      "--",
      "--resume",
      subject.sessionId,
    ],
    { env: spawnEnv },
  );
  try {
    return await captureInTmux(
      {
        command: [process.execPath, clauctlMain, "attach", "-t", agentId],
        cwd: subject.cwd,
        env: clauctlEnv,
      },
      CAPTURE_COLS,
    );
  } finally {
    await execFileAsync(
      process.execPath,
      [clauctlMain, "archive", "-t", agentId],
      { env: spawnEnv },
    ).catch((error: unknown) => {
      console.error(`warning: archive of agent ${agentId} failed:`, error);
    });
  }
}

/** CSI sequences and OSC …BEL sequences (the components' OSC 133 markers). */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(
    /\u001b\][^\u0007]*\u0007|\u001b\[[0-9;?]*[A-Za-z]/g,
    "",
  );
}

/** The clauctl side rendered directly from the session file (no tmux). */
function renderDirect(subject: CaptureSubject): {
  plain: string;
  ansi: string;
} {
  const sessionPath = sessionFilePathFor(
    claudeConfigDir,
    subject.cwd,
    subject.sessionId,
  );
  const ansi = renderSessionFile(sessionPath, CAPTURE_COLS).join("\n") + "\n";
  return { plain: stripAnsi(ansi), ansi };
}

/**
 * Unified diff of the two normalized captures; empty string if identical.
 * --label drops the default mtime headers so diff files are byte-identical
 * across runs.
 */
async function diffFiles(fileA: string, fileB: string): Promise<string> {
  try {
    await execFileAsync("diff", [
      "-u",
      "--label",
      fileA,
      "--label",
      fileB,
      fileA,
      fileB,
    ]);
    return "";
  } catch (error) {
    const { code, stdout } = error as { code?: number; stdout?: string };
    if (code === 1 && stdout !== undefined) {
      return stdout;
    }
    throw error;
  }
}

/** Cache-invalidation record for a claude-side capture: the exact session
 *  content it rendered. */
interface ClaudeCaptureMeta {
  sessionId: string;
  sessionSha256: string;
}

async function sessionSha256(subject: CaptureSubject): Promise<string> {
  const sessionPath = sessionFilePathFor(
    claudeConfigDir,
    subject.cwd,
    subject.sessionId,
  );
  return createHash("sha256")
    .update(await readFile(sessionPath))
    .digest("hex");
}

/**
 * The claude side, cached across runs: the native TUI's rendering of a
 * session only changes when the session content (hash in the meta sidecar)
 * or the pinned claude version changes — not while iterating on clauctl —
 * so a matching cached capture is reused instead of waiting out a tmux
 * settle. `recapture` (or a hash mismatch) forces a fresh capture.
 * Returns whether the cache was used.
 */
async function captureClaude(
  subject: CaptureSubject,
  base: string,
  recapture: boolean,
): Promise<boolean> {
  const metaPath = `${base}.claude.meta.json`;
  const meta: ClaudeCaptureMeta = {
    sessionId: subject.sessionId,
    sessionSha256: await sessionSha256(subject),
  };
  if (
    !recapture &&
    existsSync(metaPath) &&
    existsSync(`${base}.claude.txt`) &&
    existsSync(`${base}.claude.ansi`)
  ) {
    const cached = JSON.parse(
      await readFile(metaPath, "utf8"),
    ) as ClaudeCaptureMeta;
    if (
      cached.sessionId === meta.sessionId &&
      cached.sessionSha256 === meta.sessionSha256
    ) {
      return true;
    }
  }
  const claude = await captureInTmux(
    {
      command: [resolveBundledClaude(), "--resume", subject.sessionId],
      cwd: subject.cwd,
      env: claudeEnv,
    },
    CAPTURE_COLS,
  );
  await writeFile(`${base}.claude.txt`, normalize(claude.plain));
  await writeFile(`${base}.claude.ansi`, claude.ansi);
  // The resume can append convergent metadata (ai-title/agent-name, then
  // mode/permission-mode) on the first two opens and nothing after;
  // captures are deterministic with or without it (verified during
  // bring-up). Hash AFTER the capture so that append does not immediately
  // invalidate the cache it just filled.
  await writeFile(
    metaPath,
    JSON.stringify(
      { ...meta, sessionSha256: await sessionSha256(subject) },
      null,
      2,
    ) + "\n",
  );
  return false;
}

async function captureClauctl(
  subject: CaptureSubject,
  base: string,
  inTmux: boolean,
): Promise<void> {
  const clauctl = inTmux
    ? await captureClauctlInTmux(subject)
    : renderDirect(subject);
  await writeFile(`${base}.clauctl.txt`, normalize(clauctl.plain));
  await writeFile(`${base}.clauctl.ansi`, clauctl.ansi);
}

async function captureSubject(
  subject: CaptureSubject,
  options: { clauctlInTmux: boolean; recaptureClaude: boolean },
): Promise<boolean> {
  // Both sides render the LIVE session file; out/sessions/ remains a
  // manual-recovery point if a session is ever mutated for real (e.g. a
  // prompt typed during triage).
  const base = join(outDir, subject.name);
  const claudeCached = await captureClaude(
    subject,
    base,
    options.recaptureClaude,
  );
  await captureClauctl(subject, base, options.clauctlInTmux);
  const diff = await diffFiles(`${base}.claude.txt`, `${base}.clauctl.txt`);
  await writeFile(`${base}.diff`, diff);
  const differingLines = diff
    .split("\n")
    .filter((line) => /^[+-][^+-]/.test(line)).length;
  const sides =
    `claude ${claudeCached ? "cached" : "tmux"}, ` +
    `clauctl ${options.clauctlInTmux ? "tmux" : "direct"}`;
  console.log(
    diff === ""
      ? `${subject.name} (${sides}): identical`
      : `${subject.name} (${sides}): ${differingLines} differing lines (${base}.diff)`,
  );
  return diff === "";
}

async function main(): Promise<void> {
  await ensureClaudeConfigDir();
  await ensureClauctlConfigDir();
  const args = process.argv.slice(2);
  const subjects: CaptureSubject[] = [];
  const requested: string[] = [];
  let clauctlInTmux = false;
  let recaptureClaude = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--clauctl-in-tmux") {
      clauctlInTmux = true;
    } else if (args[i] === "--recapture-claude") {
      recaptureClaude = true;
    } else if (args[i] === "--session") {
      const value = args[++i];
      if (value === undefined) {
        throw new Error("--session requires a session id or jsonl path");
      }
      subjects.push(await importSession(value));
    } else {
      requested.push(args[i]!);
    }
  }
  // Scenario subjects come from the manifest: all of it by default, unless
  // specific scenarios (or only --session imports) were requested.
  if (requested.length > 0 || subjects.length === 0) {
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as GeneratedSession[];
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
    subjects.push(
      ...entries.map((entry) => ({
        name: entry.scenario,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
      })),
    );
  }
  let identical = 0;
  for (const subject of subjects) {
    if (await captureSubject(subject, { clauctlInTmux, recaptureClaude })) {
      identical += 1;
    }
  }
  console.log(`${identical}/${subjects.length} subjects identical`);
}

if (process.argv[1] !== undefined) {
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
