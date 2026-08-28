// Hard pass/fail assertions over the recorded experiment reports.
//
// Usage: rerun the p1–p20 scripts (regenerating captures/*-report.json), then
//   node check-reports.mjs
// A clean exit means the pinned behaviors still hold on the current SDK/CLI —
// this is the upgrade-regression gate the FINDINGS header calls for.
//
// Only run-stable invariants are asserted: fixture uuids (stable across runs)
// may be compared exactly; uuids minted during a run (leaf markers, the CLI's
// synthetic "No response requested." assistant) are asserted structurally.

import fs from "node:fs";
import { EXP_DIR } from "./harness.mjs";

const load = (name) => JSON.parse(fs.readFileSync(`${EXP_DIR}/captures/${name}.json`, "utf8"));
let count = 0;
const failures = [];
function check(label, cond) {
  count++;
  if (!cond) failures.push(label);
}

// Fixture leaf uuids (8-char prefixes; stable because the fixtures are pinned files).
const RED = "254029a1";      // P1 "Red" assistant leaf
const FOUR = "d16f84b0";     // P1 "4" assistant
const MAGIC_B = "41a8c835";  // BRANCH U1-turn assistant
const REDLEAF_B = "91d9474f"; // BRANCH abandoned-branch leaf
const starts = (u, p) => typeof u === "string" && u.startsWith(p);

// --- p1: injection validity ---
{
  const r = load("p1-report");
  check("p1.a exact replay: summary first, red preserved", r.a.probe.summaryIdx === 0 && r.a.probe.preservedRedIdx === 1 && r.a.probe.u2OnlyInSummary);
  check("p1.b synthetic: 3 messages, parent = red", r.b.probe.nMessages === 3 && starts(r.b.firstNewUserParent, RED));
  check("p1.c durability: prior probe survived second resume", r.c.priorProbeStillThere === true);
  check("p1.d bad uuid: invalid playlist abort, summary-only signature (red absent)", r.d.probe.preservedRedIdx === -1 && r.d.probe.nMessages === 3);
}

// --- p2: option space + branch navigation ---
{
  const r = load("p2-report");
  const mk = (c) => c.probe.markerIdx;
  check("p2.a up_to: U2..U3 kept in order, U1 gone, parent = red",
    r.a.resultSubtype === "success" && starts(r.a.firstNewUserParent, RED)
    && mk(r.a).u1Tag === -1 && mk(r.a).magicWord === -1 && mk(r.a).red === 3 && r.a.probe.nMessages === 5);
  check("p2.b from: prefix first, summary after, suffix gone, parent = synthetic assistant",
    r.b.resultSubtype === "success" && mk(r.b).u1Tag === 0 && mk(r.b).magicWord === 4 && mk(r.b).synth === 6
    && mk(r.b).four === -1 && mk(r.b).red === -1
    && ![RED, FOUR].some((p) => starts(r.b.firstNewUserParent, p)));
  check("p2.c non-contiguous subset honored exactly",
    r.c.resultSubtype === "success" && starts(r.c.firstNewUserParent, RED)
    && mk(r.c).u1Tag === -1 && mk(r.c).four === -1 && mk(r.c).magicWord === 2 && mk(r.c).red === 5);
  check("p2.d resumeSessionAt on active chain: rewind to U1 turn, no summarization",
    r.d.resultSubtype === "success" && starts(r.d.firstNewUserParent, MAGIC_B)
    && mk(r.d).u2Tag === -1 && mk(r.d).six === -1 && r.d.nonProbeInferenceRequests === 0);
  for (const key of ["e", "f", "g"]) {
    check(`p2.${key} unreachable uuid fails fast, zero API calls`,
      r[key].resultSubtype === "error_during_execution"
      && r[key].stderr?.includes("No message found") && r[key].nonProbeInferenceRequests === 0);
  }
  check("p2.i leaf marker activates abandoned branch",
    r.i.resultSubtype === "success" && mk(r.i).red === 7 && mk(r.i).six === -1 && mk(r.i).synth === -1);
  check("p2.j boundary listing full chain switches branches, parent = redLeaf",
    r.j.resultSubtype === "success" && starts(r.j.firstNewUserParent, REDLEAF_B)
    && mk(r.j).red === 7 && mk(r.j).six === -1);
  check("p2.h pi-style from-boundary overrides natural leaf",
    r.h.resultSubtype === "success" && mk(r.h).u1Tag === 0 && mk(r.h).synth === 4
    && mk(r.h).four === -1 && mk(r.h).six === -1);
  check("p2.k marker behind boundary ignored: sealed region stays sealed",
    r.k.resultSubtype === "success" && starts(r.k.firstNewUserParent, RED)
    && r.k.probe.nMessages === 3 && mk(r.k).magicWord === -1 && mk(r.k).synth === 0);
}

