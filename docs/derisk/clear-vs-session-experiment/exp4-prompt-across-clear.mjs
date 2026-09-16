// Where does a stamped prompt land when it is submitted right behind
// `/clear`? Feeds docs/specs/query-pending-list.md: the fold attributes a
// dequeued prompt to `querySessionId`, which only moves at the new
// session's `system:init` — is there a window in which the prompt is
// dequeued (its `result` seen) before that init?
//
// LIVE (haiku, ~3 calls). Turn A; then `/clear` (stamped) and B pushed
// back to back; then, after the new init, C. Records the query-stream order
// (type/subtype/session_id, conversation_reset ids, command_lifecycle) and
// which session file holds each stamped uuid.

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
const CASE = "clear-prompt-window";
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
const pushMsg = (content, uuid) => {
  const m = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid,
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
const sessionIds = [];
const q = query({
  prompt: input,
  options: {
    model: HAIKU,
    cwd,
    permissionMode: "dontAsk",
    includePartialMessages: true,
    env: baseEnv(configDir),
  },
});
const loop = (async () => {
  for await (const msg of q) {
    if (
      msg.type === "system" &&
      msg.subtype === "init" &&
      !sessionIds.includes(msg.session_id)
    )
      sessionIds.push(msg.session_id);
    events.push(msg);
    for (const w of [...waiters]) {
      if (w.predicate(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.res(msg);
      }
    }
  }
})();

const stamped = {
  A: randomUUID(),
  CLEAR: randomUUID(),
  B: randomUUID(),
  C: randomUUID(),
};
const completed = (uuid) =>
  waitFor(
    (m) =>
      m.type === "command_lifecycle" &&
      m.command_uuid === uuid &&
      m.state === "completed",
  );

pushMsg("Reply ALPHA.", stamped.A);
await completed(stamped.A);
pushMsg("/clear", stamped.CLEAR);
pushMsg("Reply BETA.", stamped.B);
await completed(stamped.B);
pushMsg("Reply GAMMA.", stamped.C);
await completed(stamped.C);
closed = true;
if (resolveNext) resolveNext({ value: undefined, done: true });
await loop;

const label = (uuid) =>
  Object.entries(stamped).find(([, u]) => u === uuid)?.[0] ?? uuid?.slice(0, 8);
const sessionLabel = (id) => {
  const i = sessionIds.indexOf(id);
  return i === -1 ? id?.slice(0, 8) : `S${i + 1}`;
};
const files = Object.fromEntries(
  sessionIds.map((id, i) => {
    const jsonl = sessionFile(configDir, cwd, id);
    const entries = fs.existsSync(jsonl) ? readJsonl(jsonl) : [];
    fs.copyFileSync(jsonl, `${EXP_DIR}/captures/exp4-S${i + 1}.jsonl`);
    return [
      `S${i + 1}`,
      entries
        .filter((e) => e.type === "user" || e.type === "queue-operation")
        .map((e) => ({
          type: e.type,
          uuid: label(e.uuid),
          operation: e.operation,
          text:
            typeof e.message?.content === "string"
              ? e.message.content.slice(0, 60)
              : undefined,
        })),
    ];
  }),
);
const report = {
  sdk: versions.sdk,
  sessionIds,
  stamped,
  stream: events
    .filter((m) => m.type !== "stream_event")
    .map((m) => ({
      type: m.subtype ? `${m.type}/${m.subtype}` : m.type,
      session: sessionLabel(m.session_id),
      ...(m.type === "command_lifecycle" && {
        command: label(m.command_uuid),
        state: m.state,
      }),
      ...(m.type === "conversation_reset" && {
        new_conversation_id: sessionLabel(m.new_conversation_id),
      }),
      ...(m.type === "user" && {
        text:
          typeof m.message?.content === "string"
            ? m.message.content.slice(0, 60)
            : "[blocks]",
      }),
    })),
  files,
};
fs.writeFileSync(
  `${EXP_DIR}/captures/exp4-events.jsonl`,
  events.map((m) => JSON.stringify(m)).join("\n") + "\n",
);
fs.writeFileSync(
  `${EXP_DIR}/captures/exp4-report.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
