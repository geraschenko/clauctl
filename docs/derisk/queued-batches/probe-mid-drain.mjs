// Mid-drain variant of probe.mjs: a `later` bucket with an append member
// drains one run per `result` (probe.mjs case K), so the turn of run 1 is
// a window in which a higher-priority prompt can arrive. Does it cut ahead
// of the bucket's remaining runs, or does the bucket finish first?
//
// Turn P runs `sleep 4`; P1 (later), P2 (later, shouldQuery:false), P3
// (later) are pushed while the tool runs. After P's result, N0 (default
// priority) is pushed at the first stream_event of P1's turn. Turn R
// repeats the shape with R0 at priority `now` (does `now` also interrupt
// the running turn?). LIVE (haiku, ~8 calls). Artifacts in
// captures/mid-drain-*.

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
const CASE = "queued-batches-mid-drain";
const configDir = makeConfigDir(CASE);
const cwd = `/tmp/clauctl-cbi-derisk/${CASE}-cwd`;
fs.rmSync(cwd, { recursive: true, force: true });
fs.mkdirSync(cwd, { recursive: true });

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
const isStreamEvent = (m) => m.type === "stream_event";
const isToolUse = (m) =>
  m.type === "assistant" &&
  Array.isArray(m.message.content) &&
  m.message.content.some((b) => b.type === "tool_use");
const completed = (uuid) =>
  waitFor(
    (m) =>
      m.type === "command_lifecycle" &&
      m.command_uuid === uuid &&
      m.state === "completed",
  );
const stamped = {
  P: randomUUID(),
  P1: randomUUID(),
  P2: randomUUID(),
  P3: randomUUID(),
  N0: randomUUID(),
  R: randomUUID(),
  R1: randomUUID(),
  R2: randomUUID(),
  R3: randomUUID(),
  R0: randomUUID(),
};
const SLEEP =
  "Run `sleep 4` as a Bash tool call, then reply with the single word DONE.";
const LATER = { priority: "later" };
const APPEND = { shouldQuery: false };

pushMsg(SLEEP, stamped.P);
await waitFor(isToolUse);
pushMsg("Later one: reply with the word ALPHA.", stamped.P1, LATER);
pushMsg("Note the word BETA.", stamped.P2, { ...LATER, ...APPEND });
pushMsg("Later two: reply with the word GAMMA.", stamped.P3, LATER);
await waitFor(isResult); // P's result: P1 dequeued
await waitFor(isStreamEvent); // P1's turn is running
pushMsg("Default: reply with the word DELTA.", stamped.N0);
await Promise.all([completed(stamped.N0), completed(stamped.P3)]);

pushMsg(SLEEP, stamped.R);
await waitFor(isToolUse);
pushMsg("Later three: reply with the word EPSILON.", stamped.R1, LATER);
pushMsg("Note the word ZETA.", stamped.R2, { ...LATER, ...APPEND });
pushMsg("Later four: reply with the word ETA.", stamped.R3, LATER);
await waitFor(isResult); // R's result: R1 dequeued
await waitFor(isStreamEvent); // R1's turn is running
pushMsg("Now: reply with the word THETA.", stamped.R0, { priority: "now" });
await Promise.all([completed(stamped.R0), completed(stamped.R3)]);
closed = true;
if (resolveNext) resolveNext({ value: undefined, done: true });
await loop;

const jsonl = sessionFile(configDir, cwd, sessionId);
const entries = readJsonl(jsonl);
fs.copyFileSync(jsonl, `${EXP_DIR}/captures/mid-drain-session.jsonl`);
fs.writeFileSync(
  `${EXP_DIR}/captures/mid-drain-events.jsonl`,
  events.map((m) => JSON.stringify(m)).join("\n") + "\n",
);

const label = (uuid) =>
  Object.entries(stamped).find(([, u]) => u === uuid)?.[0] ?? uuid?.slice(0, 8);
const text = (e) => {
  const c = e.message?.content;
  return typeof c === "string"
    ? c
    : c
        ?.map((b) => b.type + (b.text ? `:${b.text.slice(0, 40)}` : ""))
        .join(" | ");
};
const report = {
  sdk: versions.sdk,
  sessionId,
  stamped,
  // User and assistant rows in file order: where each prompt landed
  // relative to the bucket's runs and the assistant turns between them.
  fileOrder: entries
    .filter(
      (e) =>
        e.type === "user" ||
        e.type === "assistant" ||
        e.type === "queue-operation",
    )
    .map((e) => ({
      type: e.type,
      uuid: e.type === "queue-operation" ? undefined : label(e.uuid),
      operation: e.operation,
      text: e.type === "queue-operation" ? undefined : text(e),
    })),
  commandLifecycle: events
    .filter((m) => m.type === "command_lifecycle")
    .map((m) => ({ command: label(m.command_uuid), state: m.state })),
  results: events.filter(isResult).length,
};
fs.writeFileSync(
  `${EXP_DIR}/captures/mid-drain-report.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
