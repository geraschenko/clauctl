import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import type { RenderToolResult } from "../../render-types.ts";
import { stripAnsi } from "../../../core/generated/text.ts";
import { ANSI_STYLE, PLAIN_STYLE } from "../../style.ts";
import { abbreviatePath } from "./args.ts";
import {
  collapsedOutputSummary,
  defaultToolView,
} from "./default-tool-view.ts";
import { toolViewFor } from "./tool-view-for.ts";

const PLAIN = { cwd: undefined, style: PLAIN_STYLE };
const REPO = { cwd: "/repo", style: PLAIN_STYLE };

// Tests exercise views through toolViewFor — the erased ToolView<unknown>
// shape callers use — so fixture args need no generated-type ceremony.
const agentView = toolViewFor("Agent");
const bashView = toolViewFor("Bash");
const editView = toolViewFor("Edit");
const readView = toolViewFor("Read");
const webSearchView = toolViewFor("WebSearch");
const writeView = toolViewFor("Write");

function result(
  toolUseResult: unknown,
  isError = false,
  content = "",
): RenderToolResult {
  return { toolCallId: "t", content, isError, toolUseResult };
}

test("abbreviatePath: cwd-relative, ~-abbreviated, absolute", () => {
  assert.equal(abbreviatePath("/repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(
    abbreviatePath(`${homedir()}/notes.txt`, "/repo"),
    "~/notes.txt",
  );
  assert.equal(abbreviatePath("/etc/hosts", "/repo"), "/etc/hosts");
  assert.equal(abbreviatePath("/repo/src/a.ts", undefined), "/repo/src/a.ts");
  // Relative paths display normalized (write-preview capture).
  assert.equal(abbreviatePath("./lines.txt", "/repo"), "lines.txt");
  assert.equal(abbreviatePath("./lines.txt", undefined), "lines.txt");
});

test("toolViewFor: known tools resolve, unknown/legacy tools take the default", () => {
  assert.notEqual(toolViewFor("Edit"), defaultToolView);
  assert.notEqual(toolViewFor("Agent"), defaultToolView);
  assert.equal(toolViewFor("Grep"), defaultToolView);
  assert.equal(toolViewFor("mcp__foo__bar"), defaultToolView);
  assert.equal(toolViewFor("toString"), defaultToolView);
});

test("collapsedOutputSummary: one source line shown, more counted", () => {
  assert.equal(collapsedOutputSummary(""), "");
  assert.equal(collapsedOutputSummary("only line"), "only line");
  assert.equal(collapsedOutputSummary("a\nb"), "2 lines (ctrl+o to expand)");
  assert.equal(
    defaultToolView.resultSummary({}, result(undefined, false, " x\n"), PLAIN),
    "x",
  );
  assert.deepEqual(defaultToolView.header({}, PLAIN), {});
});

test("editView summary: singular/plural, zero parts omitted", () => {
  const summary = (lines: string[]): string | undefined =>
    editView.resultSummary(
      {},
      result({ structuredPatch: [{ oldStart: 1, newStart: 1, lines }] }),
      PLAIN,
    );
  assert.equal(summary(["+a"]), "Added 1 line");
  assert.equal(summary(["+a", "+b", "-c"]), "Added 2 lines, removed 1 line");
  assert.equal(summary(["-a"]), "Removed 1 line");
  assert.equal(summary([" context only"]), "");
  // Unexpected shapes fall back to the generic summary, not a crash.
  assert.equal(editView.resultSummary({}, result(null), PLAIN), "");
  assert.equal(
    editView.resultSummary(
      {},
      result({ structuredPatch: "nope" }, false, "raw"),
      PLAIN,
    ),
    "raw",
  );
});

// Carved from the edit-scenario session (6bfdf5f9…): the mid-file div edit,
// whose rendering is pinned by scripts/tui-parity/out/edit.claude.txt.
const divHunk = {
  oldStart: 12,
  oldLines: 6,
  newStart: 12,
  newLines: 8,
  lines: [
    " ",
    " def div(a, b):",
    '     """Return the quotient of a and b."""',
    "+    if b == 0:",
    '+        raise ValueError("Division by zero is not allowed")',
    "     return a / b",
    " ",
    " def main():",
  ],
};

test("editView resultBody: claude layout with file-anchored numbers", () => {
  const body = editView.resultBody?.(
    {},
    result({ structuredPatch: [divHunk] }),
    PLAIN,
  );
  assert.equal(
    body!,
    [
      " 12",
      " 13  def div(a, b):",
      ' 14      """Return the quotient of a and b."""',
      " 15 +    if b == 0:",
      ' 16 +        raise ValueError("Division by zero is not allowed")',
      " 17      return a / b",
      " 18",
      " 19  def main():",
    ].join("\n"),
  );
});

test("editView resultBody: - runs group before + runs, old/new numbering", () => {
  const body = editView.resultBody?.(
    {},
    result({
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [" ctx", "-old a", "+new a", "-old b", "+new b"],
        },
      ],
    }),
    PLAIN,
  );
  assert.equal(
    body!,
    [" 1  ctx", " 2 -old a", " 3 -old b", " 2 +new a", " 3 +new b"].join("\n"),
  );
});

