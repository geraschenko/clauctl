// P13: in-turn fork on plain resume (no boundary) — the E3 control.
//
// Fixture: forkFixture() — two same-message.id sibling tool_use entries,
// only A1 on the parentUuid path to the leaf; A2 and its result R2 are
// off-path.
//
// Pre-registered predictions (README-20260828.md "Source-predicted E3
// outcomes"):
//   expansion-active (2.1.250 source, `Aer`): A2's tool_use and R2's
//     result ARE in the probe request — end-to-end same-message expansion
//     on plain resume (behavior claim, not function attribution).
//   walk-only (our old model): A2/R2 absent.

import { forkFixture, resumeProbe, judge, finishReport, sdkVersion } from "./round2.mjs";

const fork = forkFixture();
const r = await resumeProbe("p13-fork", fork.content, "NONCE-P13");

const predictions = {
  "expansion-active": {
    [fork.markers.prompt]: true, [fork.markers.callA]: true, [fork.markers.resultA]: true,
    [fork.markers.doneText]: true, [fork.markers.callB]: true, [fork.markers.resultB]: true,
  },
  "walk-only": {
    [fork.markers.prompt]: true, [fork.markers.callA]: true, [fork.markers.resultA]: true,
    [fork.markers.doneText]: true, [fork.markers.callB]: false, [fork.markers.resultB]: false,
  },
};
const { verdicts, matching } = judge(r.reqStr, predictions);

const violations = [];
if (r.error) violations.push(`error: ${r.error}`);
if (r.resultSubtype !== "success") violations.push(`result subtype ${r.resultSubtype}`);
if (!r.probeReq) violations.push("no probe request captured");
if (r.probeReq && matching.length === 0) violations.push("NO pre-registered prediction matches");

finishReport("p13", {
  sdkVersion, resultSubtype: r.resultSubtype, error: r.error, stderr: r.stderr,
  nRequestMessages: r.probeReq?.body.messages.length ?? null,
  requestMessages: r.requestMessages, verdicts, matching,
}, violations);
