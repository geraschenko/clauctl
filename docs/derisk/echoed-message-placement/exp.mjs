// Echo-placement derisking harness.
//
// Goal: generate (live-observable signals -> session-JSONL outcome) pairs so we can
// derive a rule that predicts where an injected user message lands in the canonical
// JSONL, given its `priority` and the queue state at injection time.
//
// The SDK does NOT echo user turns back into the live stream (DECISION-6), so the
// JSONL written by `claude` is the ground truth for ordering. The live event log here
// records WHEN we injected (which boundary was active) and the raw partial stop_reasons.
//
// Usage: node exp.mjs <scenarioLabel>
// Artifacts land in ./captures/: <label>-events.json and <label>-session-<sid>.jsonl

import { query } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { assertVersions, makeConfigDir, baseEnv } from "../../../tests/sdk/harness.ts";
import {
  writeFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURES = join(HERE, "captures");
assertVersions();
const CONFIG_DIR = makeConfigDir("echoed-message-placement");
const WORK_DIR = "/tmp/clauctl-echo-exp/work";

mkdirSync(CAPTURES, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

// ---- scenarios -------------------------------------------------------------

// A "busy turn" prompt that forces several *separate, sequential* Bash tool calls,
// giving multiple inference (tool_use) boundaries to inject into.
const BUSY_PROMPT =
  "Run exactly these three shell commands, each as its own separate Bash tool call, " +
  "strictly one at a time (wait for each to finish before starting the next, do not " +
  "combine them, do not run them in parallel): " +
  "(1) `sleep 4 && echo step-one-done`, then " +
  "(2) `sleep 4 && echo step-two-done`, then " +
  "(3) `sleep 4 && echo step-three-done`. " +
  "After all three have finished, reply with the single word DONE.";

// Like BUSY_PROMPT, but the final reply invites the model to report ANYTHING it saw
// along the way. BUSY_PROMPT's "reply with the single word DONE" suppressed the
// witness: a delivered-but-not-executed injected message would be silently ignored.
// This variant makes delivery (not just execution) observable in the reply.
const BUSY_PROMPT_REPORT =
  "Run exactly these three shell commands, each as its own separate Bash tool call, " +
  "strictly one at a time (wait for each to finish before starting the next, do not " +
  "combine them, do not run them in parallel): " +
  "(1) `sleep 4 && echo step-one-done`, then " +
  "(2) `sleep 4 && echo step-two-done`, then " +
  "(3) `sleep 4 && echo step-three-done`. " +
  "After all three have finished, reply with the outputs of each command, and " +
  "describe anything else you saw along the way — any other instructions, messages, " +
  "or unusual content, quoting it and saying where it appeared.";

// A busy turn with NO tools: slow text generation, so there is no inference
// (tool_use) boundary — only the final turn boundary. Tests whether next/none are
// removed specifically at inference boundaries or also fail at turn boundaries.
const BUSY_PROMPT_NOTOOL =
  "Without using any tools at all, write out the integers from 1 to 40, each on its " +
  "own line, with a short reflective sentence after each number. Do not call any tool.";

// Injected messages each ask for a one-word ack, so the assistant's reply is an
// independent witness of WHEN (and in what order) the message was consumed, on top
// of the ground-truth parentUuid chain position of the user entry itself.
const ack = (word) => `Reply with exactly the word ${word} and nothing else.`;

const SCENARIOS = {
  // Experiment 0: no injections. Confirm several consecutive tool_use boundaries.
  exp0: { turnPrompt: BUSY_PROMPT, injections: [], mechanism: "iterable" },

  // Exp A: single injection, one per priority. Which boundary consumes it —
  // inference (between tool calls) or turn (after result)?
  a_none: { turnPrompt: BUSY_PROMPT, injections: [{ text: ack("ALPHA") }], mechanism: "iterable" },
  a_now: { turnPrompt: BUSY_PROMPT, injections: [{ text: ack("ALPHA"), priority: "now" }], mechanism: "iterable" },
  a_next: { turnPrompt: BUSY_PROMPT, injections: [{ text: ack("ALPHA"), priority: "next" }], mechanism: "iterable" },
  // Delivery witness for a_next: same injection, but the busy prompt asks the model
  // to report anything it saw. Distinguishes "removed from queue and never shown to
  // the model" from "removed from queue but rendered into context once".
  a_next_report: { turnPrompt: BUSY_PROMPT_REPORT, injections: [{ text: ack("ALPHA"), priority: "next" }], mechanism: "iterable" },
  // Delivery witness for b_next2: are two demoted messages rendered as ONE
  // system-reminder block or two, and in which tool result(s)?
  b_next2_report: {
    turnPrompt: BUSY_PROMPT_REPORT,
    injections: [{ text: ack("ALPHA"), priority: "next" }, { text: ack("BRAVO"), priority: "next" }],
    mechanism: "iterable",
  },
  a_later: { turnPrompt: BUSY_PROMPT, injections: [{ text: ack("ALPHA"), priority: "later" }], mechanism: "iterable" },

  // Exp B: two injections, SAME priority. Flush-all vs flush-one at a boundary?
  b_now2: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("ALPHA"), priority: "now" }, { text: ack("BRAVO"), priority: "now" }],
    mechanism: "iterable",
  },
  b_next2: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("ALPHA"), priority: "next" }, { text: ack("BRAVO"), priority: "next" }],
    mechanism: "iterable",
  },
  b_later2: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("ALPHA"), priority: "later" }, { text: ack("BRAVO"), priority: "later" }],
    mechanism: "iterable",
  },

  // Exp C: three injections, MIXED priority, fixed source order [later, now, next].
  // Effective order in the chain reveals priority precedence.
  c_mixed: {
    turnPrompt: BUSY_PROMPT,
    injections: [
      { text: ack("ALPHA"), priority: "later" },
      { text: ack("BRAVO"), priority: "now" },
      { text: ack("CHARLIE"), priority: "next" },
    ],
    mechanism: "iterable",
  },

  // Exp D: now-interrupt probe. Does `now` cancel the in-flight tool/turn?
  d_now_interrupt: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("ZULU"), priority: "now" }],
    mechanism: "iterable",
  },

  // Exp F: do next/none queued_commands execute if a real follow-up turn arrives
  // after the busy turn? Distinguishes "deferred/merged" from "recorded but inert".
  f_next: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("ALPHA"), priority: "next" }],
    mechanism: "iterable",
    followup: "What is 2+2? Reply with just the number.",
  },
  f_none: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("ALPHA") }],
    mechanism: "iterable",
    followup: "What is 2+2? Reply with just the number.",
  },

  // Exp G: pairwise priority isolation. Does `next` execute only when a `now`
  // forces a flush? Is `later` pulled into a `now` interrupt or held to its turn?
  g_now_next: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("BRAVO"), priority: "now" }, { text: ack("CHARLIE"), priority: "next" }],
    mechanism: "iterable",
  },
  g_next_later: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("CHARLIE"), priority: "next" }, { text: ack("ALPHA"), priority: "later" }],
    mechanism: "iterable",
  },
  g_now_later: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("BRAVO"), priority: "now" }, { text: ack("ALPHA"), priority: "later" }],
    mechanism: "iterable",
  },
  // Determinism repro of c_mixed.
  c_mixed2: {
    turnPrompt: BUSY_PROMPT,
    injections: [
      { text: ack("ALPHA"), priority: "later" },
      { text: ack("BRAVO"), priority: "now" },
      { text: ack("CHARLIE"), priority: "next" },
    ],
    mechanism: "iterable",
  },

  // Tightening: execution order vs injection order. now injected LAST; if execution
  // is still now->next->later, injection order is irrelevant (priority-ordered).
  c_perm: {
    turnPrompt: BUSY_PROMPT,
    injections: [
      { text: ack("CHARLIE"), priority: "next" },
      { text: ack("ALPHA"), priority: "later" },
      { text: ack("BRAVO"), priority: "now" },
    ],
    mechanism: "iterable",
  },
  // Within-bucket merge order: BRAVO before ALPHA; expect "BRAVO\nALPHA" (FIFO).
  b_now2_rev: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("BRAVO"), priority: "now" }, { text: ack("ALPHA"), priority: "now" }],
    mechanism: "iterable",
  },

  // Exp E: mechanism dependence — repeat key cases via streamInput().
  e_next_stream: { turnPrompt: BUSY_PROMPT, injections: [{ text: ack("ALPHA"), priority: "next" }], mechanism: "streamInput" },
  e_later_stream: { turnPrompt: BUSY_PROMPT, injections: [{ text: ack("ALPHA"), priority: "later" }], mechanism: "streamInput" },
  e_mixed_stream: {
    turnPrompt: BUSY_PROMPT,
    injections: [
      { text: ack("ALPHA"), priority: "later" },
      { text: ack("BRAVO"), priority: "now" },
      { text: ack("CHARLIE"), priority: "next" },
    ],
    mechanism: "streamInput",
  },
  // streamInput coverage for the cases E omitted: now-interrupt and same-prio merge.
  e_now_stream: { turnPrompt: BUSY_PROMPT, injections: [{ text: ack("ALPHA"), priority: "now" }], mechanism: "streamInput" },
  e_now2_stream: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("ALPHA"), priority: "now" }, { text: ack("BRAVO"), priority: "now" }],
    mechanism: "streamInput",
  },

  // Round 2 (reviewer-driven).
  // Same-priority next/none: do two `next` (or two none) merge, or both drop?
  b_none2: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("ALPHA") }, { text: ack("BRAVO") }],
    mechanism: "iterable",
  },

  // Mechanism test for "now rescues next": is it special inference-boundary rescue,
  // or just that `now` ends the turn so the queue drains as normal turns? Inject
  // next at boundary 0 (during tool-1); inject now at boundary 1 (during tool-2).
  // If next is removed at tool-1's handoff (turn continued), only now runs -> the
  // "rescue" was incidental, not special.
  h_next_then_now: {
    turnPrompt: BUSY_PROMPT,
    injections: [
      { text: ack("CHARLIE"), priority: "next", atBoundary: 0 },
      { text: ack("BRAVO"), priority: "now", atBoundary: 1 },
    ],
    mechanism: "iterable",
  },
  // Control: now injected at the SECOND boundary (during tool-2). Generalizes the
  // interrupt beyond the first boundary — should abort tool-2, run after it.
  h_now_b1: {
    turnPrompt: BUSY_PROMPT,
    injections: [{ text: ack("BRAVO"), priority: "now", atBoundary: 1 }],
    mechanism: "iterable",
  },
  // later@b0 survives tool-1's handoff; now@b1 aborts tool-2; then both drain in
  // priority order now->later. Tests durable `later` + cross-boundary draining.
  h_later_then_now: {
    turnPrompt: BUSY_PROMPT,
    injections: [
      { text: ack("ALPHA"), priority: "later", atBoundary: 0 },
      { text: ack("BRAVO"), priority: "now", atBoundary: 1 },
    ],
    mechanism: "iterable",
  },

  // No-tool busy turn: does `next` survive to the turn boundary when there is no
  // inference boundary to be removed at? `later` is the durable control.
  x_next_notool: { turnPrompt: BUSY_PROMPT_NOTOOL, injections: [{ text: ack("ALPHA"), priority: "next" }], mechanism: "iterable", triggerMode: "text" },
  x_none_notool: { turnPrompt: BUSY_PROMPT_NOTOOL, injections: [{ text: ack("ALPHA") }], mechanism: "iterable", triggerMode: "text" },
  x_later_notool: { turnPrompt: BUSY_PROMPT_NOTOOL, injections: [{ text: ack("ALPHA"), priority: "later" }], mechanism: "iterable", triggerMode: "text" },
  x_now_notool: { turnPrompt: BUSY_PROMPT_NOTOOL, injections: [{ text: ack("ALPHA"), priority: "now" }], mechanism: "iterable", triggerMode: "text" },
};