test("editView resultBody: hunks separated by ..., width from widest number", () => {
  const body = editView.resultBody?.(
    {},
    result({
      structuredPatch: [
        {
          oldStart: 8,
          oldLines: 1,
          newStart: 8,
          newLines: 1,
          lines: ["-x", "+y"],
        },
        {
          oldStart: 120,
          oldLines: 1,
          newStart: 120,
          newLines: 1,
          lines: [" z"],
        },
      ],
    }),
    PLAIN,
  );
  assert.equal(body!, ["   8 -x", "   8 +y", "...", " 120  z"].join("\n"));
});

test("editView resultBody: no diff on error, malformed, or change-free patch", () => {
  assert.equal(editView.resultBody?.({}, result(undefined), PLAIN), undefined);
  assert.equal(
    editView.resultBody?.(
      {},
      result({ structuredPatch: [divHunk] }, true),
      PLAIN,
    ),
    undefined,
  );
  assert.equal(
    editView.resultBody?.(
      {},
      result({ structuredPatch: [{ ...divHunk, oldStart: "12" }] }),
      PLAIN,
    ),
    undefined,
  );
  assert.equal(
    editView.resultBody?.(
      {},
      result({ structuredPatch: [{ ...divHunk, lines: [" ctx only"] }] }),
      PLAIN,
    ),
    undefined,
  );
});

test("readView: Read N lines from structured numLines; fold labels", () => {
  assert.equal(
    readView.resultSummary(
      {},
      result({ type: "text", file: { numLines: 42 } }),
      PLAIN,
    ),
    "Read 42 lines",
  );
  assert.equal(
    readView.resultSummary(
      {},
      result({ type: "text", file: { numLines: 1 } }),
      PLAIN,
    ),
    "Read 1 line",
  );
  assert.equal(readView.resultSummary({}, result({}), PLAIN), "");
  assert.equal(readView.foldLabel!(2, PLAIN_STYLE), "read 2 files");
  assert.equal(readView.foldLabel!(1, PLAIN_STYLE), "read 1 file");
});

test("bashView: empty-output sentinel displays as (No output)", () => {
  assert.equal(
    bashView.resultSummary(
      {},
      result(undefined, false, "(Bash completed with no output)"),
      PLAIN,
    ),
    "(No output)",
  );
  // Real output and errors keep the generic collapse rule.
  assert.equal(
    bashView.resultSummary({}, result(undefined, false, "hello"), PLAIN),
    "hello",
  );
  assert.equal(
    bashView.resultSummary(
      {},
      result(undefined, true, "(Bash completed with no output)"),
      PLAIN,
    ),
    "(Bash completed with no output)",
  );
});

test("bashView header: description and command as separate parts", () => {
  assert.deepEqual(
    bashView.header({ description: "List files", command: "ls -la" }, PLAIN),
    { description: "List files", arg: "ls -la" },
  );
  assert.deepEqual(bashView.header({ command: "ls" }, PLAIN), {
    description: undefined,
    arg: "ls",
  });
  assert.deepEqual(bashView.header("nope", PLAIN), {
    description: undefined,
    arg: undefined,
  });
});

test("readView header: abbreviated path with the offset/limit range", () => {
  const header = (args: unknown) => readView.header(args, REPO).arg;
  assert.equal(header({ file_path: "/repo/a.ts" }), "a.ts");
  assert.equal(
    header({ file_path: "/repo/a.ts", offset: 10, limit: 5 }),
    "a.ts:10-14",
  );
  assert.equal(header({ file_path: "/repo/a.ts", offset: 10 }), "a.ts:10-");
  assert.equal(header({ file_path: "/repo/a.ts", limit: 5 }), "a.ts:1-5");
  assert.equal(header({ file_path: "/repo/a.ts", pages: "1-3" }), "a.ts");
  assert.deepEqual(readView.header({}, REPO), {});
});

// Carved from the readonly-fold session (ae3aa47c…): the fruit.txt write,
// pinned by scripts/tui-parity/out/readonly-fold.claude.txt.
const fruitWrite = {
  type: "create",
  filePath: "/home/anton/fruit.txt",
  content: "apple\nbanana",
};

