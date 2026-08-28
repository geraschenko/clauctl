// P17: playlist keeps a tool call but not its result — set-context goal
// (a)'s direct question (live ee0d boundary 1 shape, now wire-asserted).
//
// Fixture: user → A (tool_use, own message.id) → R (result) → done
// (text, own id). Playlist [user, A, done] excluding R. uuids ===
// allUuids.
//
// Predictions (wire):
//   eye-drop (resume sanitizer drops assistant messages whose tool_uses
//     are all unresolved): A's tool_use id ABSENT, no synthetic repair
//     text; user + done present.
//   vt-heal (`_vt` pairing repair): A's tool_use id PRESENT plus the
//     synthetic "[Tool result missing due to internal error]" result;
//     R's real payload still absent.
// Either way the real result payload must be absent (it was cut).

import { randomUUID } from "node:crypto";
import {
  userEntry, assistantEntry, toolResultEntry, boundaryPair, asLines,
  resumeProbe, judge, finishReport, sdkVersion,
} from "./round2.mjs";

const u = Object.fromEntries(["user", "a", "r", "done"].map((k) => [k, randomUUID()]));
const TOOL_ID = "toolu_synthP17000000000001";
const entries = [
  userEntry({ uuid: u.user, parent: null, content: "Run the p17 command. (tag: NONCE-P17Q)" }),
  assistantEntry({ uuid: u.a, parent: u.user, messageId: "msg_synthp17call",
    content: [{ type: "tool_use", id: TOOL_ID, name: "Bash", input: { command: "echo P17-CMD" } }] }),
  toolResultEntry({ uuid: u.r, parent: u.a, toolUseId: TOOL_ID, result: "P17-CMD-RESULT" }),
  assistantEntry({ uuid: u.done, parent: u.r, messageId: "msg_synthp17done",
    content: [{ type: "text", text: "Ran it. P17-DONE-TEXT" }] }),
];
const pair = boundaryPair({
  logicalParent: u.done, uuids: [u.user, u.a, u.done],
  summaryText: "Earlier: a command ran. (tag: SYNTH-P17-SUMMARY)",
});
const content = asLines(...entries, pair.boundary, pair.summary);

const r = await resumeProbe("p17-callonly", content, "NONCE-P17");

const common = {
  "NONCE-P17Q": true, "P17-DONE-TEXT": true, "SYNTH-P17-SUMMARY": true,
  "P17-CMD-RESULT": false,
};
const predictions = {
  "eye-drop": { ...common, [TOOL_ID]: false, "Tool result missing due to internal error": false },
  "vt-heal": { ...common, [TOOL_ID]: true, "Tool result missing due to internal error": true },
};
const { verdicts, matching } = judge(r.reqStr, predictions);

const violations = [];
if (r.error) violations.push(`error: ${r.error}`);
if (r.resultSubtype !== "success") violations.push(`result subtype ${r.resultSubtype}`);
if (!r.probeReq) violations.push("no probe request captured");
if (r.probeReq && matching.length === 0) violations.push("NO pre-registered prediction matches");

finishReport("p17", {
  sdkVersion, resultSubtype: r.resultSubtype, error: r.error, stderr: r.stderr,
  nRequestMessages: r.probeReq?.body.messages.length ?? null,
  requestMessages: r.requestMessages, verdicts, matching,
}, violations);
