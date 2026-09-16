// Queued-batch probe: when several stamped prompts are queued at once, how
// does the CLI record the batch on the session file and the query stream?
// Feeds docs/specs/query-pending-list.md (pending-item identity for merged
// buckets): which uuid a coalesced turn entry carries, whether coalesced
// steers become one `queued_command` attachment or several, and which
// members get `command_lifecycle` frames.
//
// LIVE (haiku, ~12 calls), includePartialMessages like the daemon.
// Turn A runs `sleep 4`; S1..S3 are pushed while the tool runs (default
// priority → absorbed at the tool result, "steer"). Turn C is a long text
// reply; T1..T3 are pushed after its first stream_event (no tool result
// follows → one merged next turn). D1, D2 (shouldQuery:false) and D3 are
// submitted idle, each after the previous one's lifecycle completes;
// E1, E2 (shouldQuery:false) and E3 are submitted idle back to back. Turn
// F runs `sleep 4`; M1 (later), M2 (later, shouldQuery:false), M3 (later)
// are pushed while the tool runs (a `later` bucket with an append member).
// Controls: turn G runs `sleep 4` with G1..G3 all `later` (pure `later`
// bucket); turn I is a long text reply with H1, H2 (shouldQuery:false), H3
// default pushed after its first stream_event (default bucket with an
// append member); turn K runs `sleep 4` with K1, K2 `later`, K3 `later`
// + shouldQuery:false, K4 `later` (does an append split runs or disable
// merging?). Artifacts in captures/.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { query } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import {
  assertVersions,
  makeConfigDir,
  baseEnv,
  readJsonl,
  sessionFile,
  HAIKU,
} from "../compact-boundary-injection/harness.mjs";

const EXP_DIR = path.dirname(fileURLToPath(import.meta.url));
const versions = assertVersions();
const CASE = "queued-batches";
const configDir = makeConfigDir(CASE);
const cwd = `/tmp/clauctl-cbi-derisk/${CASE}-cwd`;
fs.rmSync(cwd, { recursive: true, force: true });
fs.mkdirSync(cwd, { recursive: true });

