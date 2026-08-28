// P12: consecutive-user retention through a boundary.
//
// Variant 1: playlist keeps the three PLAIN user prompts of the p1
// fixture [u1User, u2User, u3User] with no assistants — the live ee0d
// shape. Predictions:
//   merge (2.1.250 source, `$oe`/`Mse`): ALL three markers on the wire,
//     concatenated into ONE API user message (plus the summary user
//     message, which may itself merge — grouping recorded either way).
//   drop: some marker absent.
//
// Variant 2: adjacent tool_result users WITH their tool_use assistants
// retained — playlist [call1, call2, result1, result2] (two calls, then
// the two results adjacent). The calls carry different message.ids, so
// DJn should NOT merge them. Characterization: assert both tool_use ids
// and both result payloads present (any absence = orphan-sanitization or
// pairing repair kicked in — recorded, not predicted).
//
// NOTE variant 2's result2 contains the fixture magic word — presence of
// XYLOPHONE-77431 there is via the playlist, not a leak.

import {
  P1_CONTENT, U, M, boundaryPair, asLines,
  resumeProbe, judge, finishReport, sdkVersion,
} from "./round2.mjs";

const report = { sdkVersion };
const violations = [];

// --- variant 1: plain users ---
{
  const pair = boundaryPair({
    logicalParent: U.red, uuids: [U.u1User, U.u2User, U.u3User],
    summaryText: "Earlier: three short prompts. (tag: SYNTH-P12-SUMMARY)",
  });
  const r = await resumeProbe("p12-plain", P1_CONTENT + asLines(pair.boundary, pair.summary), "NONCE-P12A");
  const predictions = {
    merge: { [M.u1Tag]: true, [M.u2Tag]: true, [M.u3Tag]: true, "SYNTH-P12-SUMMARY": true,
      [M.magicWord]: false, [M.four]: false, [M.red]: false },
    drop: { [M.u1Tag]: false },
  };
  const { verdicts, matching } = judge(r.reqStr, predictions);
  const userMsgsWithMarkers = (r.probeReq?.body.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => {
      const s = JSON.stringify(m.content);
      return [M.u1Tag, M.u2Tag, M.u3Tag].filter((t) => s.includes(t));
    })
    .filter((tags) => tags.length > 0);
  if (r.error) violations.push(`plain: error ${r.error}`);
  if (!r.probeReq) violations.push("plain: no probe request captured");
  if (r.probeReq && !verdicts.merge.matches) violations.push(
    `plain: merge prediction failed: ${verdicts.merge.mismatches.join("; ")}`);
  report.plain = {
    resultSubtype: r.resultSubtype, requestMessages: r.requestMessages,
    verdicts, matching,
    grouping: { userMessagesCarryingMarkers: userMsgsWithMarkers.length, tagsPerMessage: userMsgsWithMarkers },
  };
}

// --- variant 2: adjacent tool_result users, calls retained ---
{
  const pair = boundaryPair({
    logicalParent: U.red, uuids: [U.call1, U.call2, U.result1, U.result2],
    summaryText: "Earlier: two file reads. (tag: SYNTH-P12B-SUMMARY)",
  });
  const r = await resumeProbe("p12-results", P1_CONTENT + asLines(pair.boundary, pair.summary), "NONCE-P12B");
  const CALL1 = "toolu_015ii13XPD3MW32k6MfRj7eN";
  const wire = {
    call1: r.reqStr.includes(CALL1), call2: r.reqStr.includes(M.call2Id),
    result1: r.reqStr.includes("File does not exist"), result2: r.reqStr.includes(M.magicWord),
    syntheticRepair: r.reqStr.includes("Tool result missing due to internal error"),
  };
  if (r.error) violations.push(`results: error ${r.error}`);
  if (!r.probeReq) violations.push("results: no probe request captured");
  report.results = { resultSubtype: r.resultSubtype, requestMessages: r.requestMessages, wire };
}

finishReport("p12", report, violations);
