// P14: duplicate uuid in the playlist — the discriminating redesign.
//
// Round 1's m4 shape observed "summary only" and concluded "relink
// skipped", but that observation is masked: explicit-skip, an unchecked
// sequential rewrite (which strands the playlist in a parent cycle), and
// abort-untouched all predict it. This fixture adds a post-boundary
// anchor child PC so the models separate.
//
// Playlist: [u2User, four, u2User] (duplicate). Anchor = summary. PC =
// synthetic user, parent = summary (the anchor), after the summary in the
// file — the leaf the probe parents on.
//
// Predictions (wire):
//   unchecked-rewrite (2.1.250 source — `Ser` has no dup check):
//     sequential writes leave u2User↔four a 2-cycle with tail u2User;
//     anchor-child pass repoints PC → u2User. Walk: probe→PC→u2User→four
//     →(cycle stop). Context: PC + NONCE-U2 + "4"; summary text ABSENT
//     (walk never reaches the anchor); XYLOPHONE absent (cut).
//   skip-or-abort (round-1 reading / 2.1.170): playlist untouched; PC
//     stays under the summary. Walk: probe→PC→summary→boundary. Context:
//     PC + summary; NONCE-U2/"4" ABSENT.
// A resume ERROR (cycle crash) is also a recordable outcome.

import {
  P1_CONTENT, U, M, boundaryPair, asLines, userEntry,
  resumeProbe, judge, finishReport, sdkVersion,
} from "./round2.mjs";
import { randomUUID } from "node:crypto";

const pair = boundaryPair({
  logicalParent: U.red, uuids: [U.u2User, U.four, U.u2User],
  summaryText: "Earlier: assorted prompts. (tag: SYNTH-P14-SUMMARY)",
});
const pc = userEntry({
  uuid: randomUUID(), parent: pair.summaryUuid,
  content: "Anchor-child marker. (tag: NONCE-P14-CHILD)",
});
const content = P1_CONTENT + asLines(pair.boundary, pair.summary, pc);

const r = await resumeProbe("p14-dup", content, "NONCE-P14");

const predictions = {
  "unchecked-rewrite": {
    "NONCE-P14-CHILD": true, [M.u2Tag]: true, [M.four]: true,
    "SYNTH-P14-SUMMARY": false, [M.magicWord]: false, [M.red]: false,
  },
  "skip-or-abort": {
    "NONCE-P14-CHILD": true, [M.u2Tag]: false, [M.four]: false,
    "SYNTH-P14-SUMMARY": true, [M.magicWord]: false,
  },
};
const { verdicts, matching } = judge(r.reqStr, predictions);

const violations = [];
if (!r.probeReq && !r.error) violations.push("no probe request captured and no error");
if (r.probeReq && matching.length === 0) violations.push("NO pre-registered prediction matches");

finishReport("p14", {
  sdkVersion, resultSubtype: r.resultSubtype, error: r.error, stderr: r.stderr,
  nRequestMessages: r.probeReq?.body.messages.length ?? null,
  requestMessages: r.requestMessages, verdicts, matching,
}, violations);
