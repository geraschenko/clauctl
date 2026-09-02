// Shared plumbing for the compact-boundary-injection experiments.
//
// SECURITY: never writes to the real ~/.claude. Every session runs with
// env = baseEnv(...), which points CLAUDE_CONFIG_DIR at a scratch dir seeded
// with a mode-0600 COPY of ~/.claude/.credentials.json. The copied access
// token stays valid for hours and scratch CLIs don't refresh before expiry,
// so the real session's refresh-token family is not rotated. Onboarding
// state is the real ~/.claude.json with its project list cleared. Uses the
// SDK-bundled `claude` binary.
//
// TELEMETRY: probes deliberately put sessions into error-shaped states
// (crashes between tool call and result, malformed boundary playlists), which
// would otherwise stream telemetry and error reports that look like organic
// failures. Essential-traffic mode suppresses both (DISABLE_TELEMETRY alone
// leaves error reporting on). Set here at module scope so it covers every
// probe path: spawned CLIs inherit it via baseEnv's process.env spread, and
// in-process SDK calls (getSessionMessages) read process.env directly.

import { query } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// See TELEMETRY note above; docs/derisk/AGENTS.md states the policy.
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

export const EXP_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = path.resolve(EXP_DIR, "../../..");
export const HAIKU = "claude-haiku-4-5-20251001";
const CRED_SOURCE = `${process.env.HOME}/.claude/.credentials.json`;
const CLAUDE_JSON_SOURCE = `${process.env.HOME}/.claude.json`;

// The suite must exercise the SDK clauctl ships: the installed package has to
// equal package.json's exact pin (README Hygiene). Reports record which
// version produced them; check-reports.mjs version-conditions the assertions
// that carry known drift.
export function assertVersions() {
  const pinned = JSON.parse(fs.readFileSync(path.join(REPO_DIR, "package.json"), "utf8"))
    .dependencies["@anthropic-ai/claude-agent-sdk"];
  const installed = JSON.parse(fs.readFileSync(
    path.join(REPO_DIR, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version;
  if (installed !== pinned) throw new Error(`installed SDK ${installed} != package.json pin ${pinned} — run npm ci`);
  return { sdk: installed };
}

// Fresh scratch CLAUDE_CONFIG_DIR seeded with auth. One per experiment case.
export function makeConfigDir(caseName) {
  const dir = `/tmp/clauctl-cbi-derisk/${caseName}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const creds = JSON.parse(fs.readFileSync(CRED_SOURCE, "utf8"));
  const expiresAt = creds.claudeAiOauth?.expiresAt ?? 0;
  if (expiresAt - Date.now() < 15 * 60 * 1000) {
    throw new Error(`~/.claude access token expires at ${new Date(expiresAt).toISOString()} — ` +
      `refusing to run (a scratch-CLI refresh could rotate the real session's tokens)`);
  }
  fs.writeFileSync(`${dir}/.credentials.json`, JSON.stringify(creds), { mode: 0o600 });
  // .claude.json carries onboarding state; without it the CLI may block on
  // first-run prompts. Projects are cleared so no real trust state leaks in.
  const cj = JSON.parse(fs.readFileSync(CLAUDE_JSON_SOURCE, "utf8"));
  fs.writeFileSync(`${dir}/.claude.json`, JSON.stringify({ ...cj, projects: {} }));
  return dir;
}

export const baseEnv = (configDir, extra = {}) => ({
  ...process.env,
  CLAUDE_CONFIG_DIR: configDir,
  ...extra,
});

// Session jsonl path for a given cwd + session id, mirroring the CLI's projectKey scheme.
export const projectKey = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
export const sessionFile = (configDir, cwd, sessionId) =>
  path.join(configDir, "projects", projectKey(cwd), `${sessionId}.jsonl`);

// Start shim.mjs recording to captureFile; resolves {port, kill} once listening.
export function startShim(captureFile) {
  fs.mkdirSync(path.dirname(captureFile), { recursive: true });
  fs.rmSync(captureFile, { force: true });
  return new Promise((resolve, reject) => {
    const child = spawn("node", [`${EXP_DIR}/shim.mjs`, captureFile], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (d) => {
      const m = String(d).match(/LISTENING (\d+)/);
      if (m) resolve({ port: Number(m[1]), kill: () => child.kill() });
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`shim exited early (${code})`)));
  });
}

// Manually-driven streaming session (same shape as ../resume-persistence/harness.mjs).
// send(text) resolves with the turn's collected messages once its `result` arrives.
export function makeSession(options) {
  let resolveNext = null;
  const pending = [];
  let closed = false;
  const input = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => { resolveNext = res; });
        },
      };
    },
  };
  const pushMsg = (text) => {
    const m = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: m, done: false }); }
    else pending.push(m);
  };

  const q = query({ prompt: input, options });
  const inits = [];
  let resolveResult = null;
  let turnMsgs = [];
  let loopErr = null;
  const loop = (async () => {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") inits.push(msg);
      turnMsgs.push(msg);
      if (msg.type === "result") {
        const r = resolveResult; resolveResult = null;
        const collected = turnMsgs; turnMsgs = [];
        if (r) r(collected);
      }
    }
  })().catch((e) => { loopErr = e; });

  const send = (text) => new Promise((res, rej) => {
    resolveResult = res;
    pushMsg(text);
    loop.then(() => { if (loopErr) rej(loopErr); });
  });
  // Graceful teardown: endInput() ends the prompt stream (CLI sees stdin EOF and
  // exits); `done` resolves when the message generator completes — the SDK's
  // cleanup awaits the child's exit before that. close() is the forceful variant.
  const endInput = () => { closed = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); } };
  const close = () => { endInput(); q.close(); };
  return { q, send, inits, close, endInput, done: loop, lastInit: () => inits[inits.length - 1] };
}

export const readJsonl = (file) =>
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Inference requests from a shim capture file (filters count_tokens, telemetry,
// etc.). The shim creates the file on the first request, so a session that
// never reached the API leaves none — an empty capture, not a crash, so the
// probe can report the session error instead.
export const readCapturedInference = (captureFile) =>
  (fs.existsSync(captureFile) ? readJsonl(captureFile) : [])
    .filter((r) => r.path?.startsWith("/v1/messages") && !r.path.includes("count_tokens") && r.body?.messages);