test("writeView: Wrote N lines summary with cwd-relative path", () => {
  assert.equal(
    writeView.resultSummary({}, result(fruitWrite), {
      cwd: "/home/anton/.cache/clauctl-tui-parity/workdir/readonly-fold",
      style: PLAIN_STYLE,
    }),
    "Wrote 2 lines to ../../../../fruit.txt",
  );
  assert.equal(
    writeView.resultSummary(
      {},
      result({ ...fruitWrite, content: "carrot" }),
      PLAIN,
    ),
    "Wrote 1 line to /home/anton/fruit.txt",
  );
  // Trailing newline adds no line; relative filePath stays as recorded.
  assert.equal(
    writeView.resultSummary(
      {},
      result({
        ...fruitWrite,
        filePath: "fruit.txt",
        content: "apple\nbanana\n",
      }),
      { cwd: "/some/cwd", style: PLAIN_STYLE },
    ),
    "Wrote 2 lines to fruit.txt",
  );
  assert.equal(
    writeView.resultSummary(
      {},
      result({ ...fruitWrite, filePath: "./fruit.txt" }),
      { cwd: "/some/cwd", style: PLAIN_STYLE },
    ),
    "Wrote 2 lines to fruit.txt",
  );
  // Unexpected shapes fall back to the bare ⤷ summary, not a crash.
  assert.equal(writeView.resultSummary({}, result(undefined), PLAIN), "");
  assert.equal(
    writeView.resultSummary({}, result(undefined, true), PLAIN),
    "Error writing file",
  );
});

test("writeView resultBody: line-numbered content preview", () => {
  assert.equal(
    writeView.resultBody!({}, result(fruitWrite), PLAIN)!,
    [" 1 apple", " 2 banana"].join("\n"),
  );
  // Truncation past 10 lines, pinned by write-preview.claude.txt (40 lines
  // → 10 shown + marker; number field sized by the full count).
  const long = { ...fruitWrite, content: Array(40).fill("x").join("\n") };
  const longBody = writeView.resultBody!({}, result(long), PLAIN)!.split("\n");
  assert.equal(longBody.length, 11);
  assert.equal(longBody[0], "  1 x");
  assert.equal(longBody[9], " 10 x");
  assert.equal(longBody.at(-1), "… +30 lines (ctrl+o to expand)");
  assert.equal(writeView.resultBody?.({}, result(undefined), PLAIN), undefined);
  assert.equal(
    writeView.resultBody?.({}, result(fruitWrite, true), PLAIN),
    undefined,
  );
});

test("webSearchView: quoted query header, Did N searches summary, no fold", () => {
  assert.equal(
    webSearchView.header({ query: "latest node" }, PLAIN).arg,
    '"latest node"',
  );
  assert.equal(
    webSearchView.resultSummary(
      {},
      result({
        query: "q",
        results: [],
        durationSeconds: 3.96,
        searchCount: 1,
      }),
      PLAIN,
    ),
    "Did 1 search in 4s",
  );
  assert.equal(
    webSearchView.resultSummary(
      {},
      result({ durationSeconds: 10.2, searchCount: 2 }),
      PLAIN,
    ),
    "Did 2 searches in 10s",
  );
  assert.equal(webSearchView.resultSummary({}, result({}), PLAIN), "");
  assert.equal(webSearchView.foldLabel, undefined);
});

test("agentView: Done line from structured totals", () => {
  const structured = {
    totalToolUseCount: 2,
    totalTokens: 16_842,
    totalDurationMs: 14_400,
  };
  assert.equal(
    agentView.resultSummary({ description: "d" }, result(structured), PLAIN),
    "Done (2 tool uses · 16.8k tokens · 14s)",
  );
  assert.equal(
    agentView.resultSummary(
      {},
      result({ ...structured, totalToolUseCount: 1, totalDurationMs: 90_000 }),
      PLAIN,
    ),
    "Done (1 tool use · 16.8k tokens · 1m 30s)",
  );
  assert.equal(agentView.resultSummary({}, result({}), PLAIN), "");
  assert.equal(
    agentView.header({ description: "Count files" }, PLAIN).arg,
    "Count files",
  );
});

test("styled output strips to the plain output, method by method", () => {
  const ansi = { cwd: "/repo", style: ANSI_STYLE };
  const plain = { cwd: "/repo", style: PLAIN_STYLE };
  const edit = result({
    structuredPatch: [{ oldStart: 1, newStart: 1, lines: ["+a", "-b", " c"] }],
  });
  const write = result({
    ...fruitWrite,
    content: Array(12).fill("x").join("\n"),
  });
  const cases: [string, string][] = [
    [
      editView.resultSummary({}, edit, ansi),
      editView.resultSummary({}, edit, plain),
    ],
    [
      editView.resultBody!({}, edit, ansi)!,
      editView.resultBody!({}, edit, plain)!,
    ],
    [editView.foldLabel!(2, ANSI_STYLE), editView.foldLabel!(2, PLAIN_STYLE)],
    [
      readView.resultSummary(
        {},
        result({ type: "text", file: { numLines: 3 } }),
        ansi,
      ),
      readView.resultSummary(
        {},
        result({ type: "text", file: { numLines: 3 } }),
        plain,
      ),
    ],
    [readView.foldLabel!(2, ANSI_STYLE), readView.foldLabel!(2, PLAIN_STYLE)],
    [
      writeView.resultSummary({}, write, ansi),
      writeView.resultSummary({}, write, plain),
    ],
    [
      writeView.resultBody!({}, write, ansi)!,
      writeView.resultBody!({}, write, plain)!,
    ],
  ];
  for (const [styled, expected] of cases) {
    assert.notEqual(styled, expected);
    assert.equal(stripAnsi(styled), expected);
  }
});
