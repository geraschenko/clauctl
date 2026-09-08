// Uuid-stamping probe: if the host sets `uuid` on a streamed SDKUserMessage,
// does the CLI persist the session-file `user` entry under that uuid? Feeds
// the session-tracker rewrite: a stamped uuid would let the daemon match its
// own submissions in the log instead of inferring placement.
//
// LIVE (haiku, ~4 calls). Three stamped prompts: A submitted idle, B queued
// while A's Bash turn runs (exercises the CLI queue path), C idle after.
// Artifacts in captures/: events.jsonl, session.jsonl, report.json.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  assertVersions, makeConfigDir, baseEnv, makeSession, readJsonl, sessionFile, HAIKU,
} from "../compact-boundary-injection/harness.mjs";

const EXP_DIR = path.dirname(fileURLToPath(import.meta.url));
const versions = assertVersions();
const CASE = "uuid-stamping";
const configDir = makeConfigDir(CASE);
const cwd = `/tmp/clauctl-cbi-derisk/${CASE}-cwd`;
fs.rmSync(cwd, { recursive: true, force: true });
fs.mkdirSync(cwd, { recursive: true });

const s = makeSession({
  model: HAIKU,
  cwd,
  allowedTools: ["Bash"],
  permissionMode: "auto",
  env: baseEnv(configDir),
});
const stamped = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
const events = [];

const turnA = s.send("Run `sleep 3; echo probe-one` as a Bash tool call, then reply with the single word DONE.", { uuid: stamped.A });
// Queue B while A's tool call is running (default priority → steer placement).
await new Promise((r) => setTimeout(r, 1500));
s.pushMsg("Also say the word QUEUED.", { uuid: stamped.B });
events.push(...(await turnA));
events.push(...(await s.send("Reply with exactly the word pong.", { uuid: stamped.C })));
s.endInput();
await s.done;

const sessionId = s.lastInit().session_id;
const jsonl = sessionFile(configDir, cwd, sessionId);
const entries = readJsonl(jsonl);
fs.copyFileSync(jsonl, `${EXP_DIR}/captures/session.jsonl`);
fs.writeFileSync(`${EXP_DIR}/captures/events.jsonl`, events.map((m) => JSON.stringify(m)).join("\n") + "\n");

const text = (e) => {
  const c = e.message?.content;
  return typeof c === "string" ? c : JSON.stringify(c)?.slice(0, 120);
};
const report = {
  sdk: versions.sdk,
  sessionId,
  stamped,
  fileEntriesWithStampedUuid: Object.fromEntries(
    Object.entries(stamped).map(([k, u]) => [k, entries.filter((e) => e.uuid === u).map((e) => ({ type: e.type, text: text(e) }))]),
  ),
  queryMessagesWithStampedUuid: Object.fromEntries(
    Object.entries(stamped).map(([k, u]) => [k, events.filter((m) => m.uuid === u).map((m) => m.type)]),
  ),
  fileUserEntries: entries.filter((e) => e.type === "user").map((e) => ({ uuid: e.uuid, isMeta: e.isMeta, text: text(e) })),
};
fs.writeFileSync(`${EXP_DIR}/captures/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
