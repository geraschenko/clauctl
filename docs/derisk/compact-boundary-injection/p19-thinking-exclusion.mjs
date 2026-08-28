// P19: thinking-sibling exclusion — the direction p11a wrongly skipped.
//
// Round-1 p2-a showed SAME-model resume forwards signed thinking blocks
// on the wire (only cross-model strips, P6), so a thinking fixture IS
// wire-discriminable. Fixture: the real p1 fixture (haiku, signed
// thinking); thinkT3 ("…magic word clearly") and magic (XYLOPHONE text)
// are same-message.id siblings (iWsmRM6C).
//
// Three wire cases, all resumed with the SAME model (haiku):
//   p19-control     plain resume, no boundary. Asserts thinking blocks
//     reach the wire on 2.1.250 (re-establishes p2-a on this version).
//   p19-excl-think  playlist = full chain minus thinkT3.
//     cut-before-expansion: thinkT3's text absent, XYLOPHONE present,
//     OTHER on-playlist thinking still present.
//     expansion-recovers: thinkT3's text present too.
//   p19-excl-text   playlist = full chain minus magic.
//     cut-before-expansion: XYLOPHONE absent, thinkT3's text present.
//     expansion-recovers: XYLOPHONE present too.

import {
  U, M, P1_CONTENT, boundaryPair, asLines, resumeProbe, judge,
  finishReport, sdkVersion,
} from "./round2.mjs";
import { EXP_DIR, readJsonl } from "./harness.mjs";

// Full chain order, derived by walking parents from the leaf (red) —
// includes two attachment entries between u1User and thinkT1 (harmless
// in playlists, P3 m6).
const CHAIN_UUIDS = (() => {
  const byUuid = Object.fromEntries(
    readJsonl(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`).filter((e) => e.uuid).map((e) => [e.uuid, e]));
  const chain = [];
  for (let cur = U.red; cur; cur = byUuid[cur]?.parentUuid) chain.unshift(cur);
  if (chain[0] !== U.u1User) throw new Error("chain walk did not reach u1User");
  return chain;
})();

const THINK_T3 = "magic word clearly";       // thinkT3's thinking text
const THINK_U2 = "simple math question";     // thinkU2 — on-playlist thinking control
const THINKING_BLOCK = '"type":"thinking"';
// magic's TEXT is "The magic word is **XYLOPHONE-77431**" — the ** makes
// it unique; bare M.magicWord also occurs in result2's tool_result (run-1
// marker-collision lesson).
const MAGIC_TEXT = "**XYLOPHONE-77431**";

async function runCase(name, excludeKey) {
  let content;
  if (excludeKey === null) content = P1_CONTENT;
  else {
    const uuids = CHAIN_UUIDS.filter((id) => id !== U[excludeKey]);
    const pair = boundaryPair({
      logicalParent: U.red, uuids,
      summaryText: `Earlier: fixture replay. (tag: SYNTH-${name.toUpperCase()}-SUMMARY)`,
    });
    content = P1_CONTENT + asLines(pair.boundary, pair.summary);
  }
  return { name, r: await resumeProbe(name, content, `NONCE-${name.toUpperCase()}`) };
}

const control = await runCase("p19-control", null);
const exclThink = await runCase("p19-excl-think", "thinkT3");
const exclText = await runCase("p19-excl-text", "magic");

const violations = [];
for (const c of [control, exclThink, exclText]) {
  if (c.r.error) violations.push(`${c.name} error: ${c.r.error}`);
  if (c.r.resultSubtype !== "success") violations.push(`${c.name} result subtype ${c.r.resultSubtype}`);
  if (!c.r.probeReq) violations.push(`${c.name}: no probe request captured`);
}

// Control: same-model thinking must reach the wire, else the exclusion
// cases cannot discriminate (the P1 d masking lesson).
const controlThinking = control.r.reqStr.includes(THINKING_BLOCK) && control.r.reqStr.includes(THINK_T3);
if (control.r.probeReq && !controlThinking)
  violations.push("control: same-model resume did NOT forward thinking — exclusion cases are masked");

const verdictsThink = judge(exclThink.r.reqStr, {
  "cut-before-expansion": { [THINK_T3]: false, [MAGIC_TEXT]: true, [THINK_U2]: true, [M.u1Tag]: true },
  "expansion-recovers": { [THINK_T3]: true, [MAGIC_TEXT]: true, [THINK_U2]: true, [M.u1Tag]: true },
});
// "thinking-only-dropped" was added POST-HOC from run 1 (2026-08-29),
// which falsified both original models: with magic cut, thinkT3 became a
// thinking-only assistant message and vanished from the wire entirely.
const verdictsText = judge(exclText.r.reqStr, {
  "cut-per-entry": { [MAGIC_TEXT]: false, [THINK_T3]: true, [THINK_U2]: true, [M.u1Tag]: true },
  "thinking-only-dropped": { [MAGIC_TEXT]: false, [THINK_T3]: false, [THINK_U2]: true, [M.u1Tag]: true },
  "expansion-recovers": { [MAGIC_TEXT]: true, [THINK_T3]: true, [THINK_U2]: true, [M.u1Tag]: true },
});
if (exclThink.r.probeReq && verdictsThink.matching.length === 0)
  violations.push("excl-think: NO pre-registered prediction matches");
if (exclText.r.probeReq && verdictsText.matching.length === 0)
  violations.push("excl-text: NO pre-registered prediction matches");

finishReport("p19", {
  sdkVersion,
  control: {
    resultSubtype: control.r.resultSubtype, error: control.r.error, stderr: control.r.stderr,
    thinkingOnWire: controlThinking,
    nThinkingBlocks: (control.r.reqStr.match(/"type":"thinking"/g) ?? []).length,
  },
  exclThink: { resultSubtype: exclThink.r.resultSubtype, stderr: exclThink.r.stderr,
    verdicts: verdictsThink.verdicts, matching: verdictsThink.matching,
    requestMessages: exclThink.r.requestMessages },
  exclText: { resultSubtype: exclText.r.resultSubtype, stderr: exclText.r.stderr,
    verdicts: verdictsText.verdicts, matching: verdictsText.matching,
    requestMessages: exclText.r.requestMessages },
}, violations);
