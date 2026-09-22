// P20: `eye` drop semantics + partial-message playlists — the FINDINGS
// step-4 scenario battery (presented-context predictions per shape).
//
// Base turn: user → textE (text, MSGP20) → callA → callB (all same
// message.id, native chain shape) → resultA (child of callA) → resultB
// (child of callB) → done (child of resultB).
//
// Four wire cases:
//   p20-kill0  NO boundary; file truncated after callB (killed
//     mid-response, zero results). Models:
//       eye-drops-whole: text + both calls absent (drop takes bundled text).
//       drops-calls-keeps-text: text present, calls absent.
//       kept-healed: everything present + synthetic error results.
//   p20-kill1  NO boundary; truncated after resultA (one result landed).
//     Models:
//       kept-healed-partial: message kept (not all tool_uses unresolved);
//         callB gets a synthetic error result; resultA real.
//       eye-drops-whole: text + calls + resultA absent.
//       drops-unresolved-block (post-hoc, 2.1.195–2.1.258): only callB's
//         block dropped, no heal.
//       kept-healed-interrupt (post-hoc, 2.1.280): everything kept; callB
//         gets a synthetic "[Request interrupted by user for tool use]"
//         error result.
//   p20-kill1-later  (added 2026-09-22) kill1's file continued by a later
//     user turn (user2, child of resultA) and its reply (done2). The
//     2.1.280 binary re-read (README-20260922.md) says the heal only
//     covers unresolved calls in the file's TRAILING turn, which kill1
//     cannot distinguish from "group has a real result". Models:
//       tail-heal-only (source-predicted): callB absent, no synthetic
//         result of either wording; later turn present.
//       group-heal: callB kept + "[Request interrupted…]" result.
//       stage5-heal: callB kept + "Tool result missing" (tool-pair
//         repair healing downstream instead of the sanitizer dropping).
//   p20-part1  full file + playlist [user, callA, resultA, done] — keep
//     one call + its result, drop text and the other pair. Prediction
//     cut-per-entry: callA+resultA+done present; text, callB, resultB
//     absent; no synthetic heal.
//   p20-part2  full file + playlist [user, textE, callA, resultA, done].
//     Prediction cut-per-entry: text also present; callB/resultB absent.

import { randomUUID } from "node:crypto";
import {
  userEntry, assistantEntry, toolResultEntry, boundaryPair, asLines,
  resumeProbe, judge, finishReport, sdkVersion,
} from "./round2.mjs";

const SYNTH_HEAL = "Tool result missing";
const SYNTH_INTERRUPT = "[Request interrupted by user for tool use]";
const MARKS = {
  prompt: "NONCE-P20Q", text: "P20-TEXT-MARKER", callA: "P20-A-CMD",
  callB: "P20-B-CMD", resultA: "P20-A-RESULT", resultB: "P20-B-RESULT",
  done: "P20-DONE-TEXT", user2: "P20-USER2-MARKER", done2: "P20-DONE2-TEXT",
};