// --- p3: adversarial ---
{
  const r = load("p3-report");
  const mk = (c) => c.probe.markerIdx;
  for (const key of ["m1", "m2"]) {
    check(`p3.${key} orphan tool block sanitized, HTTP 200, no retry`,
      r[key].resultSubtype === "success" && r[key].apiStatuses.every((s) => s === 200)
      && r[key].probeAttempts === 1 && mk(r[key]).toolUse === -1 && mk(r[key]).toolResult === -1
      && mk(r[key]).red === 3 && starts(r[key].firstNewUserParent, RED));
  }
  check("p3.m3 reverse-chronological playlist honored, parent = list tail",
    r.m3.resultSubtype === "success" && mk(r.m3).u3Tag === 0 && mk(r.m3).u2Tag === 2
    && starts(r.m3.firstNewUserParent, FOUR));
  // NOTE: this shape is MASKED — an unchecked rewrite (the binary's real
  // behavior, p14) and an explicit skip predict the same observation here.
  check("p3.m4 duplicate uuid: masked summary-only signature",
    r.m4.resultSubtype === "success" && r.m4.probe.nMessages === 3
    && mk(r.m4).red === -1 && mk(r.m4).synth1 === 0);
  check("p3.m5 stacked boundaries: last wins entirely",
    r.m5.resultSubtype === "success" && mk(r.m5).synth2 === 0 && mk(r.m5).synth1 === -1
    && mk(r.m5).red === 1 && starts(r.m5.firstNewUserParent, RED));
  for (const key of ["m6", "m7"]) {
    check(`p3.${key} trailing junk / attachment uuid harmless`,
      r[key].resultSubtype === "success" && r[key].probe.nMessages === 3
      && mk(r[key]).synth1 === 0 && starts(r[key].firstNewUserParent, RED));
  }
}

// --- p4: integration ---
{
  const r = load("p4-report");
  check("p4.q7 usage reflects compacted context", r.q7.probeUsage.cacheRead + r.q7.probeUsage.cacheCreate + r.q7.probeUsage.input < 60000);
  check("p4.q7 native /compact on injected file succeeds and scopes to effective context",
    r.q7.compactSubtype === "success" && r.q7.compactReqScope.nMessages === 3
    && r.q7.compactReqScope.hasSynthSummary && r.q7.compactReqScope.hasRed
    && !r.q7.compactReqScope.hasU1 && !r.q7.compactReqScope.hasU2);
  // Compaction WRITER keep-reach drift on this fixture (loader behavior
  // unchanged): 2.1.195 kept a segment from the old summary through the
  // probe turn; 2.1.250 kept only the trailing assistant turn — old summary
  // and first probe gone, post-compact context = [new summary, assistant
  // turn, probe] (3 messages). Known versions only: an unknown SDK version
  // FAILS here so drift gets characterized, not silently accepted.
  const keptOld = r.q7.postProbe.hasOldSynthSummary && r.q7.postProbe.hasFirstProbe;
  const keptTailOnly = !r.q7.postProbe.hasOldSynthSummary && !r.q7.postProbe.hasFirstProbe
    && r.q7.postProbe.nMessages === 3;
  check("p4.q7 post-compact probe sees new compacted context (known writer keep-reach per version)",
    r.versions.sdk === "0.3.195" ? keptOld
    : r.versions.sdk === "0.3.250" ? keptTailOnly
    : false);
  check("p4.q8 live dry-run rewind works", r.q8.liveDryRun.canRewind === true);
  check("p4.q8 behind-boundary rewind refused", r.q8.behindBoundaryDryRun.canRewind === false
    && r.q8.behindBoundaryDryRun.error?.includes("No file checkpoint") && r.q8.contentAfterRewind === "V2");
  check("p4.q8 preserved-message rewind reverts the file", r.q8.onChainReal.canRewind === true && r.q8.contentAfterOnChain === "V1");
  check("p4.q9 flush lag bounded, pre-close append survives",
    r.q9.resultToLeafOnDiskMs < 5000 && r.q9.sentinelSurvivedClose === true);
}

