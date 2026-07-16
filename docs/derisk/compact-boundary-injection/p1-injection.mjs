// Phase 1: does append-boundary-then-resume work at all?
//   A. Exact replay: session file = the byte-identical post-/compact jsonl from
//      p0b, dropped into a fresh config dir; resume; probe.
//   B. Synthetic: pre-compact jsonl + OUR boundary+summary (fresh uuids); resume; probe.
//   C. Durability: after B's probe turn, close and resume a SECOND time; probe again.
//   D. Bad-uuid control: like B but preserved_messages.uuids contains a
//      nonexistent uuid; the skip detector must fire (probe context lacks the
//      preserved messages; per raw links the chain is just summary → boundary).
//
// Oracle per README: probe request messages + parentUuid of first post-resume write.

import {
  assertVersions, makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, readJsonl, EXP_DIR, HAIKU, projectKey,
} from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const versions = assertVersions();
const CWD = "/tmp/clauctl-cbi-derisk/p0b-native-compact-cwd"; // must match p0b for projectKey
const SESSION_ID = "c4a1bb69-58cb-4e57-b5f9-7f7e27a9fe36";     // p0b session
const PRE = `${EXP_DIR}/captures/p1-fixture-pre.jsonl`;
const POST = `${EXP_DIR}/captures/p1-fixture-replay.jsonl`;

fs.mkdirSync(CWD, { recursive: true });

// Facts about the p0b fixture, used in asserts:
const U2_TEXT = "What is 2+2? Answer with just the number. (tag: NONCE-U2)";
const PRESERVED_ASSISTANT_TEXT = '"text":"Red"'; // preserved U3-turn assistant block

function installSession(configDir, jsonlContent) {
  const dir = path.join(configDir, "projects", projectKey(CWD));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, jsonlContent);
  return file;
}

// Message-level assertions on a captured probe request.
function analyzeProbe(probeReq, probeNonce) {
  const msgs = probeReq.body.messages;
  const msgStr = (m) => JSON.stringify(m);
  const idxOf = (needle) => msgs.findIndex((m) => msgStr(m).includes(needle));
  const summaryIdx = idxOf("This session is being continued");
  const u2Indices = msgs.map((m, i) => (msgStr(m).includes(U2_TEXT) ? i : -1)).filter((i) => i >= 0);
  return {
    nMessages: msgs.length,
    roles: msgs.map((m) => m.role).join(","),
    summaryIdx,
    preservedRedIdx: idxOf(PRESERVED_ASSISTANT_TEXT),
    // U2 must appear ONLY inside the summary message (which quotes user messages),
    // never as its own user message:
    u2OnlyInSummary: u2Indices.every((i) => i === summaryIdx),
    u2Indices,
    probeIdx: idxOf(probeNonce),
    toolReminderIdx: idxOf("Called the Read tool"),
  };
}

async function runCase(name, jsonlContent, { probeNonce, extraTurns = 0 } = {}) {
  const configDir = makeConfigDir(`p1-${name}`);
  const file = installSession(configDir, jsonlContent);
  const preLines = readJsonl(file).length;
  const capture = `${EXP_DIR}/captures/p1-${name}-requests.jsonl`;
  const shim = await startShim(capture);
  const s = makeSession({
    model: HAIKU,
    cwd: CWD,
    resume: SESSION_ID,
    env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
  });
  let error = null;
  let resultText = null;
  try {
    const msgs = await s.send(`Reply with exactly the word pong. (tag: ${probeNonce})`);
    resultText = msgs.find((m) => m.type === "result")?.result?.slice(0, 80);
  } catch (e) {
    error = String(e);
  }
  const resumedSessionId = s.lastInit()?.session_id;
  s.close();
  shim.kill();

  const inference = readCapturedInference(capture);
  const probeReq = inference.find((r) => JSON.stringify(r.body.messages).includes(probeNonce));
  const entries = readJsonl(file);
  const appended = entries.slice(preLines);
  const firstNewUser = appended.find((e) => e.type === "user" && JSON.stringify(e.message?.content ?? "").includes(probeNonce));
  return {
    name, error, resultText, resumedSessionId,
    sameSessionId: resumedSessionId === SESSION_ID,
    probe: probeReq ? analyzeProbe(probeReq, probeNonce) : "NO PROBE REQUEST CAPTURED",
    firstNewUserParent: firstNewUser?.parentUuid ?? null,
    appendedTypes: appended.map((e) => e.type + (e.subtype ? `:${e.subtype}` : "")),
    configDir, file,
  };
}

