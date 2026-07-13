// Phase 3: adversarial/malformed preserved sets (README Q2b). For each case we
// distinguish LOADER acceptance (does the relink happen), API acceptance (HTTP
// status of the probe request), and semantic usability (what the context is).
//
// All on the p1 fixture (U1 tool-turn / U2 "4" / U3 "Red"):
//   m1-orphan-tool-use:    preserved keeps the tool_use but drops its tool_result
//   m2-orphan-tool-result: preserved starts at a tool_result with no tool_use
//   m3-reordered:          U3 turn listed BEFORE U2 turn (valid role alternation,
//                          wrong chronology) — does context follow list order?
//   m4-duplicate:          same uuids listed twice
//   m5-stacked:            two boundary+summary pairs appended in sequence
//   m6-trailing:           valid boundary followed by trailing non-message entries
//   m7-attachment-uuid:    preserved list includes an attachment entry's uuid

import {
  assertVersions, makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, readJsonl, EXP_DIR, HAIKU, projectKey,
} from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const versions = assertVersions();

const P1 = {
  cwd: "/tmp/clauctl-cbi-derisk/p0b-native-compact-cwd",
  sessionId: "c4a1bb69-58cb-4e57-b5f9-7f7e27a9fe36",
  content: fs.readFileSync(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`, "utf8"),
  attach1: "3f352aec",
  u1User: "815b1fad", think2: "59e71878", tool2: "64aae3ff", result2: "87c8b882",
  think3: "5c67b617", magic: "7844a932",
  u2User: "d6c57604", thinkU2: "9f8ab726", four: "d16f84b0",
  u3User: "1a44a1ac", thinkU3: "a6941d02", red: "254029a1",
};
{
  const entries = readJsonl(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`);
  const byPrefix = Object.fromEntries(entries.filter((e) => e.uuid).map((e) => [e.uuid.slice(0, 8), e.uuid]));
  for (const [k, v] of Object.entries(P1)) if (byPrefix[v]) P1[k] = byPrefix[v];
}

function mkPair({ uuids, summaryText, logicalParent = P1.red }) {
  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const boundary = {
    parentUuid: null, logicalParentUuid: logicalParent, isSidechain: false,
    type: "system", subtype: "compact_boundary", content: "Conversation compacted",
    isMeta: false, timestamp: new Date().toISOString(), uuid: boundaryUuid, level: "info",
    compactMetadata: {
      trigger: "manual", preTokens: 40000, durationMs: 1, postTokens: 1000,
      preservedMessages: { anchorUuid: summaryUuid, uuids, allUuids: uuids },
    },
    userType: "external", entrypoint: "sdk-cli", cwd: P1.cwd, sessionId: P1.sessionId, version: "2.1.195", gitBranch: "HEAD",
  };
  const summary = {
    parentUuid: boundaryUuid, isSidechain: false, type: "user",
    message: { role: "user", content: summaryText },
    isVisibleInTranscriptOnly: true, isCompactSummary: true,
    uuid: summaryUuid, timestamp: new Date().toISOString(),
    userType: "external", entrypoint: "sdk-cli", cwd: P1.cwd, sessionId: P1.sessionId, version: "2.1.195", gitBranch: "HEAD",
  };
  return { boundary, summary, boundaryUuid, summaryUuid };
}
const asLines = (...entries) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

const MARKERS = {
  u1Tag: "NONCE-U1", magicWord: "XYLOPHONE-77431", u2Tag: "NONCE-U2)", four: '"text":"4"',
  u3Tag: "NONCE-U3", red: '"text":"Red"', toolUse: '"tool_use"', toolResult: '"tool_result"',
  synth1: "SYNTH-P3-ONE", synth2: "SYNTH-P3-TWO",
};

async function runCase(name, jsonlContent, probeNonce) {
  const configDir = makeConfigDir(`p3-${name}`);
  const projDir = path.join(configDir, "projects", projectKey(P1.cwd));
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, `${P1.sessionId}.jsonl`);
  fs.writeFileSync(file, jsonlContent);
  const preLines = readJsonl(file).length;
  const capture = `${EXP_DIR}/captures/p3-${name}-requests.jsonl`;
  const shim = await startShim(capture);
  let stderrBuf = "";
  const s = makeSession({
    model: HAIKU, cwd: P1.cwd, resume: P1.sessionId,
    stderr: (d) => { stderrBuf += d; },
    env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
  });
  let error = null;
  let resultSubtype = null;
  try {
    const msgs = await s.send(`Reply with exactly the word pong. (tag: ${probeNonce})`);
    resultSubtype = msgs.find((m) => m.type === "result")?.subtype;
  } catch (e) { error = String(e); }
  s.close();
  shim.kill();

  const inference = fs.existsSync(capture) ? readCapturedInference(capture) : [];
  const probeReqs = inference.filter((r) => JSON.stringify(r.body.messages).includes(probeNonce));
  const probeReq = probeReqs.at(-1);
  let probe = "NO PROBE REQUEST CAPTURED";
  if (probeReq) {
    const msgs = probeReq.body.messages;
    const idxOf = (needle) => msgs.findIndex((m) => JSON.stringify(m).includes(needle));
    probe = {
      nMessages: msgs.length,
      roles: msgs.map((m) => m.role).join(","),
      markerIdx: Object.fromEntries(Object.entries(MARKERS).map(([k, v]) => [k, idxOf(v)])),
      probeIdx: idxOf(probeNonce),
    };
  }
  const firstNewUser = readJsonl(file).slice(preLines)
    .find((e) => e.type === "user" && JSON.stringify(e.message?.content ?? "").includes(probeNonce));
  const result = {
    name, error, resultSubtype,
    stderr: stderrBuf.trim().slice(0, 300) || null,
    apiStatuses: inference.map((r) => r.status),
    probeAttempts: probeReqs.length,
    probe,
    firstNewUserParent: firstNewUser?.parentUuid?.slice(0, 8) ?? null,
  };
  console.log(JSON.stringify(result));
  return result;
}

