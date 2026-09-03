import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import type { RenderToolResult } from "../render-types.ts";
import { wrapHeaderArg } from "../components/tool-execution.ts";
import { abbreviatePath } from "./args.ts";
import { toolViewFor } from "./tool-view.ts";

// Tests exercise views through toolViewFor — the erased ToolView<unknown>
// shape callers use — so fixture args need no generated-type ceremony.
const agentView = toolViewFor("Agent")!;
const bashView = toolViewFor("Bash")!;
const editView = toolViewFor("Edit")!;
const readView = toolViewFor("Read")!;
const webSearchView = toolViewFor("WebSearch")!;
const writeView = toolViewFor("Write")!;

function result(
  toolUseResult: unknown,
  isError = false,
  content = "",
): RenderToolResult {
  return { toolCallId: "t", content, isError, toolUseResult };
}

/** Summaries carry SGR bold around counts; strip escapes for assertions. */
function plain(text: string | undefined): string | undefined {
  // eslint-disable-next-line no-control-regex
  return text?.replaceAll(/\u001b\[[0-9;]*m/g, "");
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

test("toolViewFor: known tools resolve, unknown/legacy tools do not", () => {
  assert.ok(toolViewFor("Edit"));
  assert.ok(toolViewFor("Agent"));
  assert.equal(toolViewFor("Grep"), undefined);
  assert.equal(toolViewFor("mcp__foo__bar"), undefined);
});

test("editView summary: singular/plural, zero parts omitted", () => {
  const summary = (lines: string[]): string | undefined =>
    plain(
      editView.resultSummary(
        {},
        result({ structuredPatch: [{ oldStart: 1, newStart: 1, lines }] }),
        undefined,
      ),
    );
  assert.equal(summary(["+a"]), "Added 1 line");
  assert.equal(summary(["+a", "+b", "-c"]), "Added 2 lines, removed 1 line");
  assert.equal(summary(["-a"]), "Removed 1 line");
  assert.equal(summary([" context only"]), undefined);
  // Unexpected shapes fall back to the generic summary, not a crash.
  assert.equal(editView.resultSummary({}, result(null), undefined), undefined);
  assert.equal(
    editView.resultSummary({}, result({ structuredPatch: "nope" }), undefined),
    undefined,
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
  );
  assert.equal(
    plain(body),
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
  );
  assert.equal(
    plain(body),
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
  );
  assert.equal(
    plain(body),
    ["   8 -x", "   8 +y", "...", " 120  z"].join("\n"),
  );
});

test("editView resultBody: no diff on error, malformed, or change-free patch", () => {
  assert.equal(editView.resultBody?.({}, result(undefined)), undefined);
  assert.equal(
    editView.resultBody?.({}, result({ structuredPatch: [divHunk] }, true)),
    undefined,
  );
  assert.equal(
    editView.resultBody?.(
      {},
      result({ structuredPatch: [{ ...divHunk, oldStart: "12" }] }),
    ),
    undefined,
  );
  assert.equal(
    editView.resultBody?.(
      {},
      result({ structuredPatch: [{ ...divHunk, lines: [" ctx only"] }] }),
    ),
    undefined,
  );
});

test("readView: Read N lines from structured numLines; fold labels", () => {
  assert.equal(
    plain(
      readView.resultSummary(
        {},
        result({ type: "text", file: { numLines: 42 } }),
        undefined,
      ),
    ),
    "Read 42 lines",
  );
  assert.equal(
    plain(
      readView.resultSummary(
        {},
        result({ type: "text", file: { numLines: 1 } }),
        undefined,
      ),
    ),
    "Read 1 line",
  );
  assert.equal(readView.resultSummary({}, result({}), undefined), undefined);
  assert.equal(plain(readView.foldLabel?.(2)), "read 2 files");
  assert.equal(plain(readView.foldLabel?.(1)), "read 1 file");
});

test("bashView: empty-output sentinel displays as (No output)", () => {
  assert.equal(
    bashView.resultSummary(
      {},
      result(undefined, false, "(Bash completed with no output)"),
      undefined,
    ),
    "(No output)",
  );
  // Real output and errors keep the generic first-lines summary.
  assert.equal(
    bashView.resultSummary({}, result(undefined, false, "hello"), undefined),
    undefined,
  );
  assert.equal(
    bashView.resultSummary(
      {},
      result(undefined, true, "(Bash completed with no output)"),
      undefined,
    ),
    undefined,
  );
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
    plain(
      writeView.resultSummary(
        {},
        result(fruitWrite),
        "/home/anton/.cache/clauctl-tui-parity/workdir/readonly-fold",
      ),
    ),
    "Wrote 2 lines to ../../../../fruit.txt",
  );
  assert.equal(
    plain(
      writeView.resultSummary(
        {},
        result({ ...fruitWrite, content: "carrot" }),
        undefined,
      ),
    ),
    "Wrote 1 line to /home/anton/fruit.txt",
  );
  // Trailing newline adds no line; relative filePath stays as recorded.
  assert.equal(
    plain(
      writeView.resultSummary(
        {},
        result({
          ...fruitWrite,
          filePath: "fruit.txt",
          content: "apple\nbanana\n",
        }),
        "/some/cwd",
      ),
    ),
    "Wrote 2 lines to fruit.txt",
  );
  assert.equal(
    plain(
      writeView.resultSummary(
        {},
        result({ ...fruitWrite, filePath: "./fruit.txt" }),
        "/some/cwd",
      ),
    ),
    "Wrote 2 lines to fruit.txt",
  );
  // Unexpected shapes fall back to the bare ⤷ summary, not a crash.
  assert.equal(writeView.resultSummary({}, result(undefined), undefined), "");
  assert.equal(
    writeView.resultSummary({}, result(undefined, true), undefined),
    "Error writing file",
  );
});

test("writeView resultBody: line-numbered content preview", () => {
  assert.equal(
    plain(writeView.resultBody?.({}, result(fruitWrite))),
    [" 1 apple", " 2 banana"].join("\n"),
  );
  // Truncation past 10 lines, pinned by write-preview.claude.txt (40 lines
  // → 10 shown + marker; number field sized by the full count).
  const long = { ...fruitWrite, content: Array(40).fill("x").join("\n") };
  const longBody = plain(writeView.resultBody?.({}, result(long)))?.split("\n");
  assert.equal(longBody?.length, 11);
  assert.equal(longBody?.[0], "  1 x");
  assert.equal(longBody?.[9], " 10 x");
  assert.equal(longBody?.at(-1), "… +30 lines (ctrl+o to expand)");
  assert.equal(writeView.resultBody?.({}, result(undefined)), undefined);
  assert.equal(writeView.resultBody?.({}, result(fruitWrite, true)), undefined);
});

test("webSearchView: quoted query header, Did N searches summary, no fold", () => {
  assert.equal(
    webSearchView.headerArg({ query: "latest node" }, undefined),
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
      undefined,
    ),
    "Did 1 search in 4s",
  );
  assert.equal(
    webSearchView.resultSummary(
      {},
      result({ durationSeconds: 10.2, searchCount: 2 }),
      undefined,
    ),
    "Did 2 searches in 10s",
  );
  assert.equal(
    webSearchView.resultSummary({}, result({}), undefined),
    undefined,
  );
  assert.equal(webSearchView.foldLabel, undefined);
});

test("agentView: Done line from structured totals", () => {
  const structured = {
    totalToolUseCount: 2,
    totalTokens: 16_842,
    totalDurationMs: 14_400,
  };
  assert.equal(
    agentView.resultSummary(
      { description: "d" },
      result(structured),
      undefined,
    ),
    "Done (2 tool uses · 16.8k tokens · 14s)",
  );
  assert.equal(
    agentView.resultSummary(
      {},
      result({ ...structured, totalToolUseCount: 1, totalDurationMs: 90_000 }),
      undefined,
    ),
    "Done (1 tool use · 16.8k tokens · 1m 30s)",
  );
  assert.equal(agentView.resultSummary({}, result({}), undefined), undefined);
  assert.equal(
    agentView.headerArg({ description: "Count files" }, undefined),
    "Count files",
  );
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
