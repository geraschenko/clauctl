/**
 * Permission-dialog side of the TUI parity harness
 * (docs/specs/permission-prompt.md, "Parity harness"): for each dialog
 * scenario, raise the ask in native claude and in a clauctl agent, capture
 * both panes at the dialog, cancel it (Escape — nothing is ever approved),
 * and diff. Same isolation as capture.ts (config dir, registry, workdirs).
 *
 * Entry point: node scripts/tui-parity/capture-dialogs.ts [scenario…]
 *   [--recapture-claude]
 *
 * The claude side is cached per scenario definition (prompt, args, claude
 * version); the clauctl side is always live, one haiku call per scenario.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isNotPendingError } from "../../src/core/protocol/index.ts";
import { ProtocolClient } from "../../src/core/protocol-client/index.ts";
import { agentDirPath, agentSocketPath } from "../../src/core/registry.ts";
import { PLAIN_DENY_MESSAGE } from "../../src/tui/permission-dialog.ts";
import {
  CAPTURE_COLS,
  captureInTmux,
  type CaptureTarget,
  claudeConfigDir,
  claudeEnv,
  clauctlEnv,
  clauctlMain,
  diffFiles,
  ensureClauctlConfigDir,
  ensureClaudeConfigDir,
  ensureWorkdirsTrusted,
  normalize,
  outDir,
  resolveBundledClaude,
  workdirBase,
} from "./capture.ts";
import {
  ASK_RULE_COMMAND,
  type DialogScenario,
  dialogScenarios,
} from "./dialog-scenarios.ts";

const execFileAsync = promisify(execFile);

/** Every dialog ends in one of these; presence gates settle detection. */
const DIALOG_MARKERS = [
  "Do you want to",
  "Would you like to proceed",
  "Esc to cancel",
];
const MODEL = "claude-haiku-4-5-20251001";

/** Like captureInTmux, but settles only once a dialog marker is on screen
 *  and sends Escape after the capture. */
export function captureDialogInTmux(
  target: CaptureTarget,
  cols: number,
  markers: string[],
): Promise<{ plain: string; ansi: string }> {
  return captureInTmux(target, cols, { markers, keysAfter: ["Escape"] });
}

/**
 * Pin the `ask-rule` scenario's `permissions.ask` rule in the isolated
 * settings. Merged into claude's own file (it holds claude-written keys), so
 * only this one rule is harness-owned.
 */
async function ensureAskRule(): Promise<void> {
  const settingsPath = join(claudeConfigDir, "settings.json");
  const settings = (
    existsSync(settingsPath)
      ? JSON.parse(await readFile(settingsPath, "utf8"))
      : {}
  ) as { permissions?: { ask?: string[] } };
  const rule = `Bash(${ASK_RULE_COMMAND})`;
  const ask = settings.permissions?.ask ?? [];
  if (!ask.includes(rule)) {
    settings.permissions = { ...settings.permissions, ask: [...ask, rule] };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
}

interface ResolvedScenario {
  scenario: DialogScenario;
  cwd: string;
  prompt: string;
}

/** The scenario's workdir is wiped and set up fresh: neither side's ask
 *  may depend on a previous run's leftovers. */
async function resolveScenario(
  scenario: DialogScenario,
): Promise<ResolvedScenario> {
  const cwd = join(workdirBase, `dialog-${scenario.name}`);
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });
  scenario.setup?.(cwd);
  const prompt =
    typeof scenario.prompt === "function"
      ? scenario.prompt(cwd)
      : scenario.prompt;
  return { scenario, cwd, prompt };
}

/** Cache-invalidation record for a claude-side dialog capture. */
interface ClaudeDialogMeta {
  definitionSha256: string;
}

function definitionSha256(
  resolved: ResolvedScenario,
  claudeVersion: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        claudeVersion,
        resolved.prompt,
        resolved.scenario.claudeArgs ?? [],
      ]),
    )
    .digest("hex");
}

/** Returns whether the cache was used. */
async function captureClaudeDialog(
  resolved: ResolvedScenario,
  base: string,
  claudeVersion: string,
  recapture: boolean,
): Promise<boolean> {
  const metaPath = `${base}.dialog.claude.meta.json`;
  const meta: ClaudeDialogMeta = {
    definitionSha256: definitionSha256(resolved, claudeVersion),
  };
  if (
    !recapture &&
    existsSync(metaPath) &&
    existsSync(`${base}.dialog.claude.txt`) &&
    existsSync(`${base}.dialog.claude.ansi`)
  ) {
    const cached = JSON.parse(
      await readFile(metaPath, "utf8"),
    ) as ClaudeDialogMeta;
    if (cached.definitionSha256 === meta.definitionSha256) {
      return true;
    }
  }
  const claude = await captureDialogInTmux(
    {
      command: [
        resolveBundledClaude(),
        resolved.prompt,
        "--model",
        MODEL,
        ...(resolved.scenario.claudeArgs ?? []),
      ],
      cwd: resolved.cwd,
      env: claudeEnv,
    },
    CAPTURE_COLS,
    DIALOG_MARKERS,
  );
  await writeFile(`${base}.dialog.claude.txt`, normalize(claude.plain));
  await writeFile(`${base}.dialog.claude.ansi`, claude.ansi);
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return false;
}

