// P9: summary-free navigation (spec TDC derisk, commit 4eb65a9).
//
// Three unknowns behind `set-context --rewind-to` and TUI /tree navigation:
//   a) no-summary boundary: anchorUuid = the boundary's OWN uuid, a uuid
//      playlist, and NO summary entry. Pure navigation — does the loader
//      apply the relink when the boundary is the last entry in the file?
//      (Every prior experiment had a summary entry parented on the boundary,
//      which is what put the boundary on the active chain.)
//   b) viaBoundary prefix navigation: boundary 2 whose playlist is a prefix
//      of the chain boundary 1 created — [summary1, U2 user, U2 thinking,
//      "4"] — reaching entries boundary 1 had summarized away. No summary.
//   c) resumeSessionAt rewind WITHIN a boundary-relinked active chain:
//      target = "4", a playlist member. Does the rewound context keep the
//      boundary's effect (summary1 present, U1 absent) or fall back to the
//      raw parentUuid chain (U1 resurrected)?
//
// Depends on the p2 run's persisted config dir (/tmp/clauctl-cbi-derisk/
// p2-a-upto) for cases b and c — /tmp is volatile, so rerun p2 first if it's
// gone. Case a needs only the checked-in captures/p1-fixture-pre.jsonl.
//
// Oracle as always: the captured outbound probe request + the parentUuid of
// the first new write. Expectations are collected per case and all violations
// reported at the end (these outcomes are genuinely uncertain; we want the
// full picture, not a throw on the first surprise).

import {
  assertVersions, makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, readJsonl, EXP_DIR, projectKey, HAIKU,
} from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const versions = assertVersions();
const cwd = "/tmp/clauctl-cbi-derisk/p0b-native-compact-cwd";
const sessionId = "c4a1bb69-58cb-4e57-b5f9-7f7e27a9fe36";
const P1_CONTENT = fs.readFileSync(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`, "utf8");
const P2A_FILE = path.join("/tmp/clauctl-cbi-derisk/p2-a-upto", "projects", projectKey(cwd), `${sessionId}.jsonl`);

// Full uuids resolved from 8-char prefixes recorded in WORK-LOG.
const U = { u1User: "815b1fad", magic: "7844a932", u2User: "d6c57604", thinkU2: "9f8ab726",
  four: "d16f84b0", u3User: "1a44a1ac", thinkU3: "a6941d02", red: "254029a1" };
{
  const byPrefix = Object.fromEntries(readJsonl(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`)
    .filter((e) => e.uuid).map((e) => [e.uuid.slice(0, 8), e.uuid]));
  for (const k of Object.keys(U)) U[k] = byPrefix[U[k]];
}
const p2aEntries = readJsonl(P2A_FILE);
const summary1 = p2aEntries.find((e) => e.isCompactSummary);
const p2aLeaf = p2aEntries.findLast((e) => e.type === "assistant");

// A boundary with NO companion summary: anchorUuid = its own uuid.
function noSummaryBoundary(uuids, logicalParentUuid) {
  const boundaryUuid = randomUUID();
  return JSON.stringify({
    isSidechain: false, timestamp: new Date().toISOString(), userType: "external",
    entrypoint: "sdk-cli", cwd, sessionId, version: "2.1.195", gitBranch: "HEAD",
    parentUuid: null, logicalParentUuid, type: "system", subtype: "compact_boundary",
    content: "Conversation compacted", isMeta: false, uuid: boundaryUuid, level: "info",
    compactMetadata: {
      trigger: "manual", preTokens: 40000, durationMs: 1, postTokens: 1000,
      preservedMessages: { anchorUuid: boundaryUuid, uuids, allUuids: uuids },
    },
  }) + "\n";
}

// Markers checked against the JSON-serialized probe request.
const MARKERS = {
  u1Tag: "NONCE-U1", magicWord: "XYLOPHONE-77431", u2Tag: "NONCE-U2",
  four: '"text":"4"', u3Tag: "NONCE-U3", red: '"text":"Red"',
  summary1: "SYNTH-P2A", probe1: "NONCE-P2A",
};