const postContent = fs.readFileSync(POST, "utf8");
const preContent = fs.readFileSync(PRE, "utf8");

// --- Case A: exact replay ---
const a = await runCase("a-exact-replay", postContent, { probeNonce: "NONCE-P1A" });
console.log(JSON.stringify(a, null, 2));

// --- Case B: synthetic boundary + summary, fresh uuids ---
// Native /compact preserved the U3-turn assistant entries; we mimic that shape
// with our own uuids and our own summary text (tagged SYNTH-SUMMARY-P1B).
const preEntries = readJsonl(PRE);
const chainEntries = preEntries.filter((e) => e.uuid && (e.type === "user" || e.type === "assistant"));
const leaf = chainEntries.at(-1);                    // 254029a1 "Red"
const leafThinking = chainEntries.at(-2);            // a6941d02 thinking
const boundaryUuid = randomUUID();
const summaryUuid = randomUUID();
const stamp = (e) => ({ ...e, sessionId: SESSION_ID, cwd: CWD });
const mkBoundary = (uuids, anchorUuid) => stamp({
  parentUuid: null,
  logicalParentUuid: leaf.uuid,
  isSidechain: false,
  type: "system",
  subtype: "compact_boundary",
  content: "Conversation compacted",
  isMeta: false,
  timestamp: new Date().toISOString(),
  uuid: boundaryUuid,
  level: "info",
  compactMetadata: {
    trigger: "manual",
    preTokens: 40000,
    durationMs: 1,
    preservedMessages: { anchorUuid, uuids, allUuids: uuids },
    postTokens: 1000,
  },
  userType: "external", entrypoint: "sdk-cli", version: "2.1.195", gitBranch: "HEAD",
});
const mkSummary = (text) => stamp({
  parentUuid: boundaryUuid,
  isSidechain: false,
  type: "user",
  message: { role: "user", content: text },
  isVisibleInTranscriptOnly: true,
  isCompactSummary: true,
  uuid: summaryUuid,
  timestamp: new Date().toISOString(),
  userType: "external", entrypoint: "sdk-cli", version: "2.1.195", gitBranch: "HEAD",
});
const SYNTH_SUMMARY = "This session is being continued from a previous conversation that ran out of context. Summary: the user asked arithmetic and color questions and asked to read fact.txt; the magic word file was read. (tag: SYNTH-SUMMARY-P1B)";
const synthLines = (uuids, anchorUuid, summaryText) =>
  preContent + [mkBoundary(uuids, anchorUuid), mkSummary(summaryText)].map((e) => JSON.stringify(e)).join("\n") + "\n";

const b = await runCase("b-synthetic", synthLines([leafThinking.uuid, leaf.uuid], summaryUuid, SYNTH_SUMMARY), { probeNonce: "NONCE-P1B" });
console.log(JSON.stringify(b, null, 2));

// --- Case C: durability — resume case B's file a second time ---
let c = null;
if (!b.error) {
  const capture = `${EXP_DIR}/captures/p1-c-durability-requests.jsonl`;
  const shim = await startShim(capture);
  const s = makeSession({
    model: HAIKU, cwd: CWD, resume: SESSION_ID,
    env: baseEnv(b.configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
  });
  let error = null;
  try { await s.send("Reply with exactly the word pong. (tag: NONCE-P1C)"); } catch (e) { error = String(e); }
  s.close(); shim.kill();
  const inference = readCapturedInference(capture);
  const probeReq = inference.find((r) => JSON.stringify(r.body.messages).includes("NONCE-P1C"));
  c = {
    name: "c-durability", error,
    probe: probeReq ? analyzeProbe(probeReq, "NONCE-P1C") : "NO PROBE REQUEST CAPTURED",
    priorProbeStillThere: probeReq ? JSON.stringify(probeReq.body.messages).includes("NONCE-P1B") : null,
  };
  console.log(JSON.stringify(c, null, 2));
}

// --- Case D: bad uuid in preserved list ---
const d = await runCase("d-bad-uuid", synthLines([leafThinking.uuid, randomUUID()], summaryUuid,
  SYNTH_SUMMARY.replace("P1B", "P1D")), { probeNonce: "NONCE-P1D" });
console.log(JSON.stringify(d, null, 2));

fs.writeFileSync(`${EXP_DIR}/captures/p1-report.json`, JSON.stringify({ versions, a, b, c, d }, null, 2));
console.log("DONE — report at captures/p1-report.json");
