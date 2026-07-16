// Phase 0b: native /compact baseline. Build the canonical fixture (tool use +
// nonce-tagged turns), run a genuine /compact, and capture:
//   - pre/post jsonl (saved to captures/)
//   - config-dir file diff (native compaction may touch state outside the jsonl)
//   - every outbound request, including the summarization request (Q5)
//   - the boundary + summary entry shapes on disk
// A post-compact probe turn then shows the compacted context the model receives.

import {
  assertVersions, makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, readJsonl, sessionFile, EXP_DIR, HAIKU,
} from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";

const versions = assertVersions();
const CASE = "p0b-native-compact";
const configDir = makeConfigDir(CASE);
const capture = `${EXP_DIR}/captures/${CASE}-requests.jsonl`;
const shim = await startShim(capture);
const cwd = `/tmp/clauctl-cbi-derisk/${CASE}-cwd`;
fs.rmSync(cwd, { recursive: true, force: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(`${cwd}/fact.txt`, "The magic word is XYLOPHONE-77431.\n");

const listDir = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.statSync(p).size;
    }
  };
  walk(dir);
  return out;
};

const s = makeSession({
  model: HAIKU,
  cwd,
  allowedTools: ["Read"],
  env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
});

// Fixture: U1 (tool turn), U2, U3 — each nonce-tagged.
await s.send("Read the file fact.txt and tell me the magic word. (tag: NONCE-U1)");
await s.send("What is 2+2? Answer with just the number. (tag: NONCE-U2)");
await s.send("Name any primary color, one word. (tag: NONCE-U3)");
const sessionId = s.lastInit()?.session_id;
const jsonl = sessionFile(configDir, cwd, sessionId);

fs.copyFileSync(jsonl, `${EXP_DIR}/captures/${CASE}-pre.jsonl`);
const preDir = listDir(configDir);
const preRequestCount = readCapturedInference(capture).length;

const compactMsgs = await s.send("/compact");
fs.copyFileSync(jsonl, `${EXP_DIR}/captures/${CASE}-post-compact.jsonl`);
const postDir = listDir(configDir);

// Probe: what context does the model see after native compaction?
await s.send("Reply with exactly the word pong. (tag: NONCE-PROBE)");
s.close();
fs.copyFileSync(jsonl, `${EXP_DIR}/captures/${CASE}-post-probe.jsonl`);
shim.kill();

const entries = readJsonl(jsonl);
const boundary = entries.filter((e) => e.subtype === "compact_boundary" || e.isCompactSummary);
const dirDiff = {
  added: Object.keys(postDir).filter((k) => !(k in preDir)),
  removed: Object.keys(preDir).filter((k) => !(k in postDir)),
  changed: Object.keys(postDir).filter((k) => k in preDir && preDir[k] !== postDir[k]),
};
const inference = readCapturedInference(capture);
const compactRequests = inference.slice(preRequestCount).filter((r) =>
  !JSON.stringify(r.body.messages).includes("NONCE-PROBE"));
const probeRequest = inference.find((r) => JSON.stringify(r.body.messages).includes("NONCE-PROBE"));

const report = {
  versions,
  sessionId,
  compactResult: compactMsgs.find((m) => m.type === "result")?.subtype,
  compactSystemMsgs: compactMsgs.filter((m) => m.type === "system").map((m) => m.subtype),
  boundaryAndSummaryEntries: boundary,
  dirDiff,
  requestCounts: { total: inference.length, preCompact: preRequestCount, duringCompact: compactRequests.length },
  compactRequestShapes: compactRequests.map((r) => ({
    model: r.body.model,
    system: (typeof r.body.system === "string" ? r.body.system : JSON.stringify(r.body.system))?.slice(0, 400),
    nMessages: r.body.messages.length,
    lastMessagePreview: JSON.stringify(r.body.messages.at(-1)).slice(0, 400),
  })),
  probeContext: probeRequest && {
    nMessages: probeRequest.body.messages.length,
    hasU1: JSON.stringify(probeRequest.body.messages).includes("NONCE-U1"),
    hasU2: JSON.stringify(probeRequest.body.messages).includes("NONCE-U2"),
    hasU3: JSON.stringify(probeRequest.body.messages).includes("NONCE-U3"),
    hasMagicWord: JSON.stringify(probeRequest.body.messages).includes("XYLOPHONE-77431"),
    firstMessagePreview: JSON.stringify(probeRequest.body.messages[0]).slice(0, 600),
  },
};
fs.writeFileSync(`${EXP_DIR}/captures/${CASE}-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
