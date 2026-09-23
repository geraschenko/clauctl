import assert from "node:assert/strict";
import { test } from "node:test";
import { dagLineText, renderDagLines, type DagRow } from "./dag-lines.ts";
import { formatSize } from "./generated/text.ts";

function row(
  id: string,
  parentId: string | null,
  glyph = "●",
  label = id,
  size: number | undefined = undefined,
): DagRow {
  return { id, parentId, glyph, label, size };
}

function texts(rows: readonly DagRow[], leaf: string | null) {
  return renderDagLines(rows, leaf).map((line) => dagLineText(line, 80));
}

// A fork whose active branch is the LATER child: the chain stays in
// column 0 because the active child is fed first; the link line is a
// filler line (no rowId).
test("active chain stays in column 0 across a fork; connector lines are filler", () => {
  const rows = [row("1", null), row("2", "1"), row("3", "1"), row("4", "3")];
  const lines = renderDagLines(rows, "4");
  assert.deepEqual(
    lines.map((line) => line.rowId),
    ["1", undefined, "2", "3", "4"],
  );
  assert.deepEqual(
    lines.map((line) => dagLineText(line, 80)),
    ["●    1", "├─╮", "│ ●  2", "●  3", "●  4"],
  );
  // The row line splits the graph text around the glyph.
  assert.deepEqual(lines[2], {
    rowId: "2",
    prefix: "│ ",
    glyph: "●",
    suffix: "  ",
    label: "2",
    size: undefined,
  });
});

test("a leaf with children keeps column 0 empty below it (terminator + reserved column)", () => {
  const rows = [row("1", null), row("2", "1"), row("3", "1"), row("4", "3")];
  assert.deepEqual(texts(rows, "1"), [
    "●      1",
    "├─┬─╮",
    "│ │ │",
    "~ │ │",
    "  │ │",
    "  ● │  2",
    "    ●  3",
    "    ●  4",
  ]);
});

test("a childless leaf still reserves column 0 for the rest of the graph", () => {
  const rows = [row("1", null), row("2", "1"), row("3", "1")];
  assert.deepEqual(texts(rows, "2"), ["●    1", "├─╮", "● │  2", "  ●  3"]);
});

test("the active root is column 0 even when an earlier root exists", () => {
  const rows = [row("1", null), row("2", null), row("3", "1"), row("4", "2")];
  assert.deepEqual(texts(rows, "4"), ["  ●  1", "● │  2", "│ ●  3", "●  4"]);
});

test("without a leaf no column is reserved and glyphs pass through", () => {
  const rows = [row("1", null, "❯", "one"), row("2", "1", "═", "two")];
  assert.deepEqual(texts(rows, null), ["❯  one", "═  two"]);
});

test("dagLineText truncates to width and trims trailing whitespace", () => {
  const [line] = renderDagLines([row("1", null, "●", "a long label")], null);
  assert.equal(dagLineText(line!, 8), "●  a lo…");
  assert.equal(dagLineText({ ...line!, label: "" }, 80), "●");
});

test("formatSize: plain under 1k, one decimal under 10k, whole k above", () => {
  assert.equal(formatSize(0), "0");
  assert.equal(formatSize(348), "348");
  assert.equal(formatSize(1_234), "1.2k");
  assert.equal(formatSize(9_876), "9.9k");
  assert.equal(formatSize(12_400), "12k");
});

test("dagLineText right-aligns the size at width; filler lines and 0 sizes show none", () => {
  const lines = renderDagLines(
    [
      row("1", null, "●", "one", 348),
      row("2", "1", "●", "two", 1_234),
      row("3", "1", "●", "three", 0),
    ],
    "3",
  );
  assert.deepEqual(
    lines.map((line) => dagLineText(line, 20)),
    ["●    one         348", "├─╮", "│ ●  two        1.2k", "●  three"],
  );
  // The label truncates before the size does; width below the size column
  // keeps the size alone, still right-aligned, without its separator.
  const [long] = renderDagLines([row("1", null, "●", "a long label", 5)], null);
  assert.equal(dagLineText(long!, 10), "●  a lo… 5");
  assert.equal(dagLineText(long!, 2), " 5");
  assert.equal(dagLineText(long!, 1), "5");
  const [big] = renderDagLines([row("1", null, "●", "label", 348)], null);
  assert.equal(dagLineText(big!, 4), " 348");
});

test("dagLineText pads by code points, so astral characters keep the size aligned", () => {
  const [line] = renderDagLines([row("1", null, "●", "😀 label", 7)], null);
  const rendered = dagLineText(line!, 14);
  assert.equal(rendered, "●  😀 label   7");
  assert.equal([...rendered].length, 14);
});

test("a row preceding its parent is rejected", () => {
  assert.throws(
    () => renderDagLines([row("2", "1"), row("1", null)], null),
    /precedes its parent/,
  );
});

test("a leaf that is not a row is rejected", () => {
  assert.throws(() => renderDagLines([row("1", null)], "9"), /is not a row/);
});
