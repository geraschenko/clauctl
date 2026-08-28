// P15a: stacked boundaries — valid B1, then an INVALID trailing B2 with
// no summary or turns after it. The leaf PRECEDES B2 (the shape P1 d
// masked). Three models, three predicted contexts.
//
// Fixture: p1 content + B1 (playlist [u2User, four], anchor = S1) + S1 +
// a post-B1 turn (user PB → assistant PA, the leaf) + B2 whose playlist
// names a uuid absent from the file. uuids === allUuids throughout.
//
// Predictions (wire):
//   abort-untouched (2.1.250 source `Ser`: last metadata boundary IS the
//     last boundary, invalid → return, map untouched, B1 never consulted):
//     walk PA→PB→S1→B1-stop. Context: S1 + PB + PA; NONCE-U2/"4" ABSENT.
//   sequential-all (getSessionMessages model: B1 relinked, B2 skipped
//     per-boundary; gSM anchor-child pass repoints PB → four): context
//     includes NONCE-U2 + "4" + S1 + PB + PA.
//   wipe (our loadedContext divergence: trailing invalid boundary = full
//     wipe): S1/PB/PA all pre-B2 → ABSENT; probe rides on empty context.
// The free gSM run on the same fixture pins the per-consumer split.

import { randomUUID } from "node:crypto";
import {
  P1_CONTENT, U, M, boundaryPair, asLines, userEntry, assistantEntry,
  resumeProbe, gsmRun, judge, finishReport, sdkVersion,
} from "./round2.mjs";

const b1 = boundaryPair({
  logicalParent: U.red, uuids: [U.u2User, U.four],
  summaryText: "Earlier: assorted prompts. (tag: SYNTH-P15-S1)",
});
const pb = userEntry({ uuid: randomUUID(), parent: b1.summaryUuid, content: "Mid-turn marker. (tag: NONCE-P15-MID)" });
const pa = assistantEntry({ uuid: randomUUID(), parent: pb.uuid, messageId: "msg_synthp15mid",
  content: [{ type: "text", text: "Noted. P15-MID-REPLY" }] });
const b2 = boundaryPair({
  logicalParent: pa.uuid, uuids: [randomUUID()], // names no file entry → invalid
  summaryText: "unused", // summary NOT written — B2 is the file's tail
});
const content = P1_CONTENT + asLines(b1.boundary, b1.summary, pb, pa, b2.boundary);

const r = await resumeProbe("p15a-invalid-tail", content, "NONCE-P15");
const gsm = await gsmRun("p15a-invalid-tail", content);

const predictions = {
  "abort-untouched": {
    "SYNTH-P15-S1": true, "NONCE-P15-MID": true, "P15-MID-REPLY": true,
    [M.u2Tag]: false, [M.four]: false, [M.magicWord]: false,
  },
  "sequential-all": {
    "SYNTH-P15-S1": true, "NONCE-P15-MID": true, "P15-MID-REPLY": true,
    [M.u2Tag]: true, [M.four]: true, [M.magicWord]: false,
  },
  "wipe": {
    "SYNTH-P15-S1": false, "NONCE-P15-MID": false, "P15-MID-REPLY": false,
    [M.u2Tag]: false, [M.four]: false, [M.magicWord]: false,
  },
};
const { verdicts, matching } = judge(r.reqStr, predictions);

const violations = [];
if (!r.probeReq && !r.error) violations.push("no probe request captured and no error");
if (r.probeReq && matching.length === 0) violations.push("NO pre-registered prediction matches");

finishReport("p15a", {
  sdkVersion, resultSubtype: r.resultSubtype, error: r.error, stderr: r.stderr,
  nRequestMessages: r.probeReq?.body.messages.length ?? null,
  requestMessages: r.requestMessages, verdicts, matching,
  gsm: {
    u2: gsm.str.includes(M.u2Tag), four: gsm.str.includes(M.four),
    s1: gsm.str.includes("SYNTH-P15-S1"), mid: gsm.str.includes("NONCE-P15-MID"),
  },
}, violations);
