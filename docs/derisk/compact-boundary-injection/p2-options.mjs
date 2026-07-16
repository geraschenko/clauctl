// Phase 2: map the valid option space (README Q2a, Q4).
//
// On the p1 fixture (U1 tool-turn / U2 "4" / U3 "Red"):
//   a-upto:    summarize prefix, keep U2..U3 suffix (anchor = summary) — native up_to shape
//   b-from:    keep U1 prefix, summarize the rest (anchor = boundary) — native from shape.
//              Resolves the Phase 0c open question: with both the preserved head and the
//              summary claiming the boundary as parent, what order does the loader produce?
//   c-subset:  non-contiguous preserved set — drop U1 user msg + failed first Read pair
//              + the whole U2 turn; keep the successful tool pair and U3 (pairing intact)
//   g-behind-boundary: p1-case-B-style boundary, then resumeSessionAt a uuid inside the
//              summarized (boundary-unreachable) region
//
// On the p0c branched fixture (U1 → U2 → U3 abandoned by fork U2B "6"; the file's
// natural leaf is on the U2B branch):
//   d-trunk:       resumeSessionAt = U1-turn assistant (on the active chain) — expect plain
//                  rewind, context ends at U1, no summarization request
//   e-abandoned:   resumeSessionAt = abandoned-branch leaf ("Red") — debugging showed the
//                  lookup only covers the ACTIVE chain (natural leaf → root), so this fails
//                  fast with "No message found with message.uuid"
//   f-nonexistent: resumeSessionAt = random uuid — same failure mode expected
//   i-leafmarker:  branch ACTIVATION by append — add a turn_duration-style system entry
//                  whose parentUuid = abandoned leaf; if leaf selection follows the last
//                  entry, the abandoned branch becomes the active chain
//   j-boundary-switch: branch activation via boundary — preserved uuids = the full
//                  abandoned-branch chain, tiny summary; no resumeSessionAt
//   h-combined:    pi-style end-to-end — from-style boundary preserving only the U1 turn,
//                  our summary of everything else (both branches); relink must override the
//                  file's natural leaf ("6")
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