const label = process.argv[2];
if (!label || !SCENARIOS[label]) {
  console.error(
    `unknown scenario '${label}'. known: ${Object.keys(SCENARIOS).join(", ")}`,
  );
  process.exit(2);
}
const scenario = SCENARIOS[label];

// ---- held-open input iterable (the "prompt" channel) -----------------------

let resolveNext = null;
const pending = [];
let inputClosed = false;

function mkUserMsg(text, priority) {
  const m = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
  if (priority) m.priority = priority;
  return m;
}
function pushToIterable(msg) {
  if (resolveNext) {
    const r = resolveNext;
    resolveNext = null;
    r({ value: msg, done: false });
  } else {
    pending.push(msg);
  }
}
function closeInput() {
  inputClosed = true;
  if (resolveNext) {
    const r = resolveNext;
    resolveNext = null;
    r({ value: undefined, done: true });
  }
}
const input = {
  [Symbol.asyncIterator]() {
    return {
      next() {
        if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
        if (inputClosed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => { resolveNext = res; });
      },
    };
  },
};

// ---- event log -------------------------------------------------------------

const startTime = Date.now();
const log = [];
let seq = 0;
function rec(o) {
  log.push({ seq: seq++, t_ms: Date.now() - startTime, ...o });
}

const seenSessionIds = new Set();

