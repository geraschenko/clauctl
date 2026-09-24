// SDK-upgrade regression suite for the loader model in FINDINGS.md — the
// behaviors src/core/tree/loader.ts and src/core/protocol-server/set-context.ts are
// built on. Runs every probe in dependency order (p0a validates the capture
// path; p8 reads p2's and p7's scratch dirs), then check-reports.mjs, which
// hard-asserts over the regenerated reports. Exit status is nonzero if any
// probe process failed or check-reports found a violation.
//
// LIVE: about 75 haiku calls plus p6's sonnet calls, roughly $1 and 20
// minutes; needs a valid ~/.claude access token (>15 min left). Run only
// with approval, as a step of skills/update-claude-agent-sdk (wrapped by
// tests/sdk/compact-boundary-suite.test.ts). Outputs land in captures/
// (untracked); p0b also refreshes its native-compact reference captures.
//
// A failure is a finding, not noise: triage it against FINDINGS.md before
// touching an assertion. A p4 "fixture setup failed" message is the one
// known model flake — rerun `node p4-integration.mjs` then check-reports.

import { spawnSync } from "node:child_process";
import { assertVersions, EXP_DIR } from "./harness.mjs";

const PROBES = [
  "p0a-capture-validation", "p0b-native-compact", "p1-injection", "p1e-ablation",
  "p2-options", "p3-adversarial", "p4-integration", "p5-q3-treeread", "p6-model-switch",
  "p7-lifecycle", "p8-getsessionmessages", "p9-navigation", "p10-empty-boundary",
  "p11a-partial-textsplit", "p11b-partial-fork", "p12-consecutive-users",
  "p13-fork-plain-resume", "p14-duplicate-uuid", "p15a-stacked-invalid-tail",
  "p16-cut-discriminator", "p17-call-without-result", "p18-parallel-ordering",
  "p19-thinking-exclusion", "p20-eye-battery",
];
// A hung CLI (auth prompt, stalled stream) must not stall the whole suite.
const PROBE_TIMEOUT_MS = 10 * 60 * 1000;

const versions = assertVersions();
console.log(`run-suite: SDK ${versions.sdk}, ${PROBES.length} probes`);

const outcomes = [];
for (const probe of PROBES) {
  console.log(`\n===== ${probe} =====`);
  const startedAt = Date.now();
  const result = spawnSync("node", [`${EXP_DIR}/${probe}.mjs`], {
    cwd: EXP_DIR, stdio: "inherit", timeout: PROBE_TIMEOUT_MS,
  });
  const status = result.error ? `error: ${result.error.message}` : result.status === 0 ? "ok" : `exit ${result.status}`;
  outcomes.push({ probe, status, seconds: Math.round((Date.now() - startedAt) / 1000) });
}

console.log("\n===== check-reports =====");
const checks = spawnSync("node", [`${EXP_DIR}/check-reports.mjs`], { cwd: EXP_DIR, stdio: "inherit" });
const checksOk = checks.status === 0;

console.log("\n===== run-suite summary =====");
for (const { probe, status, seconds } of outcomes) {
  console.log(`${status === "ok" ? "  ok  " : " FAIL "} ${probe.padEnd(28)} ${seconds}s${status === "ok" ? "" : `  (${status})`}`);
}
console.log(`${checksOk ? "  ok  " : " FAIL "} check-reports`);
const failed = outcomes.filter((o) => o.status !== "ok").length;
if (failed || !checksOk) {
  console.error(`\nFAIL — ${failed} probe process(es) failed${checksOk ? "" : ", check-reports failed"}`);
  process.exit(1);
}
console.log(`\nPASS — all ${PROBES.length} probes and check-reports on SDK ${versions.sdk}`);
