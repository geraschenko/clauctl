// Shared plumbing for the round-2 probes (README-20260828.md, E3).
//
// Fixture base: captures/p1-fixture-pre.jsonl (a real haiku session with
// signed thinking + tool turns). Synthetic entries mimic the CLI's jsonl
// shape closely enough for the loader; only thinking blocks need REAL
// signatures (API-verified), so synthetics never carry thinking.
//
// Probe style: resume the fixture through the recording shim, send one
// probe turn, assert on the captured outbound request (never model
// recall). Discriminator probes pre-register per-model predictions and
// report which matched; violations only when sanity fails or NO
// pre-registered prediction matches.

import {
  makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, readJsonl, EXP_DIR, REPO_DIR, projectKey, HAIKU,
} from "./harness.mjs";
import { getSessionMessages } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const CWD = "/tmp/clauctl-cbi-derisk/p0b-native-compact-cwd";
export const SESSION_ID = "c4a1bb69-58cb-4e57-b5f9-7f7e27a9fe36";
export const sdkVersion = JSON.parse(fs.readFileSync(
  path.join(REPO_DIR, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version;

export const P1_CONTENT = fs.readFileSync(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`, "utf8");

/** p1-fixture uuids by role (8-char prefixes resolved to full uuids).
 *  Same-message.id pairs: thinkU2+four (g2dmaaim), thinkU3+red (1ohCpJFd),
 *  thinkT1+call1 (yctD36wg), thinkT2+call2 (B2X5qtw9), thinkT3+magic
 *  (iWsmRM6C). call2's tool_use_id: toolu_019QEjxGUTxVVwrPKv3YWPD2. */
export const U = {
  u1User: "815b1fad", thinkT1: "54a37d1c", call1: "309f0cfc", result1: "c8afccff",
  thinkT2: "59e71878", call2: "64aae3ff", result2: "87c8b882",
  thinkT3: "5c67b617", magic: "7844a932",
  u2User: "d6c57604", thinkU2: "9f8ab726", four: "d16f84b0",
  u3User: "1a44a1ac", thinkU3: "a6941d02", red: "254029a1",
};
{
  const byPrefix = Object.fromEntries(readJsonl(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`)
    .filter((e) => e.uuid).map((e) => [e.uuid.slice(0, 8), e.uuid]));
  for (const k of Object.keys(U)) {
    if (byPrefix[U[k]] === undefined) throw new Error(`fixture uuid prefix ${U[k]} (${k}) not found`);
    U[k] = byPrefix[U[k]];
  }
}

/** Wire-visible content markers from the fixture. (Thinking text IS a
 *  reliable wire marker on SAME-model resume — p2-a round 1, p19 control
 *  round 2; only cross-model resume strips thinking, P6. p11a's
 *  text+tool_use substitution was based on the opposite, wrong, belief.) */
export const M = {
  u1Tag: "NONCE-U1", magicWord: "XYLOPHONE-77431",
  u2Tag: "NONCE-U2", four: '"text":"4"',
  u3Tag: "NONCE-U3", red: '"text":"Red"',
  call2Id: "toolu_019QEjxGUTxVVwrPKv3YWPD2",
};

const COMMON = {
  isSidechain: false, userType: "external", entrypoint: "sdk-cli",
  cwd: CWD, sessionId: SESSION_ID, version: "2.1.250", gitBranch: "HEAD",
};
const ts = () => new Date().toISOString();

export const userEntry = ({ uuid, parent, content }) => ({
  ...COMMON, parentUuid: parent, type: "user", uuid, timestamp: ts(),
  message: { role: "user", content },
});

export const assistantEntry = ({ uuid, parent, messageId, content }) => ({
  ...COMMON, parentUuid: parent, type: "assistant", uuid, timestamp: ts(),
  requestId: "req_synth", message: {
    id: messageId, type: "message", role: "assistant", model: HAIKU,
    content, stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});

export const toolResultEntry = ({ uuid, parent, toolUseId, result }) => ({
  ...COMMON, parentUuid: parent, type: "user", uuid, timestamp: ts(),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }] },
  toolUseResult: { stdout: result, stderr: "", interrupted: false, isImage: false },
});

/** Boundary + summary pair in the CLI's native shape: boundary first
 *  (null parent, logicalParentUuid = where compaction happened), summary
 *  as the boundary's child; anchorUuid = the summary. */
export function boundaryPair({ logicalParent, uuids, allUuids = uuids, summaryText, boundaryUuid = randomUUID(), summaryUuid = randomUUID() }) {
  const boundary = {
    ...COMMON, parentUuid: null, logicalParentUuid: logicalParent,
    type: "system", subtype: "compact_boundary", content: "Conversation compacted",
    isMeta: false, uuid: boundaryUuid, level: "info", timestamp: ts(),
    compactMetadata: {
      trigger: "manual", preTokens: 40000, durationMs: 1, postTokens: 1000,
      preservedMessages: { anchorUuid: summaryUuid, uuids, allUuids },
    },
  };
  const summary = {
    ...COMMON, parentUuid: boundaryUuid, type: "user", uuid: summaryUuid, timestamp: ts(),
    isCompactSummary: true, isVisibleInTranscriptOnly: true,
    message: { role: "user", content: summaryText },
  };
  return { boundary, summary, boundaryUuid, summaryUuid };
}

