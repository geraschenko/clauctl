// Phase 1e: field ablation — which boundary/summary fields are load-bearing for
// the resume relink? Baseline = p1 case B (worked). Each variant changes one thing.
//   1. no-metadata:        boundary without compactMetadata at all
//   2. empty-uuids:        preservedMessages present but uuids: []
//   3. no-summary-flag:    summary message without isCompactSummary
//   4. segment-only:       preservedSegment (old encoding) instead of preservedMessages
//   5. plain-content:      summary text without the "This session is being continued" boilerplate
//
// Success signature (from p1 case B): probe context = [summary, preserved "Red"
// assistant, probe]; first new write parents onto preserved tail 254029a1.

import {
  assertVersions, makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, readJsonl, EXP_DIR, HAIKU, projectKey,
} from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

assertVersions();
const CWD = "/tmp/clauctl-cbi-derisk/p0b-native-compact-cwd";
const SESSION_ID = "c4a1bb69-58cb-4e57-b5f9-7f7e27a9fe36";
const preContent = fs.readFileSync(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`, "utf8");
const preEntries = readJsonl(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`);
const chain = preEntries.filter((e) => e.uuid && (e.type === "user" || e.type === "assistant"));
const leaf = chain.at(-1);          // 254029a1 "Red"
const leafThinking = chain.at(-2);  // a6941d02 thinking

function buildFile({ metadata, summaryExtras, summaryText }) {
  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const boundary = {
    parentUuid: null, logicalParentUuid: leaf.uuid, isSidechain: false,
    type: "system", subtype: "compact_boundary", content: "Conversation compacted",
    isMeta: false, timestamp: new Date().toISOString(), uuid: boundaryUuid, level: "info",
    ...(metadata ? { compactMetadata: metadata(summaryUuid, boundaryUuid) } : {}),
    userType: "external", entrypoint: "sdk-cli", cwd: CWD, sessionId: SESSION_ID, version: "2.1.195", gitBranch: "HEAD",
  };
  const summary = {
    parentUuid: boundaryUuid, isSidechain: false, type: "user",
    message: { role: "user", content: summaryText },
    uuid: summaryUuid, timestamp: new Date().toISOString(),
    userType: "external", entrypoint: "sdk-cli", cwd: CWD, sessionId: SESSION_ID, version: "2.1.195", gitBranch: "HEAD",
    ...summaryExtras,
  };
  return preContent + JSON.stringify(boundary) + "\n" + JSON.stringify(summary) + "\n";
}

const BOILER = "This session is being continued from a previous conversation that ran out of context. Summary: arithmetic and color questions; fact.txt was read. (tag: SYNTH-SUMMARY)";
const fullMeta = (anchor) => ({
  trigger: "manual", preTokens: 40000, durationMs: 1, postTokens: 1000,
  preservedMessages: { anchorUuid: anchor, uuids: [leafThinking.uuid, leaf.uuid], allUuids: [leafThinking.uuid, leaf.uuid] },
});
const VARIANTS = {
  "1-no-metadata":    { metadata: null, summaryExtras: { isVisibleInTranscriptOnly: true, isCompactSummary: true }, summaryText: BOILER },
  "2-empty-uuids":    { metadata: (s) => ({ ...fullMeta(s), preservedMessages: { anchorUuid: s, uuids: [], allUuids: [] } }), summaryExtras: { isVisibleInTranscriptOnly: true, isCompactSummary: true }, summaryText: BOILER },
  "3-no-summary-flag":{ metadata: (s) => fullMeta(s), summaryExtras: {}, summaryText: BOILER },
  "4-segment-only":   { metadata: (s) => ({ trigger: "manual", preTokens: 40000, durationMs: 1, postTokens: 1000, preservedSegment: { headUuid: leafThinking.uuid, anchorUuid: s, tailUuid: leaf.uuid } }), summaryExtras: { isVisibleInTranscriptOnly: true, isCompactSummary: true }, summaryText: BOILER },
  "5-plain-content":  { metadata: (s) => fullMeta(s), summaryExtras: { isVisibleInTranscriptOnly: true, isCompactSummary: true }, summaryText: "Earlier in this session: arithmetic and color questions; fact.txt was read. (tag: SYNTH-SUMMARY)" },
};

const results = {};
for (const [name, v] of Object.entries(VARIANTS)) {
  const configDir = makeConfigDir(`p1e-${name}`);
  const dir = path.join(configDir, "projects", projectKey(CWD));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, buildFile(v));
  const preLines = readJsonl(file).length;
  const capture = `${EXP_DIR}/captures/p1e-${name}-requests.jsonl`;
  const shim = await startShim(capture);
  const s = makeSession({
    model: HAIKU, cwd: CWD, resume: SESSION_ID,
    env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
  });
  let error = null;
  const nonce = `NONCE-${name}`;
  try { await s.send(`Reply with exactly the word pong. (tag: ${nonce})`); } catch (e) { error = String(e); }
  s.close(); shim.kill();
  const probeReq = readCapturedInference(capture).find((r) => JSON.stringify(r.body.messages).includes(nonce));
  const msgs = probeReq?.body.messages ?? [];
  const str = JSON.stringify(msgs);
  const firstNewUser = readJsonl(file).slice(preLines).find((e) => e.type === "user" && JSON.stringify(e.message?.content ?? "").includes(nonce));
  results[name] = {
    error,
    nMessages: msgs.length,
    summaryPresent: str.includes("SYNTH-SUMMARY"),
    preservedRedPresent: str.includes('"text":"Red"'),
    parentIsPreservedTail: firstNewUser?.parentUuid === leaf.uuid,
    firstNewUserParent: firstNewUser?.parentUuid?.slice(0, 8),
    relinked: str.includes('"text":"Red"') && firstNewUser?.parentUuid === leaf.uuid,
  };
  console.log(name, JSON.stringify(results[name]));
}
fs.writeFileSync(`${EXP_DIR}/captures/p1e-report.json`, JSON.stringify(results, null, 2));
