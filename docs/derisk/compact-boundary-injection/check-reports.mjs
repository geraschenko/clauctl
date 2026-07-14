// Hard pass/fail assertions over the recorded experiment reports.
//
// Usage: rerun the p1–p8 scripts (regenerating captures/*-report.json), then
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
  check("p1.d bad uuid: relink skipped (red absent), summary-only context", r.d.probe.preservedRedIdx === -1 && r.d.probe.nMessages === 3);
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
  check("p3.m4 duplicate uuid: relink skipped, summary-only signature",
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
  check("p4.q7 post-compact probe sees new compacted context", r.q7.postProbe.hasOldSynthSummary && r.q7.postProbe.hasFirstProbe);
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

if (failures.length) {
  console.error(`FAIL — ${failures.length}/${count} assertions failed:`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`PASS — ${count} assertions over p1–p8 reports`);
