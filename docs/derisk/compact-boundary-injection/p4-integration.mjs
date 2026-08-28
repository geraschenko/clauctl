// Phase 4: integration edges (README Q7, Q8, Q9).
//
//   q7: does the CLI's own machinery cope with our synthetic boundary?
//       - resume an injected file and read the probe result's usage (does token
//         accounting reflect the compacted context, i.e. would auto-compact
//         thresholds work off the true size?)
//       - then run a real /compact on that same session: does it succeed, what
//         message set does the summarization request contain, what does the new
//         boundary look like?
//   q8: enableFileCheckpointing + rewindFiles across an injected boundary.
//       Everything in ONE config dir (create → close → append in place → resume),
//       matching the daemon teardown→append→resume protocol, since checkpoint
//       state may live outside the jsonl.
//   q9: lifecycle — measure jsonl flush lag after the SDK `result` message, and
//       check that data appended after quiescence survives q.close().

import {
  assertVersions, makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, readJsonl, sessionFile, EXP_DIR, HAIKU, projectKey,
} from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const versions = assertVersions();
const report = { versions };

function mkPair({ cwd, sessionId, uuids, summaryText, logicalParent }) {
  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const boundary = {
    parentUuid: null, logicalParentUuid: logicalParent, isSidechain: false,
    type: "system", subtype: "compact_boundary", content: "Conversation compacted",
    isMeta: false, timestamp: new Date().toISOString(), uuid: boundaryUuid, level: "info",
    compactMetadata: {
      trigger: "manual", preTokens: 40000, durationMs: 1, postTokens: 1000,
      preservedMessages: { anchorUuid: summaryUuid, uuids, allUuids: uuids },
    },
    userType: "external", entrypoint: "sdk-cli", cwd, sessionId, version: "2.1.195", gitBranch: "HEAD",
  };
  const summary = {
    parentUuid: boundaryUuid, isSidechain: false, type: "user",
    message: { role: "user", content: summaryText },
    isVisibleInTranscriptOnly: true, isCompactSummary: true,
    uuid: summaryUuid, timestamp: new Date().toISOString(),
    userType: "external", entrypoint: "sdk-cli", cwd, sessionId, version: "2.1.195", gitBranch: "HEAD",
  };
  return { boundary, summary, boundaryUuid, summaryUuid };
}

// Poll until pred(entries) or timeout; returns elapsed ms or -1.
async function waitForEntries(file, pred, timeoutMs = 15000) {
  const start = Date.now();
  let delay = 25;
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file) && pred(readJsonl(file))) return Date.now() - start;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 500);
  }
  return -1;
}

