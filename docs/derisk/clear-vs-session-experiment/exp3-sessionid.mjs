// Follow-up: single session, 3 plain exchanges, NO slash command.
// Question: does a `system/init` fire on every turn, or only once per connection?
import { query } from "/home/anton/git/geraschenko/clauctl/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

const log = [];
const rec = (o) => log.push(o);

let resolveNext = null;
const pending = [];
function pushMsg(text) {
  const m = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "default" };
  if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: m, done: false }); }
  else pending.push(m);
}
let closed = false;
function closeInput() {
  closed = true;
  if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); }
}
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

const q = query({
  prompt: input,
  options: {
    pathToClaudeCodeExecutable: "/home/anton/.local/bin/claude",
    permissionMode: "bypassPermissions",
  },
});

const STEPS = [
  "Remember this secret: the password is bananas. Reply with just OK.",
  "What is the password? Answer in one word.",
  "Say the password again, in uppercase.",
];
let stepIdx = 0;
pushMsg(STEPS[stepIdx++]);

const HARD_TIMEOUT = setTimeout(() => { rec({ event: "HARD_TIMEOUT" }); closeInput(); }, 90000);

try {
  for await (const msg of q) {
    const slim = { type: msg.type, subtype: msg.subtype, session_id: msg.session_id };
    if (msg.type === "assistant") {
      const c = msg.message?.content;
      slim.text = Array.isArray(c) ? c.filter(b => b.type === "text").map(b => b.text).join("") : c;
    }
    if (msg.type === "result") { slim.subtype = msg.subtype; slim.result_text = msg.result; }
    // only record the message types we care about, to keep output readable
    if (["system", "assistant", "result"].includes(msg.type)) rec(slim);

    if (msg.type === "result") {
      rec({ event: "RESULT_BOUNDARY", after_step: stepIdx });
      if (stepIdx < STEPS.length) pushMsg(STEPS[stepIdx++]);
      else closeInput();
    }
  }
} catch (e) {
  rec({ event: "ERROR", message: String(e?.message || e) });
} finally {
  clearTimeout(HARD_TIMEOUT);
}

import { writeFileSync } from "fs";
writeFileSync(`/tmp/clauctl-derisk/out-sessionid.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 2));