// Input stream driven by pushMsg; `waitFor` resolves on the first message
// matching a predicate so pushes can be timed against the live stream.
const pending = [];
let resolveNext = null;
let closed = false;
const input = {
  [Symbol.asyncIterator]() {
    return {
      next() {
        if (pending.length)
          return Promise.resolve({ value: pending.shift(), done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => {
          resolveNext = res;
        });
      },
    };
  },
};
const pushMsg = (text, uuid, extra = {}) => {
  const m = {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid,
    ...extra,
  };
  if (resolveNext) {
    const r = resolveNext;
    resolveNext = null;
    r({ value: m, done: false });
  } else pending.push(m);
};
const waiters = [];
const waitFor = (predicate) =>
  new Promise((res) => waiters.push({ predicate, res }));
const events = [];
let sessionId;
const q = query({
  prompt: input,
  options: {
    model: HAIKU,
    cwd,
    allowedTools: ["Bash(sleep:*)"],
    permissionMode: "dontAsk",
    includePartialMessages: true,
    env: baseEnv(configDir),
  },
});
const loop = (async () => {
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init")
      sessionId = msg.session_id;
    events.push(msg);
    for (const w of [...waiters]) {
      if (w.predicate(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.res(msg);
      }
    }
  }
})();

const isResult = (m) => m.type === "result";
const stamped = {
  A: randomUUID(),
  S1: randomUUID(),
  S2: randomUUID(),
  S3: randomUUID(),
  C: randomUUID(),
  T1: randomUUID(),
  T2: randomUUID(),
  T3: randomUUID(),
  D1: randomUUID(),
  D2: randomUUID(),
  D3: randomUUID(),
  E1: randomUUID(),
  E2: randomUUID(),
  E3: randomUUID(),
  F: randomUUID(),
  M1: randomUUID(),
  M2: randomUUID(),
  M3: randomUUID(),
  G: randomUUID(),
  G1: randomUUID(),
  G2: randomUUID(),
  G3: randomUUID(),
  I: randomUUID(),
  H1: randomUUID(),
  H2: randomUUID(),
  H3: randomUUID(),
  K: randomUUID(),
  K1: randomUUID(),
  K2: randomUUID(),
  K3: randomUUID(),
  K4: randomUUID(),
};
const completed = (uuid) =>
  waitFor(
    (m) =>
      m.type === "command_lifecycle" &&
      m.command_uuid === uuid &&
      m.state === "completed",
  );
const isToolUse = (m) =>
  m.type === "assistant" &&
  Array.isArray(m.message.content) &&
  m.message.content.some((b) => b.type === "tool_use");
// An idle append may emit no lifecycle frames; the guard keeps the probe
// from hanging on that unknown (it is part of what the probe measures).
const completedOrGuard = (uuid) =>
  Promise.race([
    waitFor(
      (m) =>
        m.type === "command_lifecycle" &&
        m.command_uuid === uuid &&
        m.state === "completed",
    ),
    new Promise((res) => setTimeout(() => res("guard"), 5000)),
  ]);

pushMsg(
  "Run `sleep 4` as a Bash tool call, then reply with the single word DONE.",
  stamped.A,
);
await waitFor(isToolUse);
pushMsg("Steer one: also say ONE.", stamped.S1);
pushMsg("Steer two: also say TWO.", stamped.S2);
pushMsg("Steer three: also say THREE.", stamped.S3);
await waitFor(isResult);

pushMsg(
  "Write the numbers 1 through 60 in words, separated by commas, nothing else.",
  stamped.C,
);
await waitFor((m) => m.type === "stream_event");
pushMsg("Turn one: reply with the word ALPHA.", stamped.T1);
pushMsg("Turn two: reply with the word BETA.", stamped.T2);
pushMsg("Turn three: reply with the word GAMMA.", stamped.T3);
await waitFor(isResult); // C's result
await waitFor(isResult); // the merged T turn's result

const APPEND = { shouldQuery: false };
pushMsg("Append one: note the word DELTA.", stamped.D1, APPEND);
const d1 = await completedOrGuard(stamped.D1);
pushMsg("Append two: note the word EPSILON.", stamped.D2, APPEND);
const d2 = await completedOrGuard(stamped.D2);
pushMsg("Turn: reply with the two words you were told to note.", stamped.D3);
await waitFor(isResult);

pushMsg("Append three: note the word ZETA.", stamped.E1, APPEND);
pushMsg("Append four: note the word ETA.", stamped.E2, APPEND);
pushMsg(
  "Turn: reply with the two words you were just told to note.",
  stamped.E3,
);
await waitFor(isResult);

pushMsg(
  "Run `sleep 4` as a Bash tool call, then reply with the single word DONE.",
  stamped.F,
);
await waitFor(isToolUse);
pushMsg("Later one: reply with the word THETA.", stamped.M1, {
  priority: "later",
});
pushMsg("Later two: note the word IOTA.", stamped.M2, {
  priority: "later",
  ...APPEND,
});
pushMsg("Later three: reply with the word KAPPA.", stamped.M3, {
  priority: "later",
});
await completed(stamped.M3);

pushMsg(
  "Run `sleep 4` as a Bash tool call, then reply with the single word DONE.",
  stamped.G,
);
await waitFor(isToolUse);
const LATER = { priority: "later" };
pushMsg("Later four: reply with the word LAMBDA.", stamped.G1, LATER);
pushMsg("Later five: reply with the word MU.", stamped.G2, LATER);
pushMsg("Later six: reply with the word NU.", stamped.G3, LATER);
await completed(stamped.G3);

pushMsg(
  "Write the numbers 1 through 60 in words, separated by commas, nothing else.",
  stamped.I,
);
await waitFor((m) => m.type === "stream_event");
pushMsg("Turn four: reply with the word XI.", stamped.H1);
pushMsg("Note the word OMICRON.", stamped.H2, APPEND);
pushMsg("Turn five: reply with the word PI.", stamped.H3);
await completed(stamped.H3);

pushMsg(
  "Run `sleep 4` as a Bash tool call, then reply with the single word DONE.",
  stamped.K,
);
await waitFor(isToolUse);
pushMsg("Later seven: reply with the word RHO.", stamped.K1, LATER);
pushMsg("Later eight: reply with the word SIGMA.", stamped.K2, LATER);
pushMsg("Note the word TAU.", stamped.K3, { ...LATER, ...APPEND });
pushMsg("Later nine: reply with the word UPSILON.", stamped.K4, LATER);
await completed(stamped.K4);
closed = true;
if (resolveNext) resolveNext({ value: undefined, done: true });
await loop;

const jsonl = sessionFile(configDir, cwd, sessionId);
const entries = readJsonl(jsonl);
fs.copyFileSync(jsonl, `${EXP_DIR}/captures/session.jsonl`);
fs.writeFileSync(
  `${EXP_DIR}/captures/events.jsonl`,
  events.map((m) => JSON.stringify(m)).join("\n") + "\n",
);

const label = (uuid) =>
  Object.entries(stamped).find(([, u]) => u === uuid)?.[0] ?? uuid?.slice(0, 8);
const text = (e) => {
  const c = e.message?.content;
  return typeof c === "string" ? c : JSON.stringify(c)?.slice(0, 160);
};
const report = {
  sdk: versions.sdk,
  sessionId,
  stamped,
  idleAppendLifecycle: {
    D1: d1 === "guard" ? "no completed frame" : "completed",
    D2: d2 === "guard" ? "no completed frame" : "completed",
  },
  fileEntries: entries
    .filter(
      (e) =>
        e.type === "user" ||
        e.type === "attachment" ||
        e.type === "queue-operation",
    )
    .map((e) => ({
      type: e.type,
      uuid: label(e.uuid),
      attachment: e.attachment?.type,
      source_uuid: e.attachment?.source_uuid && label(e.attachment.source_uuid),
      operation: e.operation,
      reason: e.reason,
      text:
        e.type === "user"
          ? text(e)
          : e.attachment?.type === "queued_command"
            ? JSON.stringify(e.attachment).slice(0, 300)
            : undefined,
    })),
  commandLifecycle: events
    .filter((m) => m.type === "command_lifecycle")
    .map((m) => ({ command: label(m.command_uuid), state: m.state })),
  queryUserMessages: events
    .filter((m) => m.type === "user")
    .map((m) => ({ uuid: label(m.uuid), text: text(m) })),
};
fs.writeFileSync(
  `${EXP_DIR}/captures/report.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
