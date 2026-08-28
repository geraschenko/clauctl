// P16: cut vs no-cut (D3) — a post-boundary entry whose raw parent is a
// non-preserved PRE-boundary entry, plus the control chain parented on
// the playlist tail (the summary→playlist path itself).
//
// Fixture: p1 content + boundary (playlist [u2User, four], anchor =
// summary) + summary + ORPH (synthetic user, parent = red — pre-boundary,
// NOT preserved) + ORA (assistant reply, the leaf).
//
// Predictions (wire, resume):
//   cut-plus-reparent (2.1.250 source `Ser`): red is deleted; ORPH is a
//     surviving child of a deleted entry → repointed to the playlist tail
//     (four). Walk: ORA→ORPH→four→u2User→summary→stop. Context: summary +
//     NONCE-U2 + "4" + ORPH + ORA; Red/NONCE-U3/XYLOPHONE ABSENT.
//   no-cut (getSessionMessages model): ORPH's raw parent followed →
//     Red/NONCE-U3 (and the rest of the raw chain) PRESENT.
// The free gSM run on the same fixture is expected to show no-cut —
// a per-consumer split, per the E2a reading.

import { randomUUID } from "node:crypto";
import {
  P1_CONTENT, U, M, boundaryPair, asLines, userEntry, assistantEntry,
  resumeProbe, gsmRun, judge, finishReport, sdkVersion,
} from "./round2.mjs";

const pair = boundaryPair({
  logicalParent: U.red, uuids: [U.u2User, U.four],
  summaryText: "Earlier: assorted prompts. (tag: SYNTH-P16-S)",
});
const orph = userEntry({ uuid: randomUUID(), parent: U.red, content: "Orphan marker. (tag: NONCE-P16-ORPHAN)" });
const ora = assistantEntry({ uuid: randomUUID(), parent: orph.uuid, messageId: "msg_synthp16reply",
  content: [{ type: "text", text: "Seen. P16-REPLY" }] });
const content = P1_CONTENT + asLines(pair.boundary, pair.summary, orph, ora);

const r = await resumeProbe("p16-cut", content, "NONCE-P16");
const gsm = await gsmRun("p16-cut", content);

const predictions = {
  "cut-plus-reparent": {
    "SYNTH-P16-S": true, "NONCE-P16-ORPHAN": true, "P16-REPLY": true,
    [M.u2Tag]: true, [M.four]: true,
    [M.red]: false, [M.u3Tag]: false, [M.magicWord]: false,
  },
  "no-cut": {
    "NONCE-P16-ORPHAN": true, "P16-REPLY": true,
    [M.red]: true, [M.u3Tag]: true,
  },
};
const { verdicts, matching } = judge(r.reqStr, predictions);

const violations = [];
if (r.error) violations.push(`error: ${r.error}`);
if (r.resultSubtype !== "success") violations.push(`result subtype ${r.resultSubtype}`);
if (!r.probeReq) violations.push("no probe request captured");
if (r.probeReq && matching.length === 0) violations.push("NO pre-registered prediction matches");

finishReport("p16", {
  sdkVersion, resultSubtype: r.resultSubtype, error: r.error, stderr: r.stderr,
  nRequestMessages: r.probeReq?.body.messages.length ?? null,
  requestMessages: r.requestMessages, verdicts, matching,
  gsm: {
    red: gsm.str.includes(M.red), u3: gsm.str.includes(M.u3Tag),
    orphan: gsm.str.includes("NONCE-P16-ORPHAN"), u2: gsm.str.includes(M.u2Tag),
  },
}, violations);
