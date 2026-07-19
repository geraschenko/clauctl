import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  resetCapabilitiesCache,
  setCapabilities,
} from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "./tool-execution.ts";

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