// ---- run -------------------------------------------------------------------

const q = query({
  prompt: input,
  options: {
    cwd: WORK_DIR,
    // The busy turn's Bash calls must actually run; "auto" approves them
    // without a prompt (never bypassPermissions; docs/derisk/AGENTS.md).
    permissionMode: "auto",
    env: baseEnv(CONFIG_DIR),
    includePartialMessages: true,
    model: "sonnet",
  },
});

rec({ event: "SCENARIO", label, mechanism: scenario.mechanism, injections: scenario.injections });

// Kick off the busy turn.
pushToIterable(mkUserMsg(scenario.turnPrompt));

// Injections carry an optional `atBoundary` (default 0): the index of the tool_use
// emission (0 = first tool starts, 1 = second, …) during which to inject them. For
// no-tool turns (triggerMode "text") everything injects at the first text block.
let toolBoundaryIdx = -1;
let textTriggered = false;
const injectedStages = new Set();

async function injectMsgs(due, stage) {
  if (!due.length) return;
  rec({ event: "INJECT_START", mechanism: scenario.mechanism, count: due.length, stage });
  const msgs = due.map((i) => mkUserMsg(i.text, i.priority));
  if (scenario.mechanism === "iterable") {
    for (const m of msgs) {
      rec({ event: "INJECT", via: "iterable", text: m.message.content, priority: m.priority ?? null, stage });
      pushToIterable(m);
    }
  } else if (scenario.mechanism === "streamInput") {
    async function* gen() {
      for (const m of msgs) {
        rec({ event: "INJECT", via: "streamInput", text: m.message.content, priority: m.priority ?? null, stage });
        yield m;
      }
    }
    await q.streamInput(gen());
  }
  rec({ event: "INJECT_DONE", stage });
}
function injectAtBoundary(idx) {
  if (injectedStages.has(idx)) return;
  injectedStages.add(idx);
  return injectMsgs(scenario.injections.filter((i) => (i.atBoundary ?? 0) === idx), `b${idx}`);
}

