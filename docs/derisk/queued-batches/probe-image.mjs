// Block-content variant of probe.mjs: how does the CLI merge a run whose
// members carry block-form content (clauctl prompt --image sends
// `[...images, {type: "text", text}]`)? Two long text turns; during the
// first, default-priority J1 (text), J2 (image + text), J3 (text) are pushed
// after the first stream_event (one merged next turn); during the second,
// L1 (image + text), L2 (text). LIVE (haiku, 4 calls). Artifacts in
// captures/image-*.

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
const CASE = "queued-batches-image";
const configDir = makeConfigDir(CASE);
const cwd = `/tmp/clauctl-cbi-derisk/${CASE}-cwd`;
fs.rmSync(cwd, { recursive: true, force: true });
fs.mkdirSync(cwd, { recursive: true });

// 1x1 red PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const image = () => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
});

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
let sessionId;
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
const stamped = {
  C: randomUUID(),
  J1: randomUUID(),
  J2: randomUUID(),
  J3: randomUUID(),
  D: randomUUID(),
  L1: randomUUID(),
  L2: randomUUID(),
};
const LONG =
  "Write the numbers 1 through 60 in words, separated by commas, nothing else.";

pushMsg(LONG, stamped.C);
await waitFor(isStreamEvent);
pushMsg("Reply ALPHA.", stamped.J1);
pushMsg(
  [image(), { type: "text", text: "What colour is this? Reply BETA." }],
  stamped.J2,
);
pushMsg("Reply GAMMA.", stamped.J3);
await waitFor(isResult); // C
await waitFor(isResult); // merged J

pushMsg(LONG, stamped.D);
await waitFor(isStreamEvent);
pushMsg(
  [image(), { type: "text", text: "What colour is this? Reply DELTA." }],
  stamped.L1,
);
pushMsg("Reply EPSILON.", stamped.L2);
await waitFor(isResult); // D
await waitFor(isResult); // merged L
closed = true;
if (resolveNext) resolveNext({ value: undefined, done: true });
await loop;

const jsonl = sessionFile(configDir, cwd, sessionId);
const entries = readJsonl(jsonl);
fs.copyFileSync(jsonl, `${EXP_DIR}/captures/image-session.jsonl`);
fs.writeFileSync(
  `${EXP_DIR}/captures/image-events.jsonl`,
  events.map((m) => JSON.stringify(m)).join("\n") + "\n",
);

const label = (uuid) =>
  Object.entries(stamped).find(([, u]) => u === uuid)?.[0] ?? uuid?.slice(0, 8);
const redactImage = (content) =>
  Array.isArray(content)
    ? content.map((b) =>
        b.type === "image"
          ? { ...b, source: { ...b.source, data: "<png>" } }
          : b,
      )
    : content;
const report = {
  sdk: versions.sdk,
  sessionId,
  stamped,
  userEntries: entries
    .filter((e) => e.type === "user")
    .map((e) => ({
      uuid: label(e.uuid),
      content: redactImage(e.message?.content),
    })),
  results: events.filter(isResult).length,
};
fs.writeFileSync(
  `${EXP_DIR}/captures/image-report.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
