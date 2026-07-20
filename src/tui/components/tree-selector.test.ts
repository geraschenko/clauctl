import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import { entriesByUuid, type SessionEntry } from "../../core/session-file.ts";
import {
  formatTreeNodeRef,
  type ParentMap,
  type TreeNodeRef,
} from "../../core/tree.ts";
import { resolveTreePick, TreeSelectorComponent } from "./tree-selector.ts";

function uuid(n: number): UUID {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

function userEntry(n: number, text: string): SessionEntry {
  return {
    type: "user",
    uuid: uuid(n),
    message: { role: "user", content: text },
  };
}

function assistantEntry(n: number, text: string): SessionEntry {
  return {
    type: "assistant",
    uuid: uuid(n),
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function boundaryEntry(n: number): SessionEntry {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: uuid(n),
    compactMetadata: { trigger: "manual", preTokens: 1000 },
  };
}

function summaryEntry(n: number, text: string, boundary: UUID): SessionEntry {
  return {
    type: "user",
    uuid: uuid(n),
    isCompactSummary: true,
    parentUuid: boundary,
    message: { role: "user", content: text },
  };
}

function ref(n: number, viaBoundary?: UUID): TreeNodeRef {
  return {
    uuid: uuid(n),
    ...(viaBoundary !== undefined && { viaBoundary }),
  };
}

/**
 * user(1) → assistant(2) → user(3) → assistant(4) → boundary(5) →
 * summary(6) → assistant(2)@5 → user(3)@5; leaf = the relinked user(3)@5.
 * A compaction that preserved the first exchange, mid-branch. Hand-built
 * (buildTree's construction is covered by its own tests); insertion order
 * is materialization order, which the rendered-row assertions rely on.
 */
const BOUNDARY = uuid(5);
const ENTRY_OF = entriesByUuid([
  userEntry(1, "hello world"),
  assistantEntry(2, "hi there"),
  userEntry(3, "second question"),
  assistantEntry(4, "answer two"),
  boundaryEntry(5),
  summaryEntry(6, "summary text", BOUNDARY),
]);
const PARENT_MAP: ParentMap = new Map(
  (
    [
      [ref(1), null],
      [ref(2), ref(1)],
      [ref(3), ref(2)],
      [ref(4), ref(3)],
      [ref(5), ref(4)],
      [ref(6), ref(5)],
      [ref(2, BOUNDARY), ref(6)],
      [ref(3, BOUNDARY), ref(2, BOUNDARY)],
    ] as [TreeNodeRef, TreeNodeRef | null][]
  ).map(([nodeRef, parent]) => [
    formatTreeNodeRef(nodeRef),
    parent === null ? null : formatTreeNodeRef(parent),
  ]),
);
const LEAF: TreeNodeRef = { uuid: uuid(3), viaBoundary: BOUNDARY };

test("resolveTreePick: assistant pick rewinds to itself", () => {
  assert.deepEqual(resolveTreePick(PARENT_MAP, ENTRY_OF, { uuid: uuid(4) }), {
    kind: "rewind",
    rewindTo: { uuid: uuid(4) },
  });
});

test("resolveTreePick: user pick rewinds to its assistant with editorText", () => {
  assert.deepEqual(resolveTreePick(PARENT_MAP, ENTRY_OF, { uuid: uuid(3) }), {
    kind: "rewind",
    rewindTo: { uuid: uuid(2) },
    editorText: "second question",
  });
});

test("resolveTreePick: a viaBoundary user pick's ancestor keeps its occurrence", () => {
  assert.deepEqual(
    resolveTreePick(PARENT_MAP, ENTRY_OF, {
      uuid: uuid(3),
      viaBoundary: BOUNDARY,
    }),
    {
      kind: "rewind",
      rewindTo: { uuid: uuid(2), viaBoundary: BOUNDARY },
      editorText: "second question",
    },
  );
});

test("resolveTreePick: boundary pick rewinds to the pre-boundary assistant, no editorText", () => {
  assert.deepEqual(resolveTreePick(PARENT_MAP, ENTRY_OF, { uuid: uuid(5) }), {
    kind: "rewind",
    rewindTo: { uuid: uuid(4) },
  });
});

test("resolveTreePick: a summary pick crosses its boundary to the assistant before it", () => {
  assert.deepEqual(resolveTreePick(PARENT_MAP, ENTRY_OF, { uuid: uuid(6) }), {
    kind: "rewind",
    rewindTo: { uuid: uuid(4) },
    editorText: "summary text",
  });
});

test("resolveTreePick: no assistant ancestor is a newRoot pick", () => {
  assert.deepEqual(resolveTreePick(PARENT_MAP, ENTRY_OF, { uuid: uuid(1) }), {
    kind: "newRoot",
    editorText: "hello world",
  });
});

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const BACKSPACE = "\x7f";

function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function isInverse(line: string): boolean {
  return line.includes("\x1b[7m");
}

/** The tree rows of a render: everything between the header line and the
 *  trailing search/warning lines, ANSI-stripped. */
function renderedRows(selector: TreeSelectorComponent): string[] {
  return selector
    .render(100)
    .slice(1)
    .map(stripAnsi)
    .filter((line) => !/^(search: |context changed)/.test(line));
}

function selectedRow(selector: TreeSelectorComponent): string | undefined {
  const line = selector.render(100).find(isInverse);
  return line === undefined ? undefined : stripAnsi(line);
}

function makeSelector(): {
  selector: TreeSelectorComponent;
  picks: unknown[];
  cancels: number[];
} {
  const picks: unknown[] = [];
  const cancels: number[] = [];
  const selector = new TreeSelectorComponent(
    LEAF,
    PARENT_MAP,
    ENTRY_OF,
    (pick) => picks.push(pick),
    () => cancels.push(1),
  );
  return { selector, picks, cancels };
}

test("selector shows the picker rows with the current leaf pre-selected", () => {
  const { selector } = makeSelector();
  const summaries = renderedRows(selector).map((row) =>
    row.replace(/^[\s│├└─*•]*/u, ""),
  );
  assert.deepEqual(summaries, [
    "user: hello world",
    "assistant: hi there",
    "user: second question",
    "assistant: answer two",
    "[compaction: 1k tokens]",
    "compaction: summary text",
    "assistant: hi there",
    "user: second question",
  ]);
  // Initial selection is the current leaf — the relinked occurrence.
  assert.match(selectedRow(selector)!, /\* user: second question$/u);
});

test("selector enter reports the selected occurrence ref", () => {
  const { selector, picks } = makeSelector();
  selector.handleInput(ENTER);
  assert.deepEqual(picks, [{ uuid: uuid(3), viaBoundary: BOUNDARY }]);
});

test("selector navigation wraps around", () => {
  const { selector, picks } = makeSelector();
  selector.handleInput(DOWN); // from the last row, wraps to the first
  selector.handleInput(ENTER);
  assert.deepEqual(picks, [{ uuid: uuid(1) }]);
  selector.handleInput(UP); // and back
  selector.handleInput(ENTER);
  assert.deepEqual(picks.at(-1), { uuid: uuid(3), viaBoundary: BOUNDARY });
});

test("selector search filters rows and recovers selection via ancestors", () => {
  const { selector } = makeSelector();
  for (const char of "answer") {
    selector.handleInput(char);
  }
  // Only assistant(4) matches; the hidden leaf's nearest visible ancestor
  // is that same node, so it becomes the selection. The leaf visibility
  // exemption does not apply to search.
  assert.deepEqual(renderedRows(selector), ["• assistant: answer two"]);
  assert.match(selectedRow(selector)!, /assistant: answer two$/u);
  assert.ok(
    selector.render(100).map(stripAnsi).includes("search: answer"),
    "search query line is rendered",
  );
});

test("selector backspace edits the search query", () => {
  const { selector } = makeSelector();
  for (const char of "answerx") {
    selector.handleInput(char);
  }
  assert.deepEqual(renderedRows(selector), ["(no matching entries)"]);
  selector.handleInput(BACKSPACE);
  assert.deepEqual(renderedRows(selector), ["• assistant: answer two"]);
});

test("selector escape clears the search, then cancels", () => {
  const { selector, cancels } = makeSelector();
  selector.handleInput("z");
  selector.handleInput(ESCAPE);
  assert.equal(cancels.length, 0);
  assert.equal(renderedRows(selector).length, 8);
  selector.handleInput(ESCAPE);
  assert.equal(cancels.length, 1);
});

test("selector with zero visible rows says so and ignores enter", () => {
  const { selector, picks } = makeSelector();
  for (const char of "zzz") {
    selector.handleInput(char);
  }
  assert.ok(
    selector.render(100).map(stripAnsi).includes("(no matching entries)"),
  );
  selector.handleInput(ENTER);
  assert.deepEqual(picks, []);
});

test("selector warning renders persistently once set", () => {
  const { selector } = makeSelector();
  selector.setWarning("context changed while the tree selector is open");
  const lines = selector.render(100).map(stripAnsi);
  assert.ok(lines.includes("context changed while the tree selector is open"));
  selector.handleInput(DOWN);
  assert.ok(
    selector
      .render(100)
      .map(stripAnsi)
      .includes("context changed while the tree selector is open"),
  );
});
