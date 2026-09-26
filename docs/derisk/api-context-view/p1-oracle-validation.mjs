// P1 of README.md: does answering the request locally change what the CLI
// sends? Resumes the same scratch session (as installed by
// scripts/capture-api-request.ts) twice with identical options — once through
// the forwarding shim (one real haiku request) and once through the
// answering shim — and diffs the two captured /v1/messages bodies after
// removing the nonce. Usage:
//   node docs/derisk/api-context-view/p1-oracle-validation.mjs <session.jsonl>
// Prints the diff summary; exit 1 when the bodies differ.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HAIKU, makeSession, startShim, readCapturedInference, baseEnv } from "../compact-boundary-injection/harness.mjs";
import { startAnsweringShim } from "../../../tests/sdk/answering-shim.ts";

const EXP_DIR = path.dirname(fileURLToPath(import.meta.url));
const sessionFile = process.argv[2];
if (!sessionFile) {
  console.error("usage: node p1-oracle-validation.mjs <session.jsonl>");
  process.exit(2);
}

// Let the oracle install the scratch copy (mirrored config, prefix, todo files).
execFileSync("node", [`${EXP_DIR}/../../../scripts/capture-api-request.ts`, sessionFile, "--out", "/tmp/p1-oracle.json"], { stdio: ["ignore", "ignore", "inherit"] });
const { cwd, sessionId } = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => typeof e.cwd === "string" && typeof e.sessionId === "string");
const configDir = `/tmp/clauctl-cbi-derisk/api-capture-${sessionId}`;
const scratchFile = `${configDir}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/${sessionId}.jsonl`;
const pristine = fs.readFileSync(scratchFile);

async function turn(port, nonce) {
  fs.writeFileSync(scratchFile, pristine);
  const s = makeSession({
    model: HAIKU,
    cwd,
    resume: sessionId,
    permissionMode: "dontAsk",
    env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }),
  });
  let error = null;
  try {
    await s.send(`Reply with exactly the word pong. (tag: ${nonce})`);
  } catch (e) {
    error = String(e);
  }
  s.close();
  await s.done;
  return error;
}

const forwardCapture = "/tmp/p1-forward-requests.jsonl";
const forwarding = await startShim(forwardCapture);
const forwardError = await turn(forwarding.port, "NONCE-FWD");
forwarding.kill();
const forwardBodies = readCapturedInference(forwardCapture).map((r) => r.body);

const answering = await startAnsweringShim();
const answerError = await turn(answering.port, "NONCE-ANS");
answering.close();
const answerBodies = answering.requests.filter((r) => r.path.startsWith("/v1/messages") && !r.path.includes("count_tokens")).map((r) => r.body);

const normalize = (bodies, nonce) => JSON.stringify(bodies, null, 1).replaceAll(nonce, "NONCE");
const a = normalize(forwardBodies, "NONCE-FWD");
const b = normalize(answerBodies, "NONCE-ANS");
fs.writeFileSync("/tmp/p1-forward.json", a);
fs.writeFileSync("/tmp/p1-answer.json", b);
console.log({ forwardError, answerError, forwardRequests: forwardBodies.length, answerRequests: answerBodies.length, identical: a === b });
if (a !== b) {
  console.log("diff /tmp/p1-forward.json /tmp/p1-answer.json");
  process.exit(1);
}
