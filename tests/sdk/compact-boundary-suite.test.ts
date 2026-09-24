// SDK expectation: the session-loading model in
// docs/derisk/compact-boundary-injection/FINDINGS.md, which
// src/core/tree/loader.ts and src/core/protocol-server/set-context.ts are built on.
// run-suite.mjs runs every probe and check-reports.mjs; its exit status is
// the verdict. LIVE: ~75 haiku calls plus a few sonnet calls (~$1); each
// probe is bounded by run-suite's own timeout.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_DIR } from "./harness.ts";

test("compact-boundary-injection suite passes", () => {
  const result = spawnSync(
    "node",
    [join(REPO_DIR, "docs/derisk/compact-boundary-injection/run-suite.mjs")],
    { stdio: "inherit" },
  );
  assert.equal(result.status, 0);
});
