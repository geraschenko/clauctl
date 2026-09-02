// Shared plumbing for the compact-boundary-injection experiments. The
// scratch-config safety logic (credential copy, telemetry policy) lives in
// tests/sdk/harness.ts and is re-exported here so probes import one module.

import { query } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersions, baseEnv, makeConfigDir, REPO_DIR } from "../../../tests/sdk/harness.ts";

export { assertVersions, baseEnv, makeConfigDir, REPO_DIR };
export const EXP_DIR = path.dirname(fileURLToPath(import.meta.url));
export const HAIKU = "claude-haiku-4-5-20251001";

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
