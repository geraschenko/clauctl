import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../core/generated/text.ts";
import type { PermissionDialog } from "../permission-dialog.ts";
import { PermissionPromptComponent } from "./permission-prompt.ts";

const NO: PermissionResult = { behavior: "deny", message: "no" };

const dialog = (
  overrides: Partial<PermissionDialog> = {},
): PermissionDialog => ({
  title: "Bash command",
  body: ["cd /tmp\nmake\nmake install"],
  question: "Do you want to proceed?",
  rows: [
    {
      label: "Yes",
      action: { kind: "decide", decision: { behavior: "allow" } },
    },
  ],
  cancelDecision: NO,
  defaultToNo: false,
  tabAmends: false,
  ...overrides,
});

test("defaultToNo opens on the last row and ignores digits", () => {
  const decisions: PermissionResult[] = [];
  const rows: PermissionDialog["rows"] = [
    {
      label: "Yes",
      action: { kind: "decide", decision: { behavior: "allow" } },
    },
    { label: "No", action: { kind: "decide", decision: NO } },
  ];
  const prompt = new PermissionPromptComponent(
    dialog({ rows, defaultToNo: true }),
    1,
    (d) => decisions.push(d),
  );
  prompt.handleInput("1");
  assert.deepEqual(decisions, []);
  const selectedLine = prompt
    .render(40)
    .map(stripAnsi)
    .find((l) => l.startsWith(" ❯"));
  assert.equal(selectedLine, " ❯ 2. No");
});

test("a body line's own newlines stay separate lines, each indented", () => {
  const lines = new PermissionPromptComponent(dialog(), 1, () => {})
    .render(40)
    .map(stripAnsi);
  assert.deepEqual(lines.slice(3, 6), [
    "   cd /tmp",
    "   make",
    "   make install",
  ]);
});

test("a long body line wraps within the width", () => {
  const long = "x ".repeat(40).trim();
  const lines = new PermissionPromptComponent(
    dialog({ body: [long] }),
    1,
    () => {},
  ).render(30);
  assert.ok(lines.length > 6);
  assert.ok(lines.every((line) => visibleWidth(line) <= 30));
});

test("Esc sends the dialog's cancelDecision even without a deny row", () => {
  const decisions: PermissionResult[] = [];
  const prompt = new PermissionPromptComponent(dialog(), 1, (d) =>
    decisions.push(d),
  );
  prompt.handleInput("\x1b");
  assert.deepEqual(decisions, [NO]);
});

test("the title's (+N more) follows pendingCount", () => {
  const prompt = new PermissionPromptComponent(dialog(), 1, () => {});
  assert.ok(!stripAnsi(prompt.render(40)[1] ?? "").includes("more"));
  prompt.pendingCount = 3;
  assert.ok(stripAnsi(prompt.render(40)[1] ?? "").endsWith("(+2 more)"));
});
