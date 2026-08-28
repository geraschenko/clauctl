// P18: parallel SAME-message.id tool calls through a playlist — which
// linear ordering reproduces the native presented context?
//
// Native raw shape (verified against real sessions, e.g.
// ~/.claude/projects/-home-anton/4cbaa4de…jsonl msg_018xP45…): same-id
// entries chain linearly (callA → callB), each result is a CHILD of its
// own call entry (branch at callA), and the next turn parents on the
// LAST result — so resultA is off-path, recovered only by expansion.
// NOTE: round2.mjs forkFixture() parents both calls on the user, which
// does NOT match native; p13's oracle used that shape, so p18 carries
// its own native-shaped plain-resume control.
//
// Three wire cases on the same entry set:
//   p18-native      plain resume, no boundary — the ORACLE presented shape.
//     Expected: [user:prompt][assistant:callA+callB][user:resultA+resultB]
//     [assistant:done].
//   p18-grouped     playlist [user, callA, callB, resultA, resultB, done].
//     Prediction "matches-native": consecutive same-id entries reassemble
//     into one assistant API message, the adjacent result-users merge, and
//     both results sit immediately after their calls — oracle shape.
//   p18-interleaved playlist [user, callA, resultA, callB, resultB, done].
//     A user entry splits the same-id group. Pre-registered models:
//     "interleaved-pairs" [assistant:callA][user:resultA][assistant:callB]
//     [user:resultB] (content complete, non-native shape) or
//     "matches-native" (normalization reorders). Anything else is
//     characterized in the report (exploratory), not a violation.
//
// Shape = sequence of API messages containing our markers: role + which
// markers. The boundary summary merges into the adjacent user message
// ($oe), so the summary text carries no marker and is ignored by shapes.

import { randomUUID } from "node:crypto";
import {
  userEntry, assistantEntry, toolResultEntry, boundaryPair, asLines,
  resumeProbe, finishReport, sdkVersion,
} from "./round2.mjs";

const MARKS = {
  prompt: "NONCE-P18Q", callA: "PAR-A-CMD", callB: "PAR-B-CMD",
  resultA: "PAR-A-RESULT", resultB: "PAR-B-RESULT", done: "PAR-DONE-TEXT",
};

function nativeParallelFixture() {
  const u = Object.fromEntries(
    ["user", "callA", "callB", "resultA", "resultB", "done"].map((k) => [k, randomUUID()]));
  const MSGPAR = "msg_synthpar0001";
  const idA = "toolu_synthPARA00000000000001", idB = "toolu_synthPARB00000000000002";
  const entries = [
    userEntry({ uuid: u.user, parent: null, content: "Run both marker commands in parallel, then say done. (tag: NONCE-P18Q)" }),
    assistantEntry({ uuid: u.callA, parent: u.user, messageId: MSGPAR,
      content: [{ type: "tool_use", id: idA, name: "Bash", input: { command: "echo PAR-A-CMD" } }] }),
    assistantEntry({ uuid: u.callB, parent: u.callA, messageId: MSGPAR,
      content: [{ type: "tool_use", id: idB, name: "Bash", input: { command: "echo PAR-B-CMD" } }] }),
    toolResultEntry({ uuid: u.resultA, parent: u.callA, toolUseId: idA, result: "PAR-A-RESULT" }),
    toolResultEntry({ uuid: u.resultB, parent: u.callB, toolUseId: idB, result: "PAR-B-RESULT" }),
    assistantEntry({ uuid: u.done, parent: u.resultB, messageId: "msg_synthpardone",
      content: [{ type: "text", text: "Both ran. PAR-DONE-TEXT" }] }),
  ];
  return { u, entries };
}

const shapeOf = (probeReq) => probeReq === null ? null : probeReq.body.messages
  .map((m) => {
    const s = JSON.stringify(m.content);
    return { role: m.role, has: Object.keys(MARKS).filter((k) => s.includes(MARKS[k])) };
  })
  .filter((x) => x.has.length)
  .map((x) => `${x.role}:${x.has.join("+")}`);

async function runCase(name, playlistOrNull) {
  const { u, entries } = nativeParallelFixture();
  let content;
  if (playlistOrNull === null) content = asLines(...entries);
  else {
    const pair = boundaryPair({
      logicalParent: u.done, uuids: playlistOrNull.map((k) => u[k]),
      summaryText: "Earlier: a parallel marker exchange. (tag: SYNTH-P18-SUMMARY)",
    });
    content = asLines(...entries, pair.boundary, pair.summary);
  }
  const r = await resumeProbe(name, content, `NONCE-${name.toUpperCase()}`);
  return { name, r, shape: shapeOf(r.probeReq) };
}

const EXPECTED_NATIVE = ["user:prompt", "assistant:callA+callB", "user:resultA+resultB", "assistant:done"];
const EXPECTED_INTERLEAVED_PAIRS =
  ["user:prompt", "assistant:callA", "user:resultA", "assistant:callB", "user:resultB", "assistant:done"];

const native = await runCase("p18-native", null);
const grouped = await runCase("p18-grouped", ["user", "callA", "callB", "resultA", "resultB", "done"]);
const interleaved = await runCase("p18-interleaved", ["user", "callA", "resultA", "callB", "resultB", "done"]);

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const violations = [];
for (const c of [native, grouped, interleaved]) {
  if (c.r.error) violations.push(`${c.name} error: ${c.r.error}`);
  if (c.r.resultSubtype !== "success") violations.push(`${c.name} result subtype ${c.r.resultSubtype}`);
  if (!c.r.probeReq) violations.push(`${c.name}: no probe request captured`);
}
if (native.shape && !eq(native.shape, EXPECTED_NATIVE))
  violations.push(`oracle shape unexpected: ${JSON.stringify(native.shape)}`);
if (grouped.shape && native.shape && !eq(grouped.shape, native.shape))
  violations.push(`grouped ordering did NOT reproduce the native presented shape: ${JSON.stringify(grouped.shape)}`);

const interleavedVerdict = !interleaved.shape ? "no-capture"
  : eq(interleaved.shape, native.shape) ? "matches-native"
  : eq(interleaved.shape, EXPECTED_INTERLEAVED_PAIRS) ? "interleaved-pairs"
  : "OTHER (see shapes)";

finishReport("p18", {
  sdkVersion,
  cases: Object.fromEntries([native, grouped, interleaved].map((c) => [c.name, {
    resultSubtype: c.r.resultSubtype, error: c.r.error, stderr: c.r.stderr,
    shape: c.shape, requestMessages: c.r.requestMessages,
  }])),
  oracleShape: native.shape,
  groupedMatchesNative: !!(grouped.shape && native.shape && eq(grouped.shape, native.shape)),
  interleavedVerdict,
  syntheticHealMarkers: {
    grouped: grouped.r.reqStr.includes("Tool result missing"),
    interleaved: interleaved.r.reqStr.includes("Tool result missing"),
  },
}, violations);
