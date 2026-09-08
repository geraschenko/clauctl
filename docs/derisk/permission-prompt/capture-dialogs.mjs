// Live capture of native claude's permission dialogs (layout parity source).
// Launches the bundled claude in tmux per scenario with the prompt as the
// initial argument, polls the viewport until the dialog is up, captures it
// (plain + ansi), then Escapes and kills the pane. Uses the tui-parity
// harness's isolated config dir (~/.cache/clauctl-tui-parity/config) and
// the same seeding rules (credentials copied, .claude.json seeded once,
// workdir trust pre-marked). Nothing is approved: every dialog is cancelled.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
const execFileAsync = promisify(execFile);
const EXP_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(EXP_DIR, "../../..");
const OUT_DIR = path.join(EXP_DIR, "out");
const claude = path.join(REPO, "node_modules", `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, "claude");
const configDir = path.join(homedir(), ".cache", "clauctl-tui-parity", "config");
const TMUX_SOCKET = "clauctl-permprobe";
const COLS = 100, ROWS = 50;
const DIALOG_MARKERS = ["Do you want to proceed", "Would you like to proceed", "Do you want to", "Esc to cancel", "esc to cancel"];

function seedConfig(workdirs) {
  fs.mkdirSync(configDir, { recursive: true });
  const creds = JSON.parse(fs.readFileSync(path.join(homedir(), ".claude", ".credentials.json"), "utf8"));
  if ((creds.claudeAiOauth?.expiresAt ?? 0) - Date.now() < 15 * 60 * 1000) throw new Error("access token near expiry; refuse to run");
  fs.writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify(creds), { mode: 0o600 });
  const dest = path.join(configDir, ".claude.json");
  if (!fs.existsSync(dest)) {
    const cj = JSON.parse(fs.readFileSync(path.join(homedir(), ".claude.json"), "utf8"));
    cj.projects = {}; cj.fullscreenUpsellSeenCount = 3;
    fs.writeFileSync(dest, JSON.stringify(cj, null, 2));
  }
  const cj = JSON.parse(fs.readFileSync(dest, "utf8"));
  cj.projects ??= {};
  for (const cwd of workdirs) (cj.projects[cwd] ??= {}).hasTrustDialogAccepted = true;
  fs.writeFileSync(dest, JSON.stringify(cj, null, 2));
}

const tmux = async (...args) => (await execFileAsync("tmux", ["-L", TMUX_SOCKET, ...args], { maxBuffer: 64 << 20 })).stdout;
const shQuote = (w) => `'${w.replaceAll("'", `'\\''`)}'`;

const OUTSIDE_DIR = "/tmp/clauctl-permprobe-outside";
const VICTIM_DIR = "/tmp/clauctl-permprobe-victim";
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE_DIR, "secret.txt"), "outside secret\n");
fs.mkdirSync(VICTIM_DIR, { recursive: true });

const SCENARIOS = [
  { name: "bash-outside", prompt: `Use the Bash tool to run \`rm -rf ${VICTIM_DIR}\`.` },
  { name: "bash-incwd", prompt: "Use the Bash tool to run `touch created.txt` in the current directory." },
  { name: "edit", setup: (cwd) => fs.writeFileSync(path.join(cwd, "a.txt"), "hello world\n"), prompt: (cwd) => `Use the Edit tool to replace 'hello' with 'goodbye' in ${cwd}/a.txt.` },
  { name: "write", prompt: (cwd) => `Use the Write tool to create ${cwd}/b.txt containing the single line 'hi'.` },
  { name: "read-outside", prompt: `Use the Read tool to read ${OUTSIDE_DIR}/secret.txt.` },
  { name: "webfetch", prompt: "Use the WebFetch tool to fetch https://example.com and tell me its title." },
  { name: "plan", args: ["--permission-mode", "plan"], prompt: "Make a one-line plan to create a file c.txt, then call ExitPlanMode to get my approval." },
  { name: "askuser", prompt: "Use the AskUserQuestion tool to ask me whether I prefer cats or dogs." },
];

const workdirBase = path.join(homedir(), ".cache", "clauctl-permprobe", "workdir");
const workdirs = SCENARIOS.map((s) => path.join(workdirBase, s.name));
for (const d of workdirs) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
seedConfig(workdirs);

async function captureScenario(scenario) {
  const cwd = path.join(workdirBase, scenario.name);
  scenario.setup?.(cwd);
  const prompt = typeof scenario.prompt === "function" ? scenario.prompt(cwd) : scenario.prompt;
  const session = `perm-${randomUUID().slice(0, 8)}`;
  const command = [claude, "--model", "claude-haiku-4-5-20251001", ...(scenario.args ?? []), prompt];
  await tmux("new-session", "-d", "-s", session, "-x", String(COLS), "-y", String(ROWS), "-c", cwd,
    "-e", `CLAUDE_CONFIG_DIR=${configDir}`, "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "-e", "DISABLE_AUTO_COMPACT=1",
    command.map(shQuote).join(" "));
  try {
    await tmux("set-option", "-t", session, "remain-on-exit", "on");
    const deadline = Date.now() + 120_000;
    let viewport = "";
    let seenAt;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`no dialog within timeout:\n${viewport}`);
      await delay(500);
      viewport = await tmux("capture-pane", "-p", "-t", session);
      if (DIALOG_MARKERS.some((m) => viewport.includes(m))) {
        // let it finish animating
        if (seenAt === undefined) seenAt = Date.now();
        else if (Date.now() - seenAt > 2500) break;
      }
    }
    const plain = await tmux("capture-pane", "-p", "-t", session, "-S", "-");
    const ansi = await tmux("capture-pane", "-p", "-e", "-t", session, "-S", "-");
    fs.writeFileSync(path.join(OUT_DIR, `${scenario.name}.claude.txt`), plain);
    fs.writeFileSync(path.join(OUT_DIR, `${scenario.name}.claude.ansi`), ansi);
    await tmux("send-keys", "-t", session, "Escape");
    await delay(1500);
    console.log(`${scenario.name}: captured`);
  } catch (error) {
    console.log(`${scenario.name}: FAILED ${String(error).slice(0, 300)}`);
  } finally {
    await tmux("kill-session", "-t", session).catch(() => {});
  }
}

const only = process.argv.slice(2);
for (const scenario of only.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS) await captureScenario(scenario);
await tmux("kill-server").catch(() => {});
