// P10: empty preserved list (tui-tree derisk R1).
//
// The TUI /tree "rewind to the first user message" pick decomposes to a
// set-context with an EMPTY preserved list — a no-summary boundary whose
// preservedMessages.uuids is []. P1e established that emptying uuids kills
// the relink, but every tested skipped-relink shape had a summary entry to
// fall back on (context = summary only). A bare trailing boundary with
// uuids: [] has never been resumed live. Two plausible outcomes:
//   - the loader honors the boundary as a context reset → empty context,
//     first new write parents on the boundary (or null): new-root works;
//   - the loader ignores the summary-less boundary and walks back to the
//     previous dangling leaf → old context reinstated: new-root is a no-op
//     and the feature must be refused.
//
// Boundary shape matches what session-file.ts buildBoundaryEntries would
// write for uuids: [] with anchor "boundary" and no summaryText (anchorUuid
// = the boundary's own uuid). Oracle as always: the captured outbound probe
// request + the parentUuid of the first new write. Exploratory expectations:
// violations are reported in the JSON and fail the process exit code.
//
// Needs only the checked-in captures/p1-fixture-pre.jsonl. SDK is NOT the
// 0.3.195 pin the p0-p9 reports were generated against; the actual version
// is recorded in the report instead.

import {
  makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, readJsonl, EXP_DIR, REPO_DIR, projectKey, HAIKU,
} from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const sdkVersion = JSON.parse(fs.readFileSync(
  path.join(REPO_DIR, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version;
const cwd = "/tmp/clauctl-cbi-derisk/p0b-native-compact-cwd";
const sessionId = "c4a1bb69-58cb-4e57-b5f9-7f7e27a9fe36";
const P1_CONTENT = fs.readFileSync(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`, "utf8");

// Full uuids resolved from 8-char prefixes recorded in WORK-LOG.
const U = { u1User: "815b1fad", magic: "7844a932", u2User: "d6c57604", thinkU2: "9f8ab726",
  four: "d16f84b0", u3User: "1a44a1ac", thinkU3: "a6941d02", red: "254029a1" };
{
  const byPrefix = Object.fromEntries(readJsonl(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`)
    .filter((e) => e.uuid).map((e) => [e.uuid.slice(0, 8), e.uuid]));
  for (const k of Object.keys(U)) U[k] = byPrefix[U[k]];
}

const boundaryUuid = randomUUID();
const emptyBoundary = JSON.stringify({
  isSidechain: false, timestamp: new Date().toISOString(), userType: "external",
  entrypoint: "sdk-cli", cwd, sessionId, version: "2.1.195", gitBranch: "HEAD",
  parentUuid: null, logicalParentUuid: U.red, type: "system", subtype: "compact_boundary",
  content: "Conversation compacted", isMeta: false, uuid: boundaryUuid, level: "info",
  compactMetadata: {
    trigger: "manual", preTokens: 40000, durationMs: 1, postTokens: 1000,
    preservedMessages: { anchorUuid: boundaryUuid, uuids: [], allUuids: [] },
  },
}) + "\n";

// Markers from the fixture conversation; NONE should reach the probe request.
const MARKERS = {
  u1Tag: "NONCE-U1", magicWord: "XYLOPHONE-77431", u2Tag: "NONCE-U2",
  four: '"text":"4"', u3Tag: "NONCE-U3", red: '"text":"Red"',
};
const NONCE = "NONCE-P10";

const configDir = makeConfigDir("p10-empty");
const projDir = path.join(configDir, "projects", projectKey(cwd));
fs.mkdirSync(projDir, { recursive: true });
const file = path.join(projDir, `${sessionId}.jsonl`);
fs.writeFileSync(file, P1_CONTENT + emptyBoundary);
const preLines = readJsonl(file).length;
const capture = `${EXP_DIR}/captures/p10-empty-requests.jsonl`;
const shim = await startShim(capture);
let stderrBuf = "";
const s = makeSession({
  model: HAIKU, cwd, resume: sessionId,
  stderr: (d) => { stderrBuf += d; },
  env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
});
let error = null, resultSubtype = null;
try {
  const msgs = await s.send(`Reply with exactly the word pong. (tag: ${NONCE})`);
  resultSubtype = msgs.find((m) => m.type === "result")?.subtype;
} catch (e) { error = String(e); }
s.close();
shim.kill();

const inference = fs.existsSync(capture) ? readCapturedInference(capture) : [];
const probeReq = inference.find((r) => JSON.stringify(r.body.messages).includes(NONCE));
const reqStr = probeReq ? JSON.stringify(probeReq.body.messages) : "";
const postEntries = fs.existsSync(file) ? readJsonl(file) : [];
const newUser = postEntries.slice(preLines)
  .find((e) => e.type === "user" && JSON.stringify(e.message?.content ?? "").includes(NONCE));

const violations = [];
if (error) violations.push(`error: ${error}`);
if (resultSubtype !== "success") violations.push(`result subtype ${resultSubtype}`);
if (!probeReq) violations.push("no probe request captured");
for (const [k, v] of Object.entries(MARKERS))
  if (reqStr.includes(v)) violations.push(`old context reached the request: ${k}`);
if (newUser !== undefined && newUser.parentUuid !== boundaryUuid && newUser.parentUuid !== null)
  violations.push(`new write parent ${newUser?.parentUuid?.slice(0, 8)} is neither the boundary nor null`);

const report = {
  sdkVersion, resultSubtype, error, stderr: stderrBuf.trim().slice(0, 300) || null,
  nRequestMessages: probeReq?.body.messages.length ?? null,
  requestMessages: probeReq ? probeReq.body.messages.map((m) =>
    `${m.role}: ${JSON.stringify(m.content).slice(0, 120)}`) : null,
  markerPresence: Object.fromEntries(Object.entries(MARKERS).map(([k, v]) => [k, reqStr.includes(v)])),
  boundaryUuid: boundaryUuid.slice(0, 8),
  firstNewUserParent: newUser?.parentUuid?.slice(0, 8) ?? null,
  violations,
};
console.log(JSON.stringify(report, null, 2));
fs.writeFileSync(`${EXP_DIR}/captures/p10-report.json`, JSON.stringify(report, null, 2));
console.log(violations.length ? `VIOLATIONS:\n${violations.join("\n")}` : "PASS — empty-context resume works");
if (violations.length) process.exitCode = 1;
console.log("report at captures/p10-report.json");
