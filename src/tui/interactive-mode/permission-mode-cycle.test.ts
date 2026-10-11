import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { initialAgentState } from "../../core/agent-state/index.ts";
import { nextPermissionMode } from "./permission-mode-cycle.ts";

function stateIn(
  permissionMode: PermissionMode | undefined,
  observedPermissionModes: PermissionMode[] = [],
): ReturnType<typeof initialAgentState> {
  return { ...initialAgentState(), permissionMode, observedPermissionModes };
}

test("an unset mode counts as default", () => {
  assert.equal(nextPermissionMode(stateIn(undefined)), "plan");
});

test("the base cycle wraps from auto back to default", () => {
  assert.equal(nextPermissionMode(stateIn("acceptEdits")), "auto");
  assert.equal(nextPermissionMode(stateIn("auto")), "default");
});

test("observed modes join after auto, once each", () => {
  const observed: PermissionMode[] = ["plan", "bypassPermissions", "plan"];
  assert.equal(
    nextPermissionMode(stateIn("auto", observed)),
    "bypassPermissions",
  );
  assert.equal(
    nextPermissionMode(stateIn("bypassPermissions", observed)),
    "default",
  );
});
