import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  resetCapabilitiesCache,
  setCapabilities,
} from "@earendil-works/pi-tui";
import { stripAnsi } from "../../core/generated/text.ts";
import { ToolExecutionComponent, wrapHeaderArg } from "./tool-execution.ts";

function withHyperlinks<T>(hyperlinks: boolean, body: () => T): T {
  setCapabilities({ images: null, trueColor: false, hyperlinks });
  try {
    return body();
  } finally {
    resetCapabilitiesCache();
  }
}

function headerLine(component: ToolExecutionComponent, width: number): string {
  const lines = component.render(width);
  // render() emits a leading blank line before the header.
  return lines[1]!;
}

/** Rendered lines after the leading blank line, ANSI-stripped. */
function plainLines(
  component: ToolExecutionComponent,
  width: number,
): string[] {
  return component
    .render(width)
    .slice(1)
    .map((line) => stripAnsi(line).trimEnd());
}

test("Bash header: description on the header line, command beneath it", () => {
  const component = new ToolExecutionComponent(
    "Bash",
    { description: "List files", command: "ls\n-la /tmp" },
    undefined,
  );
  assert.deepEqual(plainLines(component, 80), [
    "▸ Bash(List files)",
    "      ls -la /tmp",
  ]);
  // The command line truncates to the width rather than wrapping.
  assert.deepEqual(plainLines(component, 12), [
    "▸ Bash(List",
    "      files)",
    "      ls -l…",
  ]);
});

test("Bash header without a description is the command, wrapped as before", () => {
  const component = new ToolExecutionComponent(
    "Bash",
    { command: "ls -la" },
    undefined,
  );
  assert.deepEqual(plainLines(component, 80), ["▸ Bash(ls -la)"]);
  assert.deepEqual(
    plainLines(new ToolExecutionComponent("Bash", "nope", undefined), 80),
    ["▸ Bash"],
  );
});

test("collapsed result: one source line shown, more counted, errors with ✗", () => {
  const component = new ToolExecutionComponent("Grep", {}, undefined);
  component.updateResult({
    toolCallId: "t",
    content: "src/a.ts\n",
    isError: false,
    toolUseResult: undefined,
  });
  assert.deepEqual(plainLines(component, 80), ["▸ Grep", "  ⤷  src/a.ts"]);
  component.updateResult({
    toolCallId: "t",
    content: "a\nb\nc",
    isError: false,
    toolUseResult: undefined,
  });
  assert.deepEqual(plainLines(component, 80), [
    "▸ Grep",
    "  ⤷  3 lines (ctrl+o to expand)",
  ]);
  component.updateResult({
    toolCallId: "t",
    content: "grep: src: No such file",
    isError: true,
    toolUseResult: undefined,
  });
  assert.deepEqual(plainLines(component, 80), [
    "▸ Grep",
    "  ✗  grep: src: No such file",
  ]);
  // Expanded: the args JSON and the full result under ⤷ regardless.
  component.setExpanded(true);
  assert.equal(plainLines(component, 80)[1], "  ⤷  {}");
});

test("header path is an OSC 8 file link when hyperlinks are supported", () => {
  const component = new ToolExecutionComponent(
    "Read",
    { file_path: "/repo/src/a.ts" },
    "/repo",
  );
  const line = withHyperlinks(true, () => headerLine(component, 80));
  const url = pathToFileURL("/repo/src/a.ts").href;
  assert.ok(
    line.includes(`\u001b]8;;${url}\u001b\\src/a.ts\u001b]8;;\u001b\\`),
  );
});

test("header path stays plain without hyperlink capability", () => {
  const component = new ToolExecutionComponent(
    "Read",
    { file_path: "/repo/src/a.ts" },
    "/repo",
  );
  const line = withHyperlinks(false, () => headerLine(component, 80));
  assert.ok(line.includes("src/a.ts)"));
  assert.ok(!line.includes("\u001b]8;"));
});

test("header path stays plain when the arg wraps or truncates", () => {
  const longPath = `/repo/${"deeply/".repeat(20)}file.ts`;
  const component = new ToolExecutionComponent(
    "Read",
    { file_path: longPath },
    "/repo",
  );
  const lines = withHyperlinks(true, () => component.render(40));
  assert.ok(!lines.join("\n").includes("\u001b]8;"));
});

test("header path stays plain for control-byte or relative paths", () => {
  const escPath = "/repo/evil\u001b]8;;x\u001b\\.ts";
  const escComponent = new ToolExecutionComponent(
    "Read",
    { file_path: escPath },
    undefined,
  );
  const escLines = withHyperlinks(true, () => escComponent.render(200));
  assert.ok(!escLines.join("\n").includes("\u001b]8;;file:"));

  const c1Component = new ToolExecutionComponent(
    "Read",
    { file_path: "/repo/evil\u009b31mred.ts" },
    undefined,
  );
  const c1Lines = withHyperlinks(true, () => c1Component.render(200));
  assert.ok(!c1Lines.join("\n").includes("\u001b]8;;file:"));

  const relComponent = new ToolExecutionComponent(
    "Read",
    { file_path: "notes.txt" },
    "/repo",
  );
  const relLines = withHyperlinks(true, () => relComponent.render(80));
  assert.ok(!relLines.join("\n").includes("\u001b]8;"));
});

test("wrapHeaderArg: word wrap, embedded newlines, truncation flag", () => {
  assert.deepEqual(wrapHeaderArg("ls -la)", 80, 74, 2), {
    lines: ["ls -la)"],
    truncated: false,
  });
  // Wraps at whitespace onto the continuation capacity.
  assert.deepEqual(wrapHeaderArg("echo one two)", 8, 74, 2), {
    lines: ["echo one", "two)"],
    truncated: false,
  });
  // Embedded newlines break lines; content beyond maxLines reports truncated.
  assert.deepEqual(wrapHeaderArg("a\nb\nc)", 80, 74, 2), {
    lines: ["a", "b"],
    truncated: true,
  });
  // A word longer than the line hard-breaks.
  assert.deepEqual(wrapHeaderArg("abcdefgh)", 4, 4, 3), {
    lines: ["abcd", "efgh", ")"],
    truncated: false,
  });
});
