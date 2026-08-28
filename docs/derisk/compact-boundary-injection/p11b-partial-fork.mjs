// P11b: partial-API-message playlist, parallel-tool (fork) case.
//
// Fixture: forkFixture() + boundary preserving [user, A1, R1, done] —
// excluding the off-path sibling A2 and its result R2. uuids === allUuids.
//
// Predictions:
//   cut-before-expansion (2.1.250 source): A2 and R2 deleted by the cut
//     before expansion → callB and resultB both absent on the wire.
//     Asserted separately (a sibling-without-result partial recovery
//     would be a distinct, prediction-violating outcome).
//   expansion-recovers: both present.
// getSessionMessages (no cut): both present.
//
// Together with p11a this decides the set-context authoring rule for the
// observed shapes: whether playlists must close over whole API messages.

import {
  forkFixture, boundaryPair, asLines,
  resumeProbe, gsmRun, judge, finishReport, sdkVersion,
} from "./round2.mjs";

const fork = forkFixture();
const pair = boundaryPair({
  logicalParent: fork.uuids.done,
  uuids: [fork.uuids.user, fork.uuids.a1, fork.uuids.r1, fork.uuids.done],
  summaryText: "Earlier: parallel marker commands ran. (tag: SYNTH-P11B-SUMMARY)",
});
const content = fork.content + asLines(pair.boundary, pair.summary);

const r = await resumeProbe("p11b-fork", content, "NONCE-P11B");
const gsm = await gsmRun("p11b-fork", content);

const common = {
  [fork.markers.prompt]: true, [fork.markers.callA]: true, [fork.markers.resultA]: true,
  [fork.markers.doneText]: true, "SYNTH-P11B-SUMMARY": true,
};
const predictions = {
  "cut-before-expansion": { ...common, [fork.markers.callB]: false, [fork.markers.resultB]: false },
  "expansion-recovers": { ...common, [fork.markers.callB]: true, [fork.markers.resultB]: true },
};
const { verdicts, matching } = judge(r.reqStr, predictions);

const violations = [];
if (r.error) violations.push(`error: ${r.error}`);
if (r.resultSubtype !== "success") violations.push(`result subtype ${r.resultSubtype}`);
if (!r.probeReq) violations.push("no probe request captured");
if (r.probeReq && matching.length === 0) violations.push(
  `NO pre-registered prediction matches (callB=${r.reqStr.includes(fork.markers.callB)}, resultB=${r.reqStr.includes(fork.markers.resultB)})`);
if (!gsm.str.includes(fork.markers.callB) || !gsm.str.includes(fork.markers.resultB))
  violations.push("gSM unexpectedly lost the excluded sibling or its result");

finishReport("p11b", {
  sdkVersion, resultSubtype: r.resultSubtype, error: r.error, stderr: r.stderr,
  nRequestMessages: r.probeReq?.body.messages.length ?? null,
  requestMessages: r.requestMessages, verdicts, matching,
  wire: { callB: r.reqStr.includes(fork.markers.callB), resultB: r.reqStr.includes(fork.markers.resultB) },
  gsm: { callB: gsm.str.includes(fork.markers.callB), resultB: gsm.str.includes(fork.markers.resultB) },
}, violations);