/**
 * Spawn an isolated agent with the scenario's claude flags, send the
 * prompt over the socket (the ask is then in the attach snapshot), attach
 * in tmux and capture the dialog. The ask is plain-denied over the socket
 * rather than by a key in the pane: `archive` stops politely (waits for
 * idle), and an agent blocked on an ask never idles on its own.
 */
async function captureClauctlDialog(
  resolved: ResolvedScenario,
  base: string,
): Promise<void> {
  const agentId = randomUUID();
  const spawnEnv = { ...process.env, ...clauctlEnv };
  await execFileAsync(
    process.execPath,
    [
      clauctlMain,
      "spawn",
      "--cwd",
      resolved.cwd,
      "--id",
      agentId,
      "--",
      "--model",
      MODEL,
      ...(resolved.scenario.claudeArgs ?? []),
    ],
    { env: spawnEnv },
  );
  try {
    process.env.CLAUCTL_DIR = clauctlEnv.CLAUCTL_DIR;
    const client = await ProtocolClient.connect(
      agentSocketPath(agentDirPath(agentId)),
    );
    try {
      await client.request({ type: "prompt", content: resolved.prompt });
      const clauctl = await captureInTmux(
        {
          command: [
            process.execPath,
            "--no-warnings=ExperimentalWarning",
            clauctlMain,
            "attach",
            "-t",
            agentId,
          ],
          cwd: resolved.cwd,
          env: clauctlEnv,
        },
        CAPTURE_COLS,
        { markers: DIALOG_MARKERS },
      );
      await writeFile(`${base}.dialog.clauctl.txt`, normalize(clauctl.plain));
      await writeFile(`${base}.dialog.clauctl.ansi`, clauctl.ansi);
      const { seed } = await client.subscribe();
      // The ask payload behind the dialog (suggestions → row-2 label),
      // for triage against claude's label.
      await writeFile(
        `${base}.dialog.ask.json`,
        JSON.stringify(seed.pendingPermissions, null, 2) + "\n",
      );
      for (const ask of seed.pendingPermissions) {
        await client
          .request({
            type: "permission-response",
            toolUseId: ask.toolUseId,
            decision: { behavior: "deny", message: PLAIN_DENY_MESSAGE },
          })
          .catch((error: unknown) => {
            if (!isNotPendingError(error)) throw error;
          });
      }
    } finally {
      client.close();
    }
  } finally {
    await execFileAsync(
      process.execPath,
      // Bounded: a capture failure leaves the ask pending, and the polite
      // stop would otherwise wait for an idle that never comes.
      [clauctlMain, "archive", "-t", agentId, "--timeout", "30"],
      { env: spawnEnv },
    ).catch((error: unknown) => {
      console.error(`warning: archive of agent ${agentId} failed:`, error);
    });
  }
}

async function captureScenario(
  resolved: ResolvedScenario,
  claudeVersion: string,
  recaptureClaude: boolean,
): Promise<boolean> {
  const { name } = resolved.scenario;
  const base = join(outDir, name);
  const claudeCached = await captureClaudeDialog(
    resolved,
    base,
    claudeVersion,
    recaptureClaude,
  );
  const sides = `claude ${claudeCached ? "cached" : "tmux"}`;
  if (resolved.scenario.claudeOnly) {
    console.log(`${name} (${sides}): claude only`);
    return false;
  }
  await captureClauctlDialog(resolved, base);
  const diff = await diffFiles(
    `${base}.dialog.claude.txt`,
    `${base}.dialog.clauctl.txt`,
  );
  await writeFile(`${base}.dialog.diff`, diff);
  const differingLines = diff
    .split("\n")
    .filter((line) => /^[+-][^+-]/.test(line)).length;
  console.log(
    diff === ""
      ? `${name} (${sides}, clauctl tmux): identical`
      : `${name} (${sides}, clauctl tmux): ${differingLines} differing lines (${base}.dialog.diff)`,
  );
  return diff === "";
}

async function main(): Promise<void> {
  await ensureClaudeConfigDir();
  await ensureClauctlConfigDir();
  await ensureAskRule();
  const args = process.argv.slice(2);
  const recaptureClaude = args.includes("--recapture-claude");
  const requested = args.filter((arg) => arg !== "--recapture-claude");
  const unknown = requested.filter(
    (name) => !dialogScenarios.some((scenario) => scenario.name === name),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown scenarios: ${unknown.join(", ")}`);
  }
  const selected =
    requested.length === 0
      ? dialogScenarios
      : dialogScenarios.filter((scenario) => requested.includes(scenario.name));
  const { stdout } = await execFileAsync(resolveBundledClaude(), ["--version"]);
  const claudeVersion = stdout.trim().split(" ")[0]!;
  await mkdir(outDir, { recursive: true });
  const resolvedScenarios = await Promise.all(selected.map(resolveScenario));
  await ensureWorkdirsTrusted(
    resolvedScenarios.map((resolved) => resolved.cwd),
  );
  let identical = 0;
  for (const resolved of resolvedScenarios) {
    if (await captureScenario(resolved, claudeVersion, recaptureClaude)) {
      identical += 1;
    }
  }
  console.log(`${identical}/${resolvedScenarios.length} scenarios identical`);
}

if (process.argv[1] !== undefined) {
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