const report = { versions };

// m1: tool_use kept, its tool_result dropped
{
  const p = mkPair({ uuids: [P1.think2, P1.tool2, P1.think3, P1.magic, P1.u3User, P1.thinkU3, P1.red],
    summaryText: "Earlier context omitted. (tag: SYNTH-P3-ONE)" });
  report.m1 = await runCase("m1-orphan-tool-use", P1.content + asLines(p.boundary, p.summary), "NONCE-P3M1");
}

// m2: tool_result kept, its tool_use dropped
{
  const p = mkPair({ uuids: [P1.result2, P1.think3, P1.magic, P1.u3User, P1.thinkU3, P1.red],
    summaryText: "Earlier context omitted. (tag: SYNTH-P3-ONE)" });
  report.m2 = await runCase("m2-orphan-tool-result", P1.content + asLines(p.boundary, p.summary), "NONCE-P3M2");
}

// m3: reordered — U3 turn before U2 turn
{
  const p = mkPair({ uuids: [P1.u3User, P1.thinkU3, P1.red, P1.u2User, P1.thinkU2, P1.four],
    summaryText: "Earlier context omitted. (tag: SYNTH-P3-ONE)" });
  report.m3 = await runCase("m3-reordered", P1.content + asLines(p.boundary, p.summary), "NONCE-P3M3");
  report.m3.expect = "if context follows list order: u3Tag/red at lower indices than u2Tag/four; parent = four";
}

// m4: duplicate uuids
{
  const p = mkPair({ uuids: [P1.thinkU3, P1.red, P1.thinkU3, P1.red],
    summaryText: "Earlier context omitted. (tag: SYNTH-P3-ONE)" });
  report.m4 = await runCase("m4-duplicate", P1.content + asLines(p.boundary, p.summary), "NONCE-P3M4");
}

// m5: stacked boundaries — first preserves U3 turn, second preserves only "Red"
{
  const p1st = mkPair({ uuids: [P1.u3User, P1.thinkU3, P1.red], summaryText: "First boundary summary. (tag: SYNTH-P3-ONE)" });
  const p2nd = mkPair({ uuids: [P1.red], summaryText: "Second boundary summary. (tag: SYNTH-P3-TWO)", logicalParent: p1st.summaryUuid });
  report.m5 = await runCase("m5-stacked", P1.content + asLines(p1st.boundary, p1st.summary, p2nd.boundary, p2nd.summary), "NONCE-P3M5");
  report.m5.expect = "which boundary wins? if the second: synth2 present, synth1 absent, context = summary2 + Red";
}

// m6: valid boundary + trailing non-message entries (snapshot-like, no uuid links to the chain)
{
  const p = mkPair({ uuids: [P1.thinkU3, P1.red], summaryText: "Earlier context omitted. (tag: SYNTH-P3-ONE)" });
  const trailing = [
    { type: "file-history-snapshot", messageId: randomUUID(), snapshot: { trackedFileBackups: {}, timestamp: new Date().toISOString() }, isSnapshotUpdate: false },
    { type: "queue-operation", operation: "dequeue", timestamp: new Date().toISOString(), sessionId: P1.sessionId },
  ];
  report.m6 = await runCase("m6-trailing", P1.content + asLines(p.boundary, p.summary, ...trailing), "NONCE-P3M6");
  report.m6.expect = "same as the clean p1-case-B result: relink unaffected, parent = red";
}

// m7: preserved list includes an attachment entry's uuid among valid ones
{
  const p = mkPair({ uuids: [P1.attach1, P1.thinkU3, P1.red], summaryText: "Earlier context omitted. (tag: SYNTH-P3-ONE)" });
  report.m7 = await runCase("m7-attachment-uuid", P1.content + asLines(p.boundary, p.summary), "NONCE-P3M7");
  report.m7.expect = "attachment uuid EXISTS in the file — does the relink accept it, and what does it render as?";
}

fs.writeFileSync(`${EXP_DIR}/captures/p3-report.json`, JSON.stringify(report, null, 2));
console.log("DONE — report at captures/p3-report.json");
