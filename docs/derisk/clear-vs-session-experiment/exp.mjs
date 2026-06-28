import { query } from "/home/anton/git/geraschenko/clauctl/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

// Command to test passed as argv[2]: "/clear" or "/new"
const SLASH = process.argv[2] || "/clear";
const LABEL = process.argv[3] || "clear";

const log = [];
function rec(o) { log.push(o); }

// Build a manually-driven async iterable of user messages.
let resolveNext = null;
const pending = [];
function pushMsg(text) {
  const m = {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
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
    // keep it cheap & deterministic
    permissionMode: "bypassPermissions",
  },
});

// State machine over results.
const STEPS = [
  "Remember this secret: the password is bananas. Reply with just OK.",
  SLASH,
  "What is the password? Answer in one word.",
];
let stepIdx = 0;
let resultsSeen = 0;

// Kick off first message immediately.
pushMsg(STEPS[stepIdx++]);

const PID = (() => {
  // find child claude pid after a moment via process list; recorded later
  return null;
})();

let timedOut = false;
const HARD_TIMEOUT = setTimeout(() => {
  timedOut = true;
  rec({ event: "HARD_TIMEOUT" });
  closeInput();
}, 90000);

let sawInit = false;
try {
  for await (const msg of q) {
    const slim = { type: msg.type, subtype: msg.subtype, session_id: msg.session_id };
    if (msg.type === "system" && msg.subtype === "init") {
      slim.full_init = JSON.stringify({
        type: msg.type, subtype: msg.subtype, session_id: msg.session_id,
        slash_commands: msg.slash_commands, cwd: msg.cwd, model: msg.model,
      });
      sawInit = true;
    }
    if (msg.type === "system" && msg.subtype === "session_state_changed") {
      slim.state = msg.state;
      slim.full = JSON.stringify(msg);
    }
    if (msg.type === "assistant") {
      const c = msg.message?.content;
      slim.text = Array.isArray(c) ? c.filter(b => b.type === "text").map(b => b.text).join("") : c;
    }
    if (msg.type === "user") {
      const c = msg.message?.content;
      slim.text = typeof c === "string" ? c : JSON.stringify(c)?.slice(0, 200);
    }
    if (msg.type === "result") {
      slim.subtype = msg.subtype;
      slim.is_error = msg.is_error;
      slim.result_text = msg.result;
    }
    rec(slim);

    if (msg.type === "result") {
      resultsSeen++;
      rec({ event: "RESULT_BOUNDARY", count: resultsSeen, after_step: stepIdx });
      if (stepIdx < STEPS.length) {
        pushMsg(STEPS[stepIdx++]);
      } else {
        closeInput();
      }
    }
  }
} catch (e) {
  rec({ event: "ERROR", message: String(e?.message || e), stack: String(e?.stack || "").slice(0, 500) });
} finally {
  clearTimeout(HARD_TIMEOUT);
}

rec({ event: "GENERATOR_ENDED", timedOut });

import { writeFileSync } from "fs";
writeFileSync(`/tmp/clauctl-derisk/out-${LABEL}.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 2));