// --- p5 (Q3): importSessionToStore verbatim ---
{
  const r = load("p5-q3-report");
  check("p5 verbatim, ordered, unknown fields preserved",
    r.importError === null && r.sameOrder === true && r.rawCount === r.storedCount
    && r.onlyInRaw.length === 0 && r.onlyInStored.length === 0
    && r.unknownFieldPreserved === true && r.boundaryMetadataVerbatim === true);
  check("p5 missing session throws a clear error", typeof r.missingSessionError === "string" && r.missingSessionError.includes("not found"));
}

// --- p6: cross-model thinking ---
{
  const r = load("p6-report");
  for (const key of ["control", "withThinking", "noThinking"]) {
    check(`p6.${key} resumes under sonnet, thinking stripped, parent = red`,
      r[key].resultSubtype === "success" && r[key].apiStatuses.every((s) => s === 200)
      && r[key].probe.thinkingBlocks === 0 && r[key].probe.model.startsWith("claude-sonnet")
      && starts(r[key].firstNewUserParent, RED));
  }
}

// --- p7: lifecycle (self-asserting; the report existing with the flag is the gate) ---
{
  const r = load("p7-report");
  check("p7 all cycles passed hard assertions", r.allAssertionsPassed === true && r.cycles.length === r.reps);
  check("p7 leaf-on-disk lag bounded", r.leafOnDiskMs.max < 5000);
}

// --- p8: getSessionMessages cross-validation (self-asserting) ---
{
  const r = load("p8-report");
  check("p8 request text blocks all matched in order", r.p2a.requestTextBlocksMatched >= 6);
  check("p8 stacked-boundary effective context readable", r.p7.stackedBoundariesInFile === 12);
}

// --- p9: summary-free navigation + rewind within a relinked chain ---
{
  const r = load("p9-report");
  const clean = (c, parent) => c.resultSubtype === "success" && c.violations.length === 0
    && starts(c.firstNewUserParent, parent);
  check("p9.a no-summary boundary relinks, parent = red",
    clean(r.a, RED) && r.a.markerPresence.u2Tag && r.a.markerPresence.red && !r.a.markerPresence.magicWord);
  check("p9.b prefix-of-boundary playlist honored, parent = four",
    clean(r.b, FOUR) && r.b.markerPresence.summary1 && !r.b.markerPresence.red && !r.b.markerPresence.probe1);
  check("p9.c resumeSessionAt keeps boundary effect, parent = four",
    clean(r.c, FOUR) && r.c.markerPresence.summary1 && !r.c.markerPresence.magicWord
    && !r.c.markerPresence.red && r.c.newEntriesBeyondProbeTurn.length === 0);
}

// --- p10: empty preserved list ---
{
  const r = load("p10-report");
  check("p10 empty-boundary wipe: no violations, no fixture markers, parent = boundary",
    r.violations.length === 0 && Object.values(r.markerPresence).every((present) => !present));
}

