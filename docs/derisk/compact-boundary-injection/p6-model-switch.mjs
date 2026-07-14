// P6: cross-model preserved thinking blocks (reviewer gap #2).
//
// The P1 fixture was produced end-to-end by haiku and its assistant entries
// carry signed thinking blocks. Question: after injecting a boundary that
// preserves those turns, can we resume under a DIFFERENT model?
// Three cases, all resumed with sonnet:
//   control:      plain resume, no injection — does the CLI itself forward or
//                 strip haiku-signed thinking when the model changes?
//   with-thinking: up_to injection preserving U2..U3 including thinking entries
//   no-thinking:   same preserved set minus the thinking entries
//
// Oracle: outbound probe request (model field, thinking blocks + signatures
// present?), HTTP statuses, result subtype, parentUuid of first new write.

import {
  assertVersions, makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, readJsonl, EXP_DIR, projectKey,
} from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const versions = assertVersions();
const SONNET = "claude-sonnet-4-6";

const P1 = {
  cwd: "/tmp/clauctl-cbi-derisk/p0b-native-compact-cwd",
  sessionId: "c4a1bb69-58cb-4e57-b5f9-7f7e27a9fe36",
  content: fs.readFileSync(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`, "utf8"),
  u2User: "d6c57604", thinkU2: "9f8ab726", four: "d16f84b0",
  u3User: "1a44a1ac", thinkU3: "a6941d02", red: "254029a1",
};
{
  const entries = readJsonl(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`);
  const byPrefix = Object.fromEntries(entries.filter((e) => e.uuid).map((e) => [e.uuid.slice(0, 8), e.uuid]));
  for (const [k, v] of Object.entries(P1)) {
    if (typeof v === "string" && byPrefix[v]) P1[k] = byPrefix[v];
  }
}

function withInjection(uuids, tag) {
  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const stamp = (extra) => ({
    isSidechain: false, timestamp: new Date().toISOString(), userType: "external",
    entrypoint: "sdk-cli", cwd: P1.cwd, sessionId: P1.sessionId, version: "2.1.195", gitBranch: "HEAD", ...extra,
  });
  const boundary = stamp({
    parentUuid: null, logicalParentUuid: P1.red, type: "system", subtype: "compact_boundary",
    content: "Conversation compacted", isMeta: false, uuid: boundaryUuid, level: "info",
    compactMetadata: {
      trigger: "manual", preTokens: 40000, durationMs: 1, postTokens: 1000,
      preservedMessages: { anchorUuid: summaryUuid, uuids, allUuids: uuids },
    },
  });
  const summary = stamp({
    parentUuid: boundaryUuid, type: "user",
    message: { role: "user", content: `Earlier: the user had fact.txt read (details omitted). (tag: ${tag})` },
    isVisibleInTranscriptOnly: true, isCompactSummary: true, uuid: summaryUuid,
  });
  return P1.content + JSON.stringify(boundary) + "\n" + JSON.stringify(summary) + "\n";
}

function analyzeThinking(probeReq) {
  const msgs = probeReq.body.messages;
  const blocks = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const thinking = blocks.filter((b) => b.type === "thinking");
  return {
    model: probeReq.body.model,
    nMessages: msgs.length,
    thinkingBlocks: thinking.length,
    allSigned: thinking.length > 0 && thinking.every((b) => typeof b.signature === "string" && b.signature.length > 0),
  };
}

async function runCase(name, jsonlContent, probeNonce) {
  const configDir = makeConfigDir(`p6-${name}`);
  const projDir = path.join(configDir, "projects", projectKey(P1.cwd));
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(P1.cwd, { recursive: true });
  const file = path.join(projDir, `${P1.sessionId}.jsonl`);
  fs.writeFileSync(file, jsonlContent);
  const preLines = readJsonl(file).length;
  const capture = `${EXP_DIR}/captures/p6-${name}-requests.jsonl`;
  const shim = await startShim(capture);
  let stderrBuf = "";
  const s = makeSession({
    model: SONNET, cwd: P1.cwd, resume: P1.sessionId,
    stderr: (d) => { stderrBuf += d; },
    env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
  });
  let error = null;
  let resultSubtype = null;
  let resultText = null;
  try {
    const msgs = await s.send(`What was the magic word in fact.txt, and what color did I pick? One line. (tag: ${probeNonce})`);
    const res = msgs.find((m) => m.type === "result");
    resultSubtype = res?.subtype;
    resultText = res?.result?.slice(0, 200) ?? null;
  } catch (e) { error = String(e); }
  s.close();
  shim.kill();

  const all = fs.existsSync(capture) ? readJsonl(capture) : [];
  const inference = fs.existsSync(capture) ? readCapturedInference(capture) : [];
  const probeReq = inference.find((r) => JSON.stringify(r.body.messages).includes(probeNonce));
  const newUser = readJsonl(file).slice(preLines)
    .find((e) => e.type === "user" && JSON.stringify(e.message?.content ?? "").includes(probeNonce));
  const result = {
    name, error, resultSubtype, resultText,
    stderr: stderrBuf.trim().slice(0, 300) || null,
    apiStatuses: all.filter((r) => r.path?.startsWith("/v1/messages") && !r.path.includes("count_tokens")).map((r) => r.status),
    probe: probeReq ? analyzeThinking(probeReq) : "NO PROBE REQUEST CAPTURED",
    firstNewUserParent: newUser?.parentUuid?.slice(0, 8) ?? null,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const report = { versions, model: SONNET };
report.control = await runCase("control", P1.content, "NONCE-P6CTL");
report.control.expect = { note: "plain resume under sonnet; does the CLI forward haiku-signed thinking?" };
report.withThinking = await runCase("with-thinking",
  withInjection([P1.u2User, P1.thinkU2, P1.four, P1.u3User, P1.thinkU3, P1.red], "SYNTH-P6A"), "NONCE-P6A");
report.withThinking.expect = { parent: P1.red.slice(0, 8), note: "preserved haiku thinking under sonnet" };
report.noThinking = await runCase("no-thinking",
  withInjection([P1.u2User, P1.four, P1.u3User, P1.red], "SYNTH-P6B"), "NONCE-P6B");
report.noThinking.expect = { parent: P1.red.slice(0, 8), note: "thinking entries omitted from the playlist" };

fs.writeFileSync(`${EXP_DIR}/captures/p6-report.json`, JSON.stringify(report, null, 2));
console.log("DONE — report at captures/p6-report.json");