function fixture() {
  const u = Object.fromEntries(
    ["user", "textE", "callA", "callB", "resultA", "resultB", "done", "user2", "done2"].map((k) => [k, randomUUID()]));
  const MSGP20 = "msg_synthp200001";
  const idA = "toolu_synthP20A00000000000001", idB = "toolu_synthP20B00000000000002";
  const entries = {
    user: userEntry({ uuid: u.user, parent: null, content: "Announce, then run both marker commands, then say done. (tag: NONCE-P20Q)" }),
    textE: assistantEntry({ uuid: u.textE, parent: u.user, messageId: MSGP20,
      content: [{ type: "text", text: "Running both: P20-TEXT-MARKER" }] }),
    callA: assistantEntry({ uuid: u.callA, parent: u.textE, messageId: MSGP20,
      content: [{ type: "tool_use", id: idA, name: "Bash", input: { command: "echo P20-A-CMD" } }] }),
    callB: assistantEntry({ uuid: u.callB, parent: u.callA, messageId: MSGP20,
      content: [{ type: "tool_use", id: idB, name: "Bash", input: { command: "echo P20-B-CMD" } }] }),
    resultA: toolResultEntry({ uuid: u.resultA, parent: u.callA, toolUseId: idA, result: "P20-A-RESULT" }),
    resultB: toolResultEntry({ uuid: u.resultB, parent: u.callB, toolUseId: idB, result: "P20-B-RESULT" }),
    done: assistantEntry({ uuid: u.done, parent: u.resultB, messageId: "msg_synthp20done",
      content: [{ type: "text", text: "Both ran. P20-DONE-TEXT" }] }),
    // kill1-later only: a turn after the killed one, parented on the one
    // result that landed (where the CLI's next write would parent).
    user2: userEntry({ uuid: u.user2, parent: u.resultA, content: "Carry on. (tag: P20-USER2-MARKER)" }),
    done2: assistantEntry({ uuid: u.done2, parent: u.user2, messageId: "msg_synthp20done2",
      content: [{ type: "text", text: "Carrying on. P20-DONE2-TEXT" }] }),
  };
  return { u, entries };
}

const pick = (entries, keys) => asLines(...keys.map((k) => entries[k]));

async function killCase(name, keys) {
  const { entries } = fixture();
  return { name, r: await resumeProbe(name, pick(entries, keys), `NONCE-${name.toUpperCase()}`) };
}
async function playlistCase(name, keys) {
  const { u, entries } = fixture();
  const pair = boundaryPair({
    logicalParent: u.done, uuids: keys.map((k) => u[k]),
    summaryText: `Earlier: marker exchange. (tag: SYNTH-${name.toUpperCase()}-SUMMARY)`,
  });
  const content = pick(entries, ["user", "textE", "callA", "callB", "resultA", "resultB", "done"])
    + asLines(pair.boundary, pair.summary);
  return { name, r: await resumeProbe(name, content, `NONCE-${name.toUpperCase()}`) };
}

const kill0 = await killCase("p20-kill0", ["user", "textE", "callA", "callB"]);
const kill1 = await killCase("p20-kill1", ["user", "textE", "callA", "callB", "resultA"]);
const kill1Later = await killCase("p20-kill1-later", ["user", "textE", "callA", "callB", "resultA", "user2", "done2"]);
const part1 = await playlistCase("p20-part1", ["user", "callA", "resultA", "done"]);
const part2 = await playlistCase("p20-part2", ["user", "textE", "callA", "resultA", "done"]);

const violations = [];
for (const c of [kill0, kill1, kill1Later, part1, part2]) {
  if (c.r.error) violations.push(`${c.name} error: ${c.r.error}`);
  if (c.r.resultSubtype !== "success") violations.push(`${c.name} result subtype ${c.r.resultSubtype}`);
  if (!c.r.probeReq) violations.push(`${c.name}: no probe request captured`);
}