// --- p11a–p17: round-2 wire probes (loader round 2, README-20260828.md).
// Run-stable gate: zero violations + the source-predicted model matched.
{
  const expectModel = {
    "p11a": "cut-before-expansion",
    "p11b": "cut-before-expansion",
    "p13": "expansion-active",
    "p14": "unchecked-rewrite",
    "p15a": "abort-untouched",
    "p16": "cut-plus-reparent",
    "p17": "eye-drop",
  };
  for (const [name, model] of Object.entries(expectModel)) {
    const r = load(`${name}-report`);
    check(`${name} no violations, matched [${model}]`,
      r.violations.length === 0 && r.matching.length === 1 && r.matching[0] === model);
  }
  // Per-consumer splits: the same fixtures through getSessionMessages.
  const p11a = load("p11a-report");
  check("p11a gSM keeps the excluded sibling (per-consumer split)",
    p11a.gsm.includesExcludedSibling === true);
  const p11b = load("p11b-report");
  check("p11b gSM keeps excluded fork call+result; wire drops both",
    p11b.gsm.callB && p11b.gsm.resultB && !p11b.wire.callB && !p11b.wire.resultB);
  const p15a = load("p15a-report");
  check("p15a gSM applies the earlier boundary the resume abort ignores",
    p15a.gsm.u2 && p15a.gsm.four && p15a.gsm.s1 && p15a.gsm.mid);
  const p16 = load("p16-report");
  check("p16 gSM follows raw parents (no cut)",
    p16.gsm.red && p16.gsm.u3 && p16.gsm.orphan);
  // p12 has no single predicted model: plain = merge (asserted in-script as
  // a violation); the results variant is exploratory characterization —
  // positional tool-pair repair (call1 healed, real result1 dropped,
  // adjacent call2/result2 intact).
  const p12 = load("p12-report");
  check("p12 no violations; plain users merged (all markers, one API message)",
    p12.violations.length === 0 && p12.plain.matching.includes("merge")
    && p12.plain.grouping.userMessagesCarryingMarkers === 1);
  check("p12 results: positional repair characterization stable",
    p12.results.wire.call1 && p12.results.wire.call2 && !p12.results.wire.result1
    && p12.results.wire.result2 && p12.results.wire.syntheticRepair);
}

// --- p18: parallel same-id calls through a playlist ---
{
  const r = load("p18-report");
  const NATIVE = ["user:prompt", "assistant:callA+callB", "user:resultA+resultB", "assistant:done"];
  check("p18 no violations; oracle shape is the native presented form",
    r.violations.length === 0 && JSON.stringify(r.oracleShape) === JSON.stringify(NATIVE));
  check("p18 grouped ordering reproduces the native presented shape",
    r.groupedMatchesNative === true);
  check("p18 interleaved ordering ALSO normalizes to the native shape, no synthetic heals",
    r.interleavedVerdict === "matches-native"
    && !r.syntheticHealMarkers.grouped && !r.syntheticHealMarkers.interleaved);
}

// --- p19: thinking exclusion (same-model) ---
{
  const r = load("p19-report");
  check("p19 control: same-model resume forwards signed thinking to the wire",
    r.violations.length === 0 && r.control.thinkingOnWire === true && r.control.nThinkingBlocks >= 5);
  check("p19 excl-think: excluded thinking sibling absent (cut before expansion)",
    r.exclThink.matching.length === 1 && r.exclThink.matching[0] === "cut-before-expansion");
  check("p19 excl-text: thinking-only assistant message dropped whole",
    r.exclText.matching.length === 1 && r.exclText.matching[0] === "thinking-only-dropped");
}

// --- p20: unresolved-tool-use drop semantics + partial-message playlists ---
{
  const r = load("p20-report");
  const m = (k) => r.cases[`p20-${k}`].matching;
  check("p20 no violations", r.violations.length === 0);
  check("p20 kill0: unresolved tool_use BLOCKS dropped, bundled text kept",
    m("kill0").length === 1 && m("kill0")[0] === "drops-calls-keeps-text");
  check("p20 kill1: only the unresolved call's block dropped, no synthetic heal",
    m("kill1").length === 1 && m("kill1")[0] === "drops-unresolved-block");
  check("p20 part1: playlist keeping one call+result presents exactly that",
    m("part1").length === 1 && m("part1")[0] === "cut-per-entry");
  check("p20 part2: text + one pair kept, other pair absent",
    m("part2").length === 1 && m("part2")[0] === "cut-per-entry");
}

if (failures.length) {
  console.error(`FAIL — ${failures.length}/${count} assertions failed:`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`PASS — ${count} assertions over p1–p20 reports`);
