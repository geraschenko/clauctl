// P7: prototype the daemon's mutation lifecycle (reviewer gap #1), repeated.
//
// The daemon owns the claude process and serializes all commands, so the one
// path that needs to be safe is:
//   turn result → leaf entry on disk → graceful teardown → child exit
//   → append boundary+summary → respawn (resume) → next turn
//
// Leaf-on-disk detection is event-driven: fs.watch on the project dir, with a
// predicate re-checked on every change event (no polling, no sleeps). Graceful
// teardown = end the input stream and await generator completion (the SDK's
// cleanup awaits the child's exit); we then hard-assert no claude child remains.
//
// Each cycle injects a boundary preserving ONLY the previous turn's assistant
// leaf, with a summary declaring a new codeword. The next cycle's probe asks
// for the codeword, so the captured request proves the injection took effect:
// exactly [summary_i, leaf_{i-1}, probe] — no older summaries, parent = leaf.
// Boundaries stack across cycles (P3 m5: last wins), exercising repeated
// mutation on one growing file. All checks are HARD assertions — the script
// throws on the first violation.

import {
  assertVersions, makeConfigDir, baseEnv, makeSession, startShim,
  readCapturedInference, EXP_DIR, projectKey,
} from "./harness.mjs";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const versions = assertVersions();
const REPS = 12;
const cwd = "/tmp/clauctl-cbi-derisk/p7-cwd";
const configDir = makeConfigDir("p7-lifecycle");
const projDir = path.join(configDir, "projects", projectKey(cwd));
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// Tolerant of a partially-written last line (we may read mid-append).
const readJsonlSafe = (file) =>
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });

