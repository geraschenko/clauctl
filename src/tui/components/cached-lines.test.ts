import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { CachedLinesComponent } from "./cached-lines.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";
import { UserCommandComponent } from "./user-command.ts";
import { UserMessageComponent } from "./user-message.ts";

// The caching contract: repeat renders at the same width return the SAME
// array (reference identity — the per-frame tree walk must not recompute),
// while width changes, declared-input changes, and invalidate() recompute.

/** Repeat renders are identity-stable; a width change recomputes. */
function assertCachedRendering(component: Component, width: number): void {
  const first = component.render(width);
  assert.equal(component.render(width), first);
  assert.notEqual(component.render(width + 1), first);
}

class FakeCached extends CachedLinesComponent {
  key: readonly unknown[] = [];
  computeCount = 0;

  protected cacheKey(): readonly unknown[] {
    return this.key;
  }

  protected computeLines(width: number): string[] {
    this.computeCount += 1;
    return [`compute ${this.computeCount} at ${width}`];
  }
}

test("base: recomputes only on width, key, or invalidate", () => {
  const component = new FakeCached();
  assertCachedRendering(component, 80);
  assert.equal(component.computeCount, 2); // widths 80 and 81

  component.key = ["changed"];
  component.render(81);
  assert.equal(component.computeCount, 3);
  component.render(81);
  assert.equal(component.computeCount, 3);

  component.invalidate();
  component.render(81);
  assert.equal(component.computeCount, 4);
});

test("base: key elements compare with Object.is, not deep equality", () => {
  const component = new FakeCached();
  component.key = [{ value: 1 }];
  component.render(80);
  component.key = [{ value: 1 }];
  component.render(80);
  assert.equal(component.computeCount, 2);
});

test("UserMessageComponent caches", () => {
  assertCachedRendering(new UserMessageComponent("hello there"), 80);
});

test("UserCommandComponent caches; setOutput and setExpanded recompute", () => {
  const component = new UserCommandComponent("/compact");
  assertCachedRendering(component, 80);
  const before = component.render(80);
  component.setOutput("line 1\nline 2\nline 3\nline 4\nline 5");
  const withOutput = component.render(80);
  assert.notEqual(withOutput, before);
  component.setExpanded(true);
  const expanded = component.render(80);
  assert.notEqual(expanded, withOutput);
  assert.ok(expanded.length > withOutput.length);
});

test("ToolExecutionComponent caches; updateResult recomputes", () => {
  const component = new ToolExecutionComponent(
    "Bash",
    { command: "ls" },
    "/repo",
  );
  assertCachedRendering(component, 80);
  const before = component.render(80);
  component.updateResult({
    toolCallId: "tool-1",
    content: "a\nb\nc\nd",
    isError: false,
  });
  const after = component.render(80);
  assert.notEqual(after, before);
  assert.equal(component.render(80), after);
});

test("ToolExecutionComponent with a subagent child appends live lines", () => {
  const component = new ToolExecutionComponent("Agent", { prompt: "go" }, "/");
  component.addSubagentChild(new UserMessageComponent("child"));
  const collapsed = component.render(80);
  assert.ok(collapsed.at(-1)!.includes("ctrl+o to expand"));
  component.setExpanded(true);
  const expanded = component.render(80);
  assert.ok(expanded.join("\n").includes("child"));
});
