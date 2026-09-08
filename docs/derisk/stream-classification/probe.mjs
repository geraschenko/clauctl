// Stream-classification probe: for every uuid-bearing class on the query
// stream and in the session log, does the other side carry the same uuid?
// Feeds the classification table in docs/specs/session-tracker.md.
//
// LIVE (haiku, ~10 calls). One session: a Bash tool turn (PostToolUse + Stop
// hooks configured → hook messages / stop_hook_summary), a local slash
// command (/cost → local_command), /compact (compact_boundary + summary),
// a final plain turn. Artifacts in captures/: events.jsonl (every SDK
// message, full), session.jsonl (the CLI's file), report.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertVersions, makeConfigDir, baseEnv, makeSession, readJsonl, sessionFile, HAIKU,
} from "../compact-boundary-injection/harness.mjs";

const EXP_DIR = path.dirname(fileURLToPath(import.meta.url));
const versions = assertVersions();
const CASE = "stream-classification";
const hook = { hooks: [{ type: "command", command: "echo hook-ran" }] };
const configDir = makeConfigDir(CASE, {
  hooks: { PostToolUse: [{ matcher: "Bash", ...hook }], Stop: [hook] },
});
const cwd = `/tmp/clauctl-cbi-derisk/${CASE}-cwd`;
fs.rmSync(cwd, { recursive: true, force: true });
fs.mkdirSync(cwd, { recursive: true });

const s = makeSession({
  model: HAIKU,
  cwd,
  allowedTools: ["Bash"],
  permissionMode: "auto",
  includePartialMessages: true,
  env: baseEnv(configDir),
});
const events = [];
const capture = (msgs) => events.push(...msgs);

capture(await s.send("Run `echo probe-one` as a Bash tool call, then reply with the single word DONE."));
capture(await s.send("/cost"));
capture(await s.send("What is 2+2? Answer with just the number."));
capture(await s.send("/compact"));
capture(await s.send("Reply with exactly the word pong."));
s.endInput();
await s.done;

const sessionId = s.lastInit().session_id;
const jsonl = sessionFile(configDir, cwd, sessionId);
const entries = readJsonl(jsonl);
fs.copyFileSync(jsonl, `${EXP_DIR}/captures/session.jsonl`);
fs.writeFileSync(`${EXP_DIR}/captures/events.jsonl`, events.map((m) => JSON.stringify(m)).join("\n") + "\n");

const cls = (m) => `${m.type}/${m.subtype ?? "-"}`;
const fileByUuid = new Map(entries.filter((e) => e.uuid).map((e) => [e.uuid, e]));
const queryByUuid = new Map(events.filter((m) => m.uuid).map((m) => [m.uuid, m]));
const tally = {};
const bump = (side, klass, verdict) => {
  const k = `${side} ${klass}`;
  tally[k] ??= {};
  tally[k][verdict] = (tally[k][verdict] ?? 0) + 1;
};
for (const m of events) {
  if (!m.uuid) { bump("query", cls(m), "no-uuid"); continue; }
  const e = fileByUuid.get(m.uuid);
  bump("query", cls(m), e ? `shared-with ${cls(e)}` : "query-only");
}
for (const e of entries) {
  if (!e.uuid) { bump("session", cls(e), "no-uuid"); continue; }
  const m = queryByUuid.get(e.uuid);
  bump("session", cls(e), m ? `shared-with ${cls(m)}` : "session-only");
}
const report = { sdk: versions.sdk, sessionId, tally };
fs.writeFileSync(`${EXP_DIR}/captures/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