export const asLines = (...entries) => entries.map((e) => JSON.stringify(e) + "\n").join("");

/** In-turn fork fixture (standalone file, no boundary): user prompt, two
 *  same-`message.id` sibling tool_use entries (both children of the user —
 *  the tui-parity fork shape, only A1 on the path to the leaf), each with
 *  its own tool_result child, then a continuation from R1. */
export function forkFixture() {
  const id = (p) => `${p}-${randomUUID()}`;
  const u = { user: id("u"), a1: id("a1"), a2: id("a2"), r1: id("r1"), r2: id("r2"), done: id("done") };
  const MSG_FORK = "msg_synthfork01";
  const entries = [
    userEntry({ uuid: u.user, parent: null, content: "Run both marker commands in parallel, then say done. (tag: NONCE-FORKQ)" }),
    assistantEntry({ uuid: u.a1, parent: u.user, messageId: MSG_FORK,
      content: [{ type: "tool_use", id: "toolu_synthFORKA0000000000001", name: "Bash", input: { command: "echo FORK-A-CMD" } }] }),
    assistantEntry({ uuid: u.a2, parent: u.user, messageId: MSG_FORK,
      content: [{ type: "tool_use", id: "toolu_synthFORKB0000000000002", name: "Bash", input: { command: "echo FORK-B-CMD" } }] }),
    toolResultEntry({ uuid: u.r1, parent: u.a1, toolUseId: "toolu_synthFORKA0000000000001", result: "FORK-A-RESULT" }),
    toolResultEntry({ uuid: u.r2, parent: u.a2, toolUseId: "toolu_synthFORKB0000000000002", result: "FORK-B-RESULT" }),
    assistantEntry({ uuid: u.done, parent: u.r1, messageId: "msg_synthforkdone",
      content: [{ type: "text", text: "Both ran. FORK-DONE-TEXT" }] }),
  ];
  const markers = {
    prompt: "NONCE-FORKQ", callA: "FORK-A-CMD", callB: "FORK-B-CMD",
    resultA: "FORK-A-RESULT", resultB: "FORK-B-RESULT", doneText: "FORK-DONE-TEXT",
  };
  return { uuids: u, entries, content: asLines(...entries), markers };
}

/** Resume fileContent through the shim; one probe turn; return the
 *  captured probe request. Never throws on session failure — errors land
 *  in the result for the report. */
export async function resumeProbe(caseName, fileContent, nonce) {
  const configDir = makeConfigDir(caseName);
  const projDir = path.join(configDir, "projects", projectKey(CWD));
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, `${SESSION_ID}.jsonl`), fileContent);
  const capture = `${EXP_DIR}/captures/${caseName}-requests.jsonl`;
  const shim = await startShim(capture);
  let stderrBuf = "";
  const s = makeSession({
    model: HAIKU, cwd: CWD, resume: SESSION_ID,
    stderr: (d) => { stderrBuf += d; },
    env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
  });
  let error = null, resultSubtype = null;
  try {
    const msgs = await s.send(`Reply with exactly the word pong. (tag: ${nonce})`);
    resultSubtype = msgs.find((m) => m.type === "result")?.subtype ?? null;
  } catch (e) { error = String(e); }
  s.close();
  shim.kill();
  const inference = fs.existsSync(capture) ? readCapturedInference(capture) : [];
  const probeReq = inference.find((r) => JSON.stringify(r.body.messages).includes(nonce)) ?? null;
  return {
    error, resultSubtype, stderr: stderrBuf.trim().slice(0, 300) || null,
    probeReq, reqStr: probeReq ? JSON.stringify(probeReq.body.messages) : "",
    requestMessages: probeReq
      ? probeReq.body.messages.map((m) => `${m.role}: ${JSON.stringify(m.content).slice(0, 140)}`)
      : null,
  };
}

/** The free consumer: getSessionMessages over the same fileContent. */
export async function gsmRun(caseName, fileContent) {
  const configDir = makeConfigDir(`${caseName}-gsm`);
  const projDir = path.join(configDir, "projects", projectKey(CWD));
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, `${SESSION_ID}.jsonl`), fileContent);
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const msgs = await getSessionMessages(SESSION_ID, { dir: CWD });
  return { msgs, str: JSON.stringify(msgs), uuids: msgs.map((m) => m.uuid) };
}

/** Evaluate named predictions (marker → expected presence) against the
 *  probe request. Returns per-prediction verdicts and which fully match. */
export function judge(reqStr, predictions) {
  const verdicts = {};
  for (const [model, expectation] of Object.entries(predictions)) {
    const mismatches = Object.entries(expectation)
      .filter(([marker, expected]) => reqStr.includes(marker) !== expected)
      .map(([marker, expected]) => `${expected ? "missing" : "unexpectedly present"}: ${marker.slice(0, 40)}`);
    verdicts[model] = { matches: mismatches.length === 0, mismatches };
  }
  return { verdicts, matching: Object.keys(verdicts).filter((k) => verdicts[k].matches) };
}

export function finishReport(name, report, violations) {
  report.violations = violations;
  fs.writeFileSync(`${EXP_DIR}/captures/${name}-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(violations.length ? `VIOLATIONS:\n${violations.join("\n")}` : `PASS — ${name}`);
  if (violations.length) process.exitCode = 1;
}