async function runCase({ name, fileContent, nonce, options = {}, expectPresent, expectAbsent, expectParent }) {
  const configDir = makeConfigDir(`p9-${name}`);
  const projDir = path.join(configDir, "projects", projectKey(cwd));
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, fileContent);
  const preLines = readJsonl(file).length;
  const capture = `${EXP_DIR}/captures/p9-${name}-requests.jsonl`;
  const shim = await startShim(capture);
  let stderrBuf = "";
  const s = makeSession({
    model: HAIKU, cwd, resume: sessionId, ...options,
    stderr: (d) => { stderrBuf += d; },
    env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
  });
  let error = null, resultSubtype = null;
  try {
    const msgs = await s.send(`Reply with exactly the word pong. (tag: ${nonce})`);
    resultSubtype = msgs.find((m) => m.type === "result")?.subtype;
  } catch (e) { error = String(e); }
  s.close();
  shim.kill();

  const inference = fs.existsSync(capture) ? readCapturedInference(capture) : [];
  const probeReq = inference.find((r) => JSON.stringify(r.body.messages).includes(nonce));
  const reqStr = probeReq ? JSON.stringify(probeReq.body.messages) : "";
  const postEntries = fs.existsSync(file) ? readJsonl(file) : [];
  const newUser = postEntries.slice(preLines)
    .find((e) => e.type === "user" && JSON.stringify(e.message?.content ?? "").includes(nonce));

  const violations = [];
  if (error) violations.push(`error: ${error}`);
  if (resultSubtype !== "success") violations.push(`result subtype ${resultSubtype}`);
  if (!probeReq) violations.push("no probe request captured");
  for (const m of expectPresent) if (!reqStr.includes(MARKERS[m])) violations.push(`missing from request: ${m}`);
  for (const m of expectAbsent) if (reqStr.includes(MARKERS[m])) violations.push(`unexpectedly in request: ${m}`);
  if (newUser?.parentUuid !== expectParent)
    violations.push(`new write parent ${newUser?.parentUuid?.slice(0, 8)} != expected ${expectParent.slice(0, 8)}`);

  const result = {
    name, resultSubtype, error, stderr: stderrBuf.trim().slice(0, 300) || null,
    nRequestMessages: probeReq?.body.messages.length ?? null,
    markerPresence: Object.fromEntries(Object.entries(MARKERS).map(([k, v]) => [k, reqStr.includes(v)])),
    firstNewUserParent: newUser?.parentUuid?.slice(0, 8) ?? null,
    newEntriesBeyondProbeTurn: postEntries.slice(preLines)
      .filter((e) => e.type === "system" || e.subtype).map((e) => `${e.type}/${e.subtype}`),
    violations,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const report = { versions };

report.a = await runCase({
  name: "a-no-summary",
  fileContent: P1_CONTENT + noSummaryBoundary(
    [U.u2User, U.thinkU2, U.four, U.u3User, U.thinkU3, U.red], U.red),
  nonce: "NONCE-P9A",
  expectPresent: ["u2Tag", "four", "u3Tag", "red"],
  expectAbsent: ["u1Tag", "magicWord"],
  expectParent: U.red,
});

report.b = await runCase({
  name: "b-prefix",
  fileContent: fs.readFileSync(P2A_FILE, "utf8") + noSummaryBoundary(
    [summary1.uuid, U.u2User, U.thinkU2, U.four], p2aLeaf.uuid),
  nonce: "NONCE-P9B",
  expectPresent: ["summary1", "u2Tag", "four"],
  expectAbsent: ["u1Tag", "magicWord", "u3Tag", "red", "probe1"],
  expectParent: U.four,
});

report.c = await runCase({
  name: "c-rewind-preserved",
  fileContent: fs.readFileSync(P2A_FILE, "utf8"),
  options: { resumeSessionAt: U.four },
  nonce: "NONCE-P9C",
  expectPresent: ["summary1", "u2Tag", "four"],
  expectAbsent: ["u1Tag", "magicWord", "u3Tag", "red", "probe1"],
  expectParent: U.four,
});

fs.writeFileSync(`${EXP_DIR}/captures/p9-report.json`, JSON.stringify(report, null, 2));
const allViolations = ["a", "b", "c"].flatMap((k) => report[k].violations.map((v) => `${k}: ${v}`));
console.log(allViolations.length ? `VIOLATIONS:\n${allViolations.join("\n")}` : "PASS — all expectations met");
console.log("report at captures/p9-report.json");
