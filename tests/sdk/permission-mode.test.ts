// SDK expectation: `query()` with `permissionMode` unset spawns the CLI with
// `--permission-mode default`, overriding `permissions.defaultMode` from
// every settings file. Inside the SDK the flag is
// `permissionMode ?? (internal.resolvePermissionModeInCli ? undefined : "default")`
// and the internal flag is never set for public callers. daemon.ts's
// buildOptions therefore forwards the settings-cascade mode explicitly.
//
// Both cases use a scratch config whose defaultMode differs from the CLI
// default; a config that leaves defaultMode unset cannot distinguish a
// forced "default" from a resolved one.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const SETTINGS = { permissions: { defaultMode: "acceptEdits" } };

async function initPermissionMode(
  caseName: string,
  permissionMode: Options["permissionMode"],
): Promise<string> {
  assertVersions();
  const configDir = makeConfigDir(caseName, SETTINGS);
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const q = query({
    prompt: "reply with the single word ok",
    options: {
      env: baseEnv(configDir),
      cwd,
      model: HAIKU,
      maxTurns: 1,
      ...(permissionMode !== undefined && { permissionMode }),
    },
  });
  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        return msg.permissionMode;
      }
    }
  } finally {
    q.close();
    rmSync(cwd, { recursive: true, force: true });
  }
  throw new Error("query ended without an init message");
}

test("workaround required: unset permissionMode forces default over settings", async () => {
  assert.equal(
    await initPermissionMode("permission-mode-unset", undefined),
    "default",
  );
});

test("workaround works: explicit permissionMode reaches the CLI", async () => {
  assert.equal(
    await initPermissionMode("permission-mode-explicit", "acceptEdits"),
    "acceptEdits",
  );
});