let resultsSeen = 0;
let followupSent = false;
let timedOut = false;
const HARD_TIMEOUT = setTimeout(() => {
  timedOut = true;
  rec({ event: "HARD_TIMEOUT" });
  closeInput();
}, 180000);

// Teardown debounce: close the input only after the stream goes quiet. Injected
// messages may spawn extra turns; closing on the first `result` would truncate the
// very data we're collecting. There is no trusted "conversation fully done" signal,
// so we end the experiment when no SDK message has arrived for DRAIN_MS. Must exceed
// the longest tool sleep (4s) so a mid-tool gap doesn't trip it.
const DRAIN_MS = 9000;
let drainTimer = null;
function bumpDrain() {
  if (inputClosed) return;
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    rec({ event: "DRAIN_IDLE_CLOSE" });
    closeInput();
  }, DRAIN_MS);
}

try {
  for await (const msg of q) {
    bumpDrain();
    if (msg.session_id) seenSessionIds.add(msg.session_id);

    if (msg.type === "system" && msg.subtype === "init") {
      rec({ event: "msg", type: "system", subtype: "init", session_id: msg.session_id });
    } else if (msg.type === "stream_event") {
      // SDKPartialAssistantMessage: carries the raw Anthropic stream event.
      const ev = msg.event;
      const entry = { event: "partial", raw_type: ev?.type, session_id: msg.session_id };
      if (ev?.type === "message_delta") entry.stop_reason = ev.delta?.stop_reason ?? null;
      if (ev?.type === "content_block_start") entry.block_type = ev.content_block?.type;
      rec(entry);
      if (ev?.type === "message_delta" && ev.delta?.stop_reason === "tool_use") {
        rec({ event: "BOUNDARY_tool_use_partial" });
      }
      if (scenario.triggerMode === "text" && !textTriggered && ev?.type === "content_block_delta") {
        textTriggered = true;
        rec({ event: "TEXT_TRIGGER" });
        injectAtBoundary(0);
      }
    } else if (msg.type === "assistant") {
      const blocks = msg.message?.content;
      const tools = Array.isArray(blocks) ? blocks.filter((b) => b.type === "tool_use") : [];
      const text = Array.isArray(blocks)
        ? blocks.filter((b) => b.type === "text").map((b) => b.text).join("")
        : blocks;
      rec({
        event: "msg",
        type: "assistant",
        session_id: msg.session_id,
        uuid: msg.uuid,
        parent_tool_use_id: msg.parent_tool_use_id,
        text: text || undefined,
        tool_uses: tools.map((t) => ({ id: t.id, name: t.name, input: t.input })),
      });
      if (tools.length && scenario.triggerMode !== "text") {
        toolBoundaryIdx++;
        injectAtBoundary(toolBoundaryIdx);
      }
    } else if (msg.type === "user") {
      const c = msg.message?.content;
      rec({
        event: "msg",
        type: "user",
        session_id: msg.session_id,
        uuid: msg.uuid,
        parent_tool_use_id: msg.parent_tool_use_id,
        priority: msg.priority ?? null,
        content: typeof c === "string" ? c : JSON.stringify(c)?.slice(0, 300),
      });
    } else if (msg.type === "result") {
      resultsSeen++;
      rec({
        event: "msg",
        type: "result",
        subtype: msg.subtype,
        is_error: msg.is_error,
        session_id: msg.session_id,
        result_text: msg.result,
      });
      rec({ event: "RESULT_BOUNDARY", count: resultsSeen });
      if (resultsSeen === 1 && scenario.followup && !followupSent) {
        followupSent = true;
        rec({ event: "FOLLOWUP_SEND", text: scenario.followup });
        pushToIterable(mkUserMsg(scenario.followup));
      }
    } else {
      rec({ event: "msg", type: msg.type, subtype: msg.subtype, session_id: msg.session_id });
    }
  }
} catch (e) {
  rec({ event: "ERROR", message: String(e?.message || e), stack: String(e?.stack || "").slice(0, 600) });
} finally {
  clearTimeout(HARD_TIMEOUT);
  if (drainTimer) clearTimeout(drainTimer);
}

rec({ event: "GENERATOR_ENDED", timedOut, session_ids: [...seenSessionIds] });

// ---- capture artifacts -----------------------------------------------------

writeFileSync(join(CAPTURES, `${label}-events.json`), JSON.stringify(log, null, 2));

// Copy every session JSONL we touched out of the isolated config dir, under
// stable names (<label>-session.jsonl, then -2, -3 … in first-seen order) so
// a rerun overwrites the previous capture instead of adding a file.
const projectsRoot = join(CONFIG_DIR, "projects");
const copied = [];
const projectDirs = existsSync(projectsRoot)
  ? readdirSync(projectsRoot).map((proj) => join(projectsRoot, proj))
  : [];
[...seenSessionIds].forEach((sid, index) => {
  const source = projectDirs.map((dir) => join(dir, `${sid}.jsonl`)).find(existsSync);
  if (!source) return;
  const target = `${label}-session${index === 0 ? "" : `-${index + 1}`}.jsonl`;
  copyFileSync(source, join(CAPTURES, target));
  copied.push(target);
});

console.log(`scenario=${label} results=${resultsSeen} sessions=${[...seenSessionIds].join(",")} copied=${copied.join(",")}`);
