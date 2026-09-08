/**
 * permissionDialog against the derisk probe payloads
 * (docs/derisk/permission-prompt/out/<scenario>.json, `asks[0]`); labels
 * are the claude captures beside them.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { permissionRequestOf } from "../core/protocol-server/index.ts";
import type { PermissionRequest } from "../core/protocol/index.ts";
import { PLAIN_STYLE } from "../format/style.ts";
import {
  PLAIN_DENY_MESSAGE,
  permissionDialog,
  suggestionsLabel,
} from "./permission-dialog.ts";
import { DASHED_RULE } from "./permission-views.ts";

interface Probe {
  cwd: string;
  asks: Array<{
    toolName: string;
    input: Record<string, unknown>;
    options: Omit<Parameters<CanUseTool>[2], "signal">;
  }>;
}

function probeRequest(scenario: string): {
  request: PermissionRequest;
  cwd: string;
} {
  const probe = JSON.parse(
    readFileSync(`docs/derisk/permission-prompt/out/${scenario}.json`, "utf8"),
  ) as Probe;
  const ask = probe.asks[0]!;
  return {
    cwd: probe.cwd,
    request: permissionRequestOf(ask.toolName, ask.input, {
      ...ask.options,
      signal: new AbortController().signal,
    }),
  };
}

function dialogOf(scenario: string) {
  const { request, cwd } = probeRequest(scenario);
  return permissionDialog(request, { cwd, style: PLAIN_STYLE });
}

test("bash: command + description body; addDirectories wins the row-2 label", () => {
  const dialog = dialogOf("bash-safety-default");
  assert.equal(dialog.title, "Bash: Remove temporary directory");
  assert.equal(dialog.body[0], "rm -rf /tmp/clauctl-permprobe-victim");
  assert.equal(dialog.question, "Do you want to proceed?");
  assert.deepEqual(
    dialog.rows.map((row) => row.label),
    [
      "Yes",
      "Yes, and always allow access to /tmp/clauctl-permprobe-victim from this project",
      "No",
    ],
  );
  assert.deepEqual(dialog.rows[0]!.action, {
    kind: "decide",
    decision: { behavior: "allow" },
  });
  assert.deepEqual(dialog.rows[2]!.action, {
    kind: "decide",
    decision: { behavior: "deny", message: PLAIN_DENY_MESSAGE },
  });
  const row2 = dialog.rows[1]!.action;
  assert.equal(row2.kind, "decide");
  assert.equal(row2.decision.behavior, "allow");
  assert.equal(
    row2.decision.behavior === "allow" &&
      row2.decision.updatedPermissions?.length,
    3,
  );
  assert.equal(dialog.tabAmends, true);
});

test("edit: replacement body between rules; setMode-only → accept-edits label", () => {
  const dialog = dialogOf("edit");
  assert.equal(dialog.title, "Edit file");
  assert.equal(dialog.question, "Do you want to make this edit to a.txt?");
  assert.equal(dialog.body[0], "a.txt");
  assert.equal(dialog.body[1], DASHED_RULE);
  assert.match(String(dialog.body[2]), /^-/);
  assert.match(String(dialog.body.at(-2)), /^\+/);
  assert.equal(dialog.body.at(-1), DASHED_RULE);
  assert.equal(
    dialog.rows[1]!.label,
    "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)",
  );
});

test("write: numbered content; read-outside: session path rule label", () => {
  const write = dialogOf("write");
  assert.equal(write.title, "Create file");
  assert.equal(write.question, "Do you want to create b.txt?");
  assert.match(String(write.body[2]), /^1 /);
  const read = dialogOf("read-outside");
  assert.equal(read.title, "Read file");
  assert.deepEqual(read.body, [
    "Read(/tmp/clauctl-permprobe-outside/secret.txt)",
  ]);
  assert.equal(
    read.rows[1]!.label,
    "Yes, allow reading from /tmp/clauctl-permprobe-outside during this session",
  );
});

test("webfetch: host label; mcp: generic dialog with the rule label", () => {
  const fetch = dialogOf("webfetch");
  assert.equal(fetch.title, "Fetch: https://example.com");
  assert.equal(fetch.body[1], "Claude wants to fetch content from example.com");
  assert.equal(
    fetch.question,
    "Do you want to allow Claude to fetch this content?",
  );
  assert.equal(
    fetch.rows[1]!.label,
    "Yes, and don't ask again for example.com",
  );
  const { request, cwd } = probeRequest("mcp");
  const mcp = permissionDialog(request, { cwd, style: PLAIN_STYLE });
  assert.equal(mcp.title, "Greet");
  assert.deepEqual(mcp.body, ["mcp__probe__greet", 'name: "Anton"']);
  assert.equal(
    mcp.rows[1]!.label,
    `Yes, and don't ask again for mcp__probe__greet in ${cwd}`,
  );
});

test("plan: ExitPlanMode's three rows, Tab does not amend", () => {
  const dialog = dialogOf("plan");
  assert.equal(dialog.title, "Ready to code?");
  assert.equal(dialog.body[0], "Here is Claude's plan:");
  assert.equal(typeof dialog.body[2], "object", "the plan is a markdown block");
  assert.equal(
    dialog.planFilePath,
    probeRequest("plan").request.input.planFilePath,
  );
  assert.deepEqual(
    dialog.rows.map((row) => [row.label, row.action.kind]),
    [
      ["Yes, auto-accept edits", "decide"],
      ["Yes, manually approve edits", "decide"],
      ["Tell Claude what to change", "amend"],
    ],
  );
  assert.equal(dialog.tabAmends, false);
});

test("no suggestions → two rows; the SDK title replaces the question", () => {
  const dialog = permissionDialog(
    {
      toolUseId: "t",
      toolName: "Bash",
      input: { command: "ls" },
      suggestions: [],
      title: "Run ls?",
    },
    { cwd: undefined, style: PLAIN_STYLE },
  );
  assert.deepEqual(
    dialog.rows.map((row) => row.label),
    ["Yes", "No"],
  );
  assert.equal(dialog.question, "Run ls?");
  assert.equal(
    suggestionsLabel([], "Bash", undefined),
    "Yes, and don't ask again",
  );
});

test("suppressAlwaysAllowRule drops row 2 despite suggestions; defaultToNo rides through", () => {
  const { request, cwd } = probeRequest("bash-safety-default");
  const dialog = permissionDialog(
    { ...request, suppressAlwaysAllowRule: true, defaultToNo: true },
    { cwd, style: PLAIN_STYLE },
  );
  assert.ok(request.suggestions.length > 0);
  assert.deepEqual(
    dialog.rows.map((row) => row.label),
    ["Yes", "No"],
  );
  assert.equal(dialog.defaultToNo, true);
});

test("plan: an edited plan is shown and sent as updatedInput", () => {
  const { request, cwd } = probeRequest("plan");
  const dialog = permissionDialog(
    request,
    { cwd, style: PLAIN_STYLE },
    "# edited",
  );
  assert.deepEqual(dialog.body[2], { markdown: "# edited" });
  const approve = dialog.rows[1]!.action;
  assert.equal(approve.kind, "decide");
  assert.deepEqual(
    approve.kind === "decide" && approve.decision.behavior === "allow"
      ? approve.decision.updatedInput
      : undefined,
    { ...request.input, plan: "# edited" },
  );
});
