// Phase 0a: validate the capture path. A plain haiku session runs through the
// recording shim; we assert (1) the turn completes, (2) the capture contains an
// inference request whose messages include our nonce, (3) the session jsonl
// exists where sessionFile() predicts.

import {
  assertVersions, makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, sessionFile, EXP_DIR, HAIKU,
} from "./harness.mjs";
import fs from "node:fs";

const versions = assertVersions();
const configDir = makeConfigDir("p0a-capture-validation");
const capture = `${EXP_DIR}/captures/p0a-baseline.jsonl`;
const shim = await startShim(capture);
const cwd = "/tmp/clauctl-cbi-derisk/p0a-cwd";
fs.mkdirSync(cwd, { recursive: true });

const nonce = `NONCE-${Math.random().toString(36).slice(2, 10)}`;

const s = makeSession({
  model: HAIKU,
  cwd,
  env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
});

const msgs = await s.send(`Reply with exactly the word "pong". (tag: ${nonce})`);
const result = msgs.find((m) => m.type === "result");
const sessionId = s.lastInit()?.session_id;
s.close();
shim.kill();

const inference = readCapturedInference(capture);
const withNonce = inference.filter((r) => JSON.stringify(r.body.messages).includes(nonce));
const jsonl = sessionFile(configDir, cwd, sessionId);

const report = {
  versions,
  turnCompleted: result?.subtype === "success",
  resultText: result?.result?.slice(0, 100),
  capturedRequests: readCapturedInference(capture).length,
  inferenceWithNonce: withNonce.length,
  modelSeen: [...new Set(inference.map((r) => r.body.model))],
  sessionId,
  jsonlExists: fs.existsSync(jsonl),
  jsonlPath: jsonl,
};
console.log(JSON.stringify(report, null, 2));

const ok = report.turnCompleted && report.inferenceWithNonce >= 1 && report.jsonlExists;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