const judged = {
  kill0: judge(kill0.r.reqStr, {
    "eye-drops-whole": { [MARKS.prompt]: true, [MARKS.text]: false, [MARKS.callA]: false, [MARKS.callB]: false },
    "drops-calls-keeps-text": { [MARKS.prompt]: true, [MARKS.text]: true, [MARKS.callA]: false, [MARKS.callB]: false },
    "kept-healed": { [MARKS.prompt]: true, [MARKS.text]: true, [MARKS.callA]: true, [MARKS.callB]: true, [SYNTH_HEAL]: true },
  }),
  kill1: judge(kill1.r.reqStr, {
    "kept-healed-partial": { [MARKS.text]: true, [MARKS.callA]: true, [MARKS.callB]: true,
      [MARKS.resultA]: true, [SYNTH_HEAL]: true },
    "eye-drops-whole": { [MARKS.text]: false, [MARKS.callA]: false, [MARKS.callB]: false, [MARKS.resultA]: false },
    // Added POST-HOC from run 1 (2026-08-29), which falsified both models
    // above: the unresolved callB BLOCK was dropped with no synthetic
    // heal (the resume sanitizer removes it before `_vt` runs); text,
    // callA, resultA kept. Run 1 also showed the CLI appending a
    // "Continue from where you left off" user text (merged into the
    // result message) + a "No response requested." assistant turn when
    // the file ends on a tool result.
    "drops-unresolved-block": { [MARKS.text]: true, [MARKS.callA]: true, [MARKS.resultA]: true,
      [MARKS.callB]: false, [SYNTH_HEAL]: false },
    // Added POST-HOC from the 2.1.280 run (2026-09-22): the group has one
    // answered call, so every call is kept and the unanswered callB gets a
    // synthetic `is_error` result reading "[Request interrupted by user
    // for tool use]" (not the SYNTH_HEAL wording), followed by the same
    // "Continue from where you left off" / "No response requested." tail.
    "kept-healed-interrupt": { [MARKS.text]: true, [MARKS.callA]: true, [MARKS.callB]: true,
      [MARKS.resultA]: true, [SYNTH_INTERRUPT]: true, [SYNTH_HEAL]: false },
  }),
  "kill1-later": judge(kill1Later.r.reqStr, {
    "tail-heal-only": { [MARKS.text]: true, [MARKS.callA]: true, [MARKS.resultA]: true,
      [MARKS.callB]: false, [SYNTH_INTERRUPT]: false, [SYNTH_HEAL]: false,
      [MARKS.user2]: true, [MARKS.done2]: true },
    "group-heal": { [MARKS.text]: true, [MARKS.callA]: true, [MARKS.resultA]: true,
      [MARKS.callB]: true, [SYNTH_INTERRUPT]: true, [SYNTH_HEAL]: false,
      [MARKS.user2]: true, [MARKS.done2]: true },
    "stage5-heal": { [MARKS.text]: true, [MARKS.callA]: true, [MARKS.resultA]: true,
      [MARKS.callB]: true, [SYNTH_INTERRUPT]: false, [SYNTH_HEAL]: true,
      [MARKS.user2]: true, [MARKS.done2]: true },
  }),
  part1: judge(part1.r.reqStr, {
    "cut-per-entry": { [MARKS.callA]: true, [MARKS.resultA]: true, [MARKS.done]: true,
      [MARKS.text]: false, [MARKS.callB]: false, [MARKS.resultB]: false, [SYNTH_HEAL]: false },
    "expansion-recovers": { [MARKS.callA]: true, [MARKS.resultA]: true, [MARKS.done]: true,
      [MARKS.text]: true, [MARKS.callB]: true, [MARKS.resultB]: true },
  }),
  part2: judge(part2.r.reqStr, {
    "cut-per-entry": { [MARKS.text]: true, [MARKS.callA]: true, [MARKS.resultA]: true, [MARKS.done]: true,
      [MARKS.callB]: false, [MARKS.resultB]: false, [SYNTH_HEAL]: false },
    "expansion-recovers": { [MARKS.text]: true, [MARKS.callA]: true, [MARKS.resultA]: true, [MARKS.done]: true,
      [MARKS.callB]: true, [MARKS.resultB]: true },
  }),
};
for (const [k, { matching }] of Object.entries(judged)) {
  const c = { kill0, kill1, "kill1-later": kill1Later, part1, part2 }[k];
  if (c.r.probeReq && matching.length === 0) violations.push(`${k}: NO pre-registered prediction matches`);
}

finishReport("p20", {
  sdkVersion,
  cases: Object.fromEntries([kill0, kill1, kill1Later, part1, part2].map((c) => {
    const k = c.name.replace("p20-", "");
    return [c.name, {
      resultSubtype: c.r.resultSubtype, error: c.r.error, stderr: c.r.stderr,
      verdicts: judged[k].verdicts, matching: judged[k].matching,
      requestMessages: c.r.requestMessages,
    }];
  })),
}, violations);
