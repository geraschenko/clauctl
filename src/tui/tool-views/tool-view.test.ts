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
const editView = toolViewFor("Edit")!;
const readView = toolViewFor("Read")!;
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
      ),
    );
  assert.equal(summary(["+a"]), "Added 1 line");
  assert.equal(summary(["+a", "+b", "-c"]), "Added 2 lines, removed 1 line");
  assert.equal(summary(["-a"]), "Removed 1 line");
  assert.equal(summary([" context only"]), undefined);
  // Unexpected shapes fall back to the generic summary, not a crash.
  assert.equal(editView.resultSummary({}, result(null)), undefined);
  assert.equal(
    editView.resultSummary({}, result({ structuredPatch: "nope" })),
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

test("readView: Read N lines from structured numLines; readOnly folds", () => {
  assert.equal(
    plain(
      readView.resultSummary(
        {},
        result({ type: "text", file: { numLines: 42 } }),
      ),
    ),
    "Read 42 lines",
  );
  assert.equal(
    plain(
      readView.resultSummary(
        {},
        result({ type: "text", file: { numLines: 1 } }),
      ),
    ),
    "Read 1 line",
  );
  assert.equal(readView.resultSummary({}, result({})), undefined);
  assert.equal(readView.readOnly, true);
  assert.equal(plain(readView.foldLabel(2)), "read 2 files");
  assert.equal(plain(readView.foldLabel(1)), "read 1 file");
});

test("writeView: bare summary on success, fixed message on error", () => {
  assert.equal(writeView.resultSummary({}, result(undefined)), "");
  assert.equal(
    writeView.resultSummary({}, result(undefined, true)),
    "Error writing file",
  );
});

test("agentView: Done line from structured totals", () => {
  const structured = {
    totalToolUseCount: 2,
    totalTokens: 16_842,
    totalDurationMs: 14_400,
  };
  assert.equal(
    agentView.resultSummary({ description: "d" }, result(structured)),
    "Done (2 tool uses · 16.8k tokens · 14s)",
  );
  assert.equal(
    agentView.resultSummary(
      {},
      result({ ...structured, totalToolUseCount: 1, totalDurationMs: 90_000 }),
    ),
    "Done (1 tool use · 16.8k tokens · 1m 30s)",
  );
  assert.equal(agentView.resultSummary({}, result({})), undefined);
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
