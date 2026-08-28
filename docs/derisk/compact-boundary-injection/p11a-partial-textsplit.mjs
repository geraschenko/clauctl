// P11a: partial-API-message playlist, text+tool_use split.
//
// DESIGN NOTE (deviation from the reviewed plan): the reviewer's fixture
// excluded a THINKING sibling, but normalization may strip historical
// thinking regardless of the relink, which would mask the discriminator
// (the P1 d lesson). This fixture splits a same-message.id TEXT + tool_use
// pair instead — both halves wire-visible, no signature risk. The excluded
// entry is the text sibling.
//
// Fixture: user → A1 (text MIX-TEXT, id MSGMIX) → A2 (tool_use, id
// MSGMIX) → R (result) → done. Boundary playlist keeps [user, A2, R,
// done], excluding A1. uuids === allUuids.
//
// Predictions:
//   cut-before-expansion (2.1.250 source, `Ser` then `Aer`): A1's text is
//     deleted by the cut before expansion runs → MIX-TEXT absent on the
//     wire. getSessionMessages (no cut) keeps it.
//   expansion-recovers: MIX-TEXT present on the wire too.

import { randomUUID } from "node:crypto";
import {
  userEntry, assistantEntry, toolResultEntry, boundaryPair, asLines,
  resumeProbe, gsmRun, judge, finishReport, sdkVersion,
} from "./round2.mjs";

const u = Object.fromEntries(["user", "a1", "a2", "r", "done"].map((k) => [k, randomUUID()]));
const MSGMIX = "msg_synthmix0001";
const entries = [
  userEntry({ uuid: u.user, parent: null, content: "Say the mix marker, then run the mix command. (tag: NONCE-P11AQ)" }),
  assistantEntry({ uuid: u.a1, parent: u.user, messageId: MSGMIX,
    content: [{ type: "text", text: "Here it is: MIX-TEXT-MARKER" }] }),
  assistantEntry({ uuid: u.a2, parent: u.a1, messageId: MSGMIX,
    content: [{ type: "tool_use", id: "toolu_synthMIX00000000000001", name: "Bash", input: { command: "echo MIX-CMD" } }] }),
  toolResultEntry({ uuid: u.r, parent: u.a2, toolUseId: "toolu_synthMIX00000000000001", result: "MIX-CMD-RESULT" }),
  assistantEntry({ uuid: u.done, parent: u.r, messageId: "msg_synthmixdone",
    content: [{ type: "text", text: "Ran it. MIX-DONE-TEXT" }] }),
];
const pair = boundaryPair({
  logicalParent: u.done, uuids: [u.user, u.a2, u.r, u.done],
  summaryText: "Earlier: a mix marker exchange. (tag: SYNTH-P11A-SUMMARY)",
});
const content = asLines(...entries, pair.boundary, pair.summary);

const r = await resumeProbe("p11a-textsplit", content, "NONCE-P11A");
const gsm = await gsmRun("p11a-textsplit", content);

const common = { "NONCE-P11AQ": true, "MIX-CMD-RESULT": true, "MIX-DONE-TEXT": true, "SYNTH-P11A-SUMMARY": true };
const predictions = {
  "cut-before-expansion": { ...common, "MIX-TEXT-MARKER": false },
  "expansion-recovers": { ...common, "MIX-TEXT-MARKER": true },
};
const { verdicts, matching } = judge(r.reqStr, predictions);

const violations = [];
if (r.error) violations.push(`error: ${r.error}`);
if (r.resultSubtype !== "success") violations.push(`result subtype ${r.resultSubtype}`);
if (!r.probeReq) violations.push("no probe request captured");
if (r.probeReq && matching.length === 0) violations.push("NO pre-registered prediction matches");
// gSM (no cut + expansion) must keep the excluded sibling — P8's divergence.
if (!gsm.str.includes("MIX-TEXT-MARKER")) violations.push("gSM unexpectedly lost the excluded sibling");

finishReport("p11a", {
  sdkVersion, resultSubtype: r.resultSubtype, error: r.error, stderr: r.stderr,
  nRequestMessages: r.probeReq?.body.messages.length ?? null,
  requestMessages: r.requestMessages, verdicts, matching,
  gsm: { includesExcludedSibling: gsm.str.includes("MIX-TEXT-MARKER"), nMessages: gsm.msgs.length },
}, violations);