// Resolve when an entry matching pred is in the file; fs.watch + predicate.
function waitForEntry(dir, file, pred, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!fs.existsSync(file)) return;
      const hit = readJsonlSafe(file).find(pred);
      if (hit) { cleanup(); resolve(hit); }
    };
    const watcher = fs.watch(dir, check);
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for entry in ${file}`)); }, timeoutMs);
    const cleanup = () => { watcher.close(); clearTimeout(timer); };
    check();
  });
}

// claude CLI children of THIS process (the shim is `node shim.mjs` and the ps
// helper's own sh -c line contains neither the binary path pattern).
const claudeChildren = () => {
  try {
    return execSync(`ps -o pid=,args= --ppid ${process.pid}`).toString().trim().split("\n")
      .filter((l) => l.includes("claude-agent-sdk-") && l.includes("/claude "));
  } catch { return []; }
};

const stamp = (extra) => ({
  isSidechain: false, timestamp: new Date().toISOString(), userType: "external",
  entrypoint: "sdk-cli", cwd, version: "2.1.195", gitBranch: "HEAD", ...extra,
});
function appendInjection(file, sessionId, leafUuid, cycle) {
  const boundaryUuid = randomUUID();
  const summaryUuid = randomUUID();
  const boundary = stamp({
    parentUuid: null, logicalParentUuid: leafUuid, type: "system", subtype: "compact_boundary",
    content: "Conversation compacted", isMeta: false, uuid: boundaryUuid, level: "info", sessionId,
    compactMetadata: {
      trigger: "manual", preTokens: 40000, durationMs: 1, postTokens: 1000,
      preservedMessages: { anchorUuid: summaryUuid, uuids: [leafUuid], allUuids: [leafUuid] },
    },
  });
  const summary = stamp({
    parentUuid: boundaryUuid, type: "user", sessionId,
    message: { role: "user", content: `Context summary: the current codeword is ALPHA-${cycle}. (tag: SYNTH-P7-${cycle})` },
    isVisibleInTranscriptOnly: true, isCompactSummary: true, uuid: summaryUuid,
  });
  fs.appendFileSync(file, JSON.stringify(boundary) + "\n" + JSON.stringify(summary) + "\n");
}

let sessionId = null;
let prevLeafUuid = null;
const cycles = [];

for (let i = 0; i < REPS; i++) {
  const capture = `${EXP_DIR}/captures/p7-cycle${i}-requests.jsonl`;
  const shim = await startShim(capture);
  const s = makeSession({
    model: "claude-haiku-4-5-20251001", cwd,
    ...(sessionId ? { resume: sessionId } : {}),
    env: baseEnv(configDir, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` }),
  });

  const nonce = `NONCE-P7-${i}`;
  const prompt = i === 0
    ? `Reply with exactly the word pong. (tag: ${nonce})`
    : `What is the current codeword? Reply with only the codeword. (tag: ${nonce})`;
  const msgs = await s.send(prompt);
  const resultAt = Date.now();
  const result = msgs.find((m) => m.type === "result");
  assert(result?.subtype === "success", `cycle ${i}: result subtype ${result?.subtype}`);
  assert(claudeChildren().length === 1, `cycle ${i}: expected exactly 1 claude child while running`);

  sessionId ??= s.lastInit()?.session_id;
  const file = path.join(projDir, `${sessionId}.jsonl`);
  const assistantUuids = msgs.filter((m) => m.type === "assistant").map((m) => m.uuid);
  const leafUuid = assistantUuids[assistantUuids.length - 1];
  assert(leafUuid, `cycle ${i}: no assistant uuid in stream`);

  await waitForEntry(projDir, file, (e) => e.uuid === leafUuid);
  const leafOnDiskMs = Date.now() - resultAt;

  s.endInput();
  await s.done;
  const exitMs = Date.now() - resultAt - leafOnDiskMs;
  assert(claudeChildren().length === 0, `cycle ${i}: claude child still alive after graceful teardown`);
  shim.kill();

  // Verify this cycle's probe saw exactly the previous injection's context.
  if (i > 0) {
    const inference = readCapturedInference(capture);
    const probeReq = inference.find((r) => JSON.stringify(r.body.messages).includes(nonce));
    assert(probeReq, `cycle ${i}: no probe request captured`);
    const reqStr = JSON.stringify(probeReq.body.messages);
    assert(reqStr.includes(`SYNTH-P7-${i}`), `cycle ${i}: current summary missing from request`);
    assert(!reqStr.includes(`SYNTH-P7-${i - 1}`), `cycle ${i}: stale summary leaked into request`);
    assert(!reqStr.includes(`NONCE-P7-${i - 1}`), `cycle ${i}: stale probe leaked into request`);
    assert(probeReq.body.messages.length === 3, `cycle ${i}: expected 3 messages, got ${probeReq.body.messages.length}`);
    const newUser = readJsonlSafe(file)
      .find((e) => e.type === "user" && JSON.stringify(e.message?.content ?? "").includes(nonce));
    assert(newUser?.parentUuid === prevLeafUuid, `cycle ${i}: probe parent ${newUser?.parentUuid} != preserved leaf ${prevLeafUuid}`);
  }

  // Mutate: only after the child is gone.
  appendInjection(file, sessionId, leafUuid, i + 1);
  prevLeafUuid = leafUuid;
  cycles.push({ cycle: i, leafOnDiskMs, teardownMs: exitMs });
  console.log(JSON.stringify(cycles[cycles.length - 1]));
}

const sorted = (k) => cycles.map((c) => c[k]).sort((a, b) => a - b);
const report = {
  versions, reps: REPS, sessionId, allAssertionsPassed: true,
  leafOnDiskMs: { min: sorted("leafOnDiskMs")[0], median: sorted("leafOnDiskMs")[Math.floor(REPS / 2)], max: sorted("leafOnDiskMs")[REPS - 1] },
  teardownMs: { min: sorted("teardownMs")[0], median: sorted("teardownMs")[Math.floor(REPS / 2)], max: sorted("teardownMs")[REPS - 1] },
  cycles,
};
fs.writeFileSync(`${EXP_DIR}/captures/p7-report.json`, JSON.stringify(report, null, 2));
console.log(`PASS — ${REPS} cycles, report at captures/p7-report.json`);