// ---------- q7: /compact and usage accounting on an injected file ----------
{
  const P1 = {
    cwd: "/tmp/clauctl-cbi-derisk/p0b-native-compact-cwd",
    sessionId: "c4a1bb69-58cb-4e57-b5f9-7f7e27a9fe36",
  };
  const pre = readJsonl(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`);
  const chain = pre.filter((e) => e.uuid && (e.type === "user" || e.type === "assistant"));
  const leaf = chain.at(-1);          // "Red"
  const leafThinking = chain.at(-2);
  const pair = mkPair({ ...P1, uuids: [leafThinking.uuid, leaf.uuid], logicalParent: leaf.uuid,
    summaryText: "Earlier: arithmetic and color questions; fact.txt was read. (tag: SYNTH-P4Q7)" });
  const configDir = makeConfigDir("p4-q7");
  const projDir = path.join(configDir, "projects", projectKey(P1.cwd));
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, `${P1.sessionId}.jsonl`);
  fs.writeFileSync(file, fs.readFileSync(`${EXP_DIR}/captures/p1-fixture-pre.jsonl`, "utf8")
    + JSON.stringify(pair.boundary) + "\n" + JSON.stringify(pair.summary) + "\n");

  const capture = `${EXP_DIR}/captures/p4-q7-requests.jsonl`;
  const shim = await startShim(capture);
  const s = makeSession({
    model: HAIKU, cwd: P1.cwd, resume: P1.sessionId,
    env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
  });
  const probeMsgs = await s.send("Reply with exactly the word pong. (tag: NONCE-P4Q7)");
  const probeResult = probeMsgs.find((m) => m.type === "result");
  const compactMsgs = await s.send("/compact");
  const compactResult = compactMsgs.find((m) => m.type === "result");
  const postProbeMsgs = await s.send("Reply with exactly the word pong. (tag: NONCE-P4Q7B)");
  s.close();
  shim.kill();

  await waitForEntries(file, (es) => es.some((e) => e.subtype === "compact_boundary" && e.uuid !== pair.boundaryUuid));
  const entries = readJsonl(file);
  const newBoundary = entries.find((e) => e.subtype === "compact_boundary" && e.uuid !== pair.boundaryUuid);
  const inference = readCapturedInference(capture);
  const str = (r) => JSON.stringify(r.body.messages);
  const compactReq = inference.find((r) => str(r).includes("Respond with TEXT ONLY") || str(r).includes("<summary>"));
  const postProbeReq = inference.find((r) => str(r).includes("NONCE-P4Q7B"));
  report.q7 = {
    probeUsage: probeResult?.usage && {
      input: probeResult.usage.input_tokens,
      cacheCreate: probeResult.usage.cache_creation_input_tokens,
      cacheRead: probeResult.usage.cache_read_input_tokens,
    },
    compactSubtype: compactResult?.subtype,
    compactReqScope: compactReq && {
      nMessages: compactReq.body.messages.length,
      hasSynthSummary: str(compactReq).includes("SYNTH-P4Q7"),
      hasRed: str(compactReq).includes('"text":"Red"'),
      hasU1: str(compactReq).includes("NONCE-U1"),
      hasU2: str(compactReq).includes("NONCE-U2)"),
    },
    newBoundaryMetadata: newBoundary?.compactMetadata,
    postProbe: postProbeReq && {
      nMessages: postProbeReq.body.messages.length,
      hasOldSynthSummary: str(postProbeReq).includes("SYNTH-P4Q7"),
      hasFirstProbe: str(postProbeReq).includes("NONCE-P4Q7)"),
    },
  };
  console.log("q7:", JSON.stringify(report.q7, null, 2));
}

// ---------- q8: rewindFiles across an injected boundary ----------
{
  const configDir = makeConfigDir("p4-q8");
  const cwd = "/tmp/clauctl-cbi-derisk/p4-q8-cwd";
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.mkdirSync(cwd, { recursive: true });

  const s = makeSession({
    model: HAIKU, cwd, allowedTools: ["Write"], enableFileCheckpointing: true,
    env: baseEnv(configDir),
  });
  // Absolute path: with a bare "notes.txt" the model sometimes writes
  // /tmp/notes.txt instead of the cwd (2.1.250 rerun flake).
  await s.send(`Create a file ${cwd}/notes.txt containing exactly the text "V1" and nothing else. (tag: CP-U1)`);
  await s.send(`Overwrite ${cwd}/notes.txt so it contains exactly the text "V2" and nothing else. (tag: CP-U2)`);
  const sessionId = s.lastInit()?.session_id;
  const file = sessionFile(configDir, cwd, sessionId);
  await waitForEntries(file, (es) => es.some((e) => e.type === "user" && JSON.stringify(e).includes("CP-U2")));
  const contentAfterT2 = fs.readFileSync(`${cwd}/notes.txt`, "utf8").trim();

  const entries = readJsonl(file);
  const u1 = entries.find((e) => e.type === "user" && typeof e.message?.content === "string" && e.message.content.includes("CP-U1"));
  const u2 = entries.find((e) => e.type === "user" && typeof e.message?.content === "string" && e.message.content.includes("CP-U2"));
  // Live control: rewind is possible before we do anything.
  const liveDryRun = await s.q.rewindFiles(u1.uuid, { dryRun: true }).catch((e) => ({ error: String(e) }));
  s.close();

  // Append boundary in place, preserving only the T2 turn (T1 behind the boundary).
  await waitForEntries(file, (es) => {
    const msgs = es.filter((e) => e.type === "user" || e.type === "assistant");
    return msgs.length > 0 && msgs.at(-1).type === "assistant";
  });
  const chain = readJsonl(file).filter((e) => e.uuid && (e.type === "user" || e.type === "assistant"));
  const t2Entries = chain.slice(chain.findIndex((e) => e.uuid === u2.uuid));
  const pair = mkPair({ cwd, sessionId, uuids: t2Entries.map((e) => e.uuid), logicalParent: chain.at(-1).uuid,
    summaryText: "Earlier: notes.txt was created with V1. (tag: SYNTH-P4Q8)" });
  fs.appendFileSync(file, JSON.stringify(pair.boundary) + "\n" + JSON.stringify(pair.summary) + "\n");

  const s2 = makeSession({
    model: HAIKU, cwd, allowedTools: ["Write"], enableFileCheckpointing: true,
    resume: sessionId, env: baseEnv(configDir),
  });
  // A turn to ensure the resumed session is live before calling rewindFiles.
  await s2.send("Reply with exactly the word pong. (tag: NONCE-P4Q8)");
  const behindBoundaryDryRun = await s2.q.rewindFiles(u1.uuid, { dryRun: true }).catch((e) => ({ error: String(e) }));
  const behindBoundaryReal = await s2.q.rewindFiles(u1.uuid).catch((e) => ({ error: String(e) }));
  const contentAfterRewind = fs.readFileSync(`${cwd}/notes.txt`, "utf8").trim();
  const onChainReal = await s2.q.rewindFiles(u2.uuid).catch((e) => ({ error: String(e) }));
  const contentAfterOnChain = fs.readFileSync(`${cwd}/notes.txt`, "utf8").trim();
  s2.close();

  report.q8 = {
    contentAfterT2, liveDryRun, behindBoundaryDryRun, behindBoundaryReal,
    contentAfterRewind, onChainReal, contentAfterOnChain,
  };
  console.log("q8:", JSON.stringify(report.q8, null, 2));
}

// ---------- q9: flush lag + append-before-close survival ----------
{
  const configDir = makeConfigDir("p4-q9");
  const cwd = "/tmp/clauctl-cbi-derisk/p4-q9-cwd";
  fs.mkdirSync(cwd, { recursive: true });
  const s = makeSession({ model: HAIKU, cwd, env: baseEnv(configDir) });
  await s.send("Reply with exactly the word pong. (tag: NONCE-P4Q9-T1)");
  const sessionId = s.lastInit()?.session_id;
  const file = sessionFile(configDir, cwd, sessionId);

  // Flush lag: time from `result` to the turn's assistant entry appearing on disk.
  const t2 = await s.send("Reply with exactly the word ping. (tag: NONCE-P4Q9-T2)");
  const lagMs = await waitForEntries(file, (es) =>
    es.some((e) => e.type === "assistant" && JSON.stringify(e).includes("ping")));
  // Quiescence: does the file keep growing after the leaf assistant entry appears?
  const sizeAtLeaf = fs.statSync(file).size;
  await new Promise((r) => setTimeout(r, 2000)); // observation window, not synchronization
  const sizeAfterWait = fs.statSync(file).size;

  // Append a sentinel while the query is still open, then close.
  const sentinel = { type: "system", subtype: "turn_duration", uuid: randomUUID(), parentUuid: null, durationMs: 1, timestamp: new Date().toISOString(), sentinel: "P4Q9-SENTINEL" };
  fs.appendFileSync(file, JSON.stringify(sentinel) + "\n");
  s.close();
  await new Promise((r) => setTimeout(r, 2000)); // observation window for post-close writes
  const finalEntries = readJsonl(file);
  const sentinelIdx = finalEntries.findIndex((e) => e.sentinel === "P4Q9-SENTINEL");
  report.q9 = {
    resultToLeafOnDiskMs: lagMs,
    fileGrewAfterLeaf: sizeAfterWait > sizeAtLeaf,
    bytesAfterLeaf: sizeAfterWait - sizeAtLeaf,
    sentinelSurvivedClose: sentinelIdx >= 0,
    entriesAfterSentinel: sentinelIdx >= 0
      ? finalEntries.slice(sentinelIdx + 1).map((e) => e.type + (e.subtype ? `:${e.subtype}` : ""))
      : null,
  };
  console.log("q9:", JSON.stringify(report.q9, null, 2));
}

fs.writeFileSync(`${EXP_DIR}/captures/p4-report.json`, JSON.stringify(report, null, 2));
console.log("DONE — report at captures/p4-report.json");