const P1 = {
  cwd: "/tmp/clauctl-cbi-derisk/p0b-native-compact-cwd",
  sessionId: "c4a1bb69-58cb-4e57-b5f9-7f7e27a9fe36",
  content: fs.readFileSync(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`, "utf8"),
  // chain uuids (see WORK-LOG): U1 turn then U2 turn then U3 turn
  u1User: "815b1fad", think1: "54a37d1c", tool1: "309f0cfc", result1: "c8afccff",
  think2: "59e71878", tool2: "64aae3ff", result2: "87c8b882", think3: "5c67b617", magic: "7844a932",
  u2User: "d6c57604", thinkU2: "9f8ab726", four: "d16f84b0",
  u3User: "1a44a1ac", thinkU3: "a6941d02", red: "254029a1",
};
const BRANCH = {
  cwd: "/tmp/clauctl-cbi-derisk/p0c-cwd",
  sessionId: "d3d313fa-9bc8-4dca-8549-5b20aa96dc4f",
  content: fs.readFileSync(`${EXP_DIR}/captures/p0c-restore-post-branch.jsonl`, "utf8"),
  u1User: "72c11ef3", think1: "ccff3402", tool1: "c9090dc4", result1: "895b29dd",
  think2: "e534e288", magic: "41a8c835", u1Duration: "8f872008",
  u2User: "19f68581", thinkU2: "5b5f0e85", fourLeaf: "f3eb1e49", u2Duration: "a28e8f7a",
  u3User: "2c64a75d", thinkU3: "298802f9", redLeaf: "91d9474f",
  sixLeaf: "eabadaf2",
};
// Short prefixes above; expand against the fixture so asserts use full uuids.
function expandUuids(fixture) {
  const entries = readJsonl(`${EXP_DIR}/captures/${fixture === P1 ? "p1-fixture-pre" : "p0c-restore-post-branch"}.jsonl`);
  const byPrefix = Object.fromEntries(entries.filter((e) => e.uuid).map((e) => [e.uuid.slice(0, 8), e.uuid]));
  for (const [k, v] of Object.entries(fixture)) {
    if (typeof v === "string" && byPrefix[v]) fixture[k] = byPrefix[v];
  }
}
expandUuids(P1);
expandUuids(BRANCH);

function mkBoundary({ fixture, uuids, anchorUuid, boundaryUuid, logicalParent }) {
  return {
    parentUuid: null, logicalParentUuid: logicalParent, isSidechain: false,
    type: "system", subtype: "compact_boundary", content: "Conversation compacted",
    isMeta: false, timestamp: new Date().toISOString(), uuid: boundaryUuid, level: "info",
    compactMetadata: {
      trigger: "manual", preTokens: 40000, durationMs: 1, postTokens: 1000,
      preservedMessages: { anchorUuid, uuids, allUuids: uuids },
    },
    userType: "external", entrypoint: "sdk-cli", cwd: fixture.cwd, sessionId: fixture.sessionId, version: "2.1.195", gitBranch: "HEAD",
  };
}
function mkSummary({ fixture, boundaryUuid, summaryUuid, text, extras = {} }) {
  return {
    parentUuid: boundaryUuid, isSidechain: false, type: "user",
    message: { role: "user", content: text },
    isVisibleInTranscriptOnly: true, isCompactSummary: true,
    uuid: summaryUuid, timestamp: new Date().toISOString(),
    userType: "external", entrypoint: "sdk-cli", cwd: fixture.cwd, sessionId: fixture.sessionId, version: "2.1.195", gitBranch: "HEAD",
    ...extras,
  };
}
function withInjection(fixture, { uuids, anchorOn, summaryText, summaryExtras, logicalParent }) {
  logicalParent ??= fixture === P1 ? P1.red : BRANCH.sixLeaf;
  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const anchorUuid = anchorOn === "boundary" ? boundaryUuid : summaryUuid;
  const boundary = mkBoundary({ fixture, uuids, anchorUuid, boundaryUuid, logicalParent });
  const summary = mkSummary({ fixture, boundaryUuid, summaryUuid, text: summaryText, extras: summaryExtras });
  return fixture.content + JSON.stringify(boundary) + "\n" + JSON.stringify(summary) + "\n";
}

// Markers: index of the FIRST probe-request message containing each string, -1 if absent.
const MARKERS = {
  u1Tag: "NONCE-U1", magicWord: "XYLOPHONE-77431", u2Tag: "NONCE-U2)", four: '"text":"4"',
  u3Tag: "NONCE-U3", red: '"text":"Red"', u2bTag: "NONCE-U2B", six: '"text":"6"',
  synth: "SYNTH-P2", toolResult: "tool_result",
};
function analyzeProbe(probeReq, probeNonce) {
  const msgs = probeReq.body.messages;
  const idxOf = (needle) => msgs.findIndex((m) => JSON.stringify(m).includes(needle));
  const markerIdx = Object.fromEntries(Object.entries(MARKERS).map(([k, v]) => [k, idxOf(v)]));
  return { nMessages: msgs.length, roles: msgs.map((m) => m.role).join(","), markerIdx, probeIdx: idxOf(probeNonce) };
}

async function runCase(name, fixture, jsonlContent, { probeNonce, sessionOptions = {} }) {
  const configDir = makeConfigDir(`p2-${name}`);
  const projDir = path.join(configDir, "projects", projectKey(fixture.cwd));
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(fixture.cwd, { recursive: true });
  const file = path.join(projDir, `${fixture.sessionId}.jsonl`);
  fs.writeFileSync(file, jsonlContent);
  const preLines = readJsonl(file).length;
  const capture = `${EXP_DIR}/captures/p2-${name}-requests.jsonl`;
  const shim = await startShim(capture);
  let stderrBuf = "";
  const s = makeSession({
    model: HAIKU, cwd: fixture.cwd, resume: fixture.sessionId, ...sessionOptions,
    stderr: (d) => { stderrBuf += d; },
    env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
  });
  let error = null;
  let resultSubtype = null;
  try {
    const msgs = await s.send(`Reply with exactly the word pong. (tag: ${probeNonce})`);
    resultSubtype = msgs.find((m) => m.type === "result")?.subtype;
  } catch (e) { error = String(e); }
  const resumedSessionId = s.lastInit()?.session_id;
  s.close();
  shim.kill();

  // Missing capture file = the session made no requests at all (e.g. resume failed fast).
  const inference = fs.existsSync(capture) ? readCapturedInference(capture) : [];
  const probeReq = inference.find((r) => JSON.stringify(r.body.messages).includes(probeNonce));
  const nonProbeRequests = inference.filter((r) => !JSON.stringify(r.body.messages).includes(probeNonce)).length;
  // Where did the CLI write? resumeSessionAt may fork to a new session file.
  const sessionFiles = fs.readdirSync(projDir);
  const findNewUser = (f) => {
    if (!fs.existsSync(f)) return undefined;
    const entries = readJsonl(f);
    const skip = f === file ? preLines : 0;
    return entries.slice(skip).find((e) => e.type === "user" && JSON.stringify(e.message?.content ?? "").includes(probeNonce));
  };
  const firstNewUser = sessionFiles.map((n) => findNewUser(path.join(projDir, n))).find(Boolean);
  const result = {
    name, error, resultSubtype,
    stderr: stderrBuf.trim().slice(0, 200) || null,
    resumedSessionId,
    sameSessionId: resumedSessionId === fixture.sessionId,
    sessionFiles,
    nonProbeInferenceRequests: nonProbeRequests,
    probe: probeReq ? analyzeProbe(probeReq, probeNonce) : "NO PROBE REQUEST CAPTURED",
    firstNewUserParent: firstNewUser?.parentUuid ?? null,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const report = { versions };

// --- a: up_to reproduction — keep U2..U3, anchor = summary ---
report.a = await runCase("a-upto", P1, withInjection(P1, {
  uuids: [P1.u2User, P1.thinkU2, P1.four, P1.u3User, P1.thinkU3, P1.red],
  anchorOn: "summary",
  summaryText: "Earlier: the user had fact.txt read (details omitted). (tag: SYNTH-P2A)",
}), { probeNonce: "NONCE-P2A" });
report.a.expect = { parent: P1.red.slice(0, 8), note: "summary first, then U2..U3; U1 absent" };

// --- b: from reproduction — keep U1 turn, anchor = boundary ---
report.b = await runCase("b-from", P1, withInjection(P1, {
  uuids: [P1.u1User, P1.think1, P1.tool1, P1.result1, P1.think2, P1.tool2, P1.result2, P1.think3, P1.magic],
  anchorOn: "boundary",
  summaryText: "Recent portion summarized: arithmetic (answer 4) and a color question (answer Red). (tag: SYNTH-P2B)",
  summaryExtras: { summarize_metadata: { messagesSummarized: 6, direction: "from" } },
}), { probeNonce: "NONCE-P2B" });
report.b.expect = { note: "open question: prefix+summary order and next-write parent" };

// --- c: non-contiguous subset — drop U1 user + failed Read pair + whole U2 turn ---
report.c = await runCase("c-subset", P1, withInjection(P1, {
  uuids: [P1.think2, P1.tool2, P1.result2, P1.think3, P1.magic, P1.u3User, P1.thinkU3, P1.red],
  anchorOn: "summary",
  summaryText: "Earlier context (details omitted). (tag: SYNTH-P2C)",
}), { probeNonce: "NONCE-P2C" });
report.c.expect = { parent: P1.red.slice(0, 8), note: "tool pair + U3 present; U1 user text, failed Read, and U2 turn absent" };

// --- d: resumeSessionAt = trunk uuid (on the active chain) — rewind works ---
report.d = await runCase("d-trunk", BRANCH, BRANCH.content, {
  probeNonce: "NONCE-P2D", sessionOptions: { resumeSessionAt: BRANCH.magic },
});
report.d.expect = { parent: BRANCH.magic.slice(0, 8), note: "context ends at U1 turn; U2/U3/U2B absent; no summarization request" };

// --- e: resumeSessionAt = abandoned-branch leaf "Red" — active-chain-only lookup fails ---
report.e = await runCase("e-abandoned", BRANCH, BRANCH.content, {
  probeNonce: "NONCE-P2E", sessionOptions: { resumeSessionAt: BRANCH.redLeaf },
});
report.e.expect = { note: "error_during_execution, stderr 'No message found with message.uuid', no API request" };

// --- f: resumeSessionAt nonexistent uuid ---
report.f = await runCase("f-nonexistent", BRANCH, BRANCH.content, {
  probeNonce: "NONCE-P2F", sessionOptions: { resumeSessionAt: randomUUID() },
});
report.f.expect = { note: "same failure mode as e" };

// --- i: branch activation by appending a leaf-marker system entry ---
const durationEntry = readJsonl(`${EXP_DIR}/captures/p0c-restore-post-branch.jsonl`)
  .find((e) => e.subtype === "turn_duration");
const leafMarker = { ...durationEntry, uuid: randomUUID(), parentUuid: BRANCH.redLeaf, timestamp: new Date().toISOString() };
report.i = await runCase("i-leafmarker", BRANCH, BRANCH.content + JSON.stringify(leafMarker) + "\n", {
  probeNonce: "NONCE-P2I",
});
report.i.expect = { parent: BRANCH.redLeaf.slice(0, 8), note: "if leaf selection follows last entry: U1..U3 active, U2B absent" };

// --- j: branch activation via boundary — preserved uuids = full abandoned-branch chain ---
report.j = await runCase("j-boundary-switch", BRANCH, withInjection(BRANCH, {
  uuids: [BRANCH.u1User, BRANCH.think1, BRANCH.tool1, BRANCH.result1, BRANCH.think2, BRANCH.magic,
    BRANCH.u2User, BRANCH.thinkU2, BRANCH.fourLeaf, BRANCH.u3User, BRANCH.thinkU3, BRANCH.redLeaf],
  anchorOn: "summary",
  summaryText: "(Branch switch — no summarized content.) (tag: SYNTH-P2J)",
  logicalParent: BRANCH.sixLeaf,
}), { probeNonce: "NONCE-P2J" });
report.j.expect = { parent: BRANCH.redLeaf.slice(0, 8), note: "U1..U3 branch active incl. 4/Red; U2B/6 absent" };

// --- g: resumeSessionAt into the summarized region behind a boundary ---
report.g = await runCase("g-behind-boundary", P1, withInjection(P1, {
  uuids: [P1.thinkU3, P1.red],
  anchorOn: "summary",
  summaryText: "Earlier context (details omitted). (tag: SYNTH-P2G)",
}), { probeNonce: "NONCE-P2G", sessionOptions: { resumeSessionAt: P1.four } });
report.g.expect = { note: "exploratory: is a summarized-region uuid reachable for rewind?" };

// --- h: combined pi-style — branched file, from-style boundary keeping only U1 turn ---
report.h = await runCase("h-combined", BRANCH, withInjection(BRANCH, {
  uuids: [BRANCH.u1User, BRANCH.think1, BRANCH.tool1, BRANCH.result1, BRANCH.think2, BRANCH.magic],
  anchorOn: "boundary",
  summaryText: "Everything after the fact.txt read is summarized: arithmetic on two branches (4, 6) and a color question (Red). (tag: SYNTH-P2H)",
  summaryExtras: { summarize_metadata: { messagesSummarized: 10, direction: "from" } },
  logicalParent: BRANCH.sixLeaf,
}), { probeNonce: "NONCE-P2H" });
report.h.expect = { note: "U1 turn + summary only; U2/U3/U2B absent; relink overrides natural leaf 6" };

// --- k: leaf-marker pointing INTO the summarized region behind a boundary ---
// resumeSessionAt can't reach behind a boundary (case g); can a leaf marker?
// File = p1 fixture + case-B-style boundary (preserving U3 assistants), then a
// marker whose parent is the "4" assistant inside the summarized region.
const p1Duration = { ...durationEntry, uuid: randomUUID(), parentUuid: P1.four, timestamp: new Date().toISOString(), cwd: P1.cwd, sessionId: P1.sessionId };
report.k = await runCase("k-marker-past-boundary", P1, withInjection(P1, {
  uuids: [P1.thinkU3, P1.red],
  anchorOn: "summary",
  summaryText: "Earlier context (details omitted). (tag: SYNTH-P2K)",
}) + JSON.stringify(p1Duration) + "\n", { probeNonce: "NONCE-P2K" });
report.k.expect = { note: "exploratory: does the raw-parent walk from the marker bypass the boundary entirely (full U1..U2 context, no summary)?" };

fs.writeFileSync(`${EXP_DIR}/captures/p2-report.json`, JSON.stringify(report, null, 2));
console.log("DONE — report at captures/p2-report.json");
