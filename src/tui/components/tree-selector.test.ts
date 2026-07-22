import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import { buildDisplayTree } from "../../core/build-display-tree.ts";
import { buildTree } from "../../core/build-tree.ts";
import { entriesByUuid, type SessionEntry } from "../../core/session-file.ts";
import type { TreeNodeRef } from "../../core/tree.ts";
import { resolveTreePick, TreeSelectorComponent } from "./tree-selector.ts";

function uuid(n: number): UUID {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

const failOnInvalid = (message: string): never => {
  throw new Error(`unexpected onInvalid: ${message}`);
};

function userEntry(n: number, text: string, parent?: number): SessionEntry {
  return {
    type: "user",
    uuid: uuid(n),
    parentUuid: parent === undefined ? null : uuid(parent),
    message: { role: "user", content: text },
  };
}

function assistantEntry(
  n: number,
  text: string,
  parent?: number,
): SessionEntry {
  return {
    type: "assistant",
    uuid: uuid(n),
    parentUuid: parent === undefined ? null : uuid(parent),
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function boundaryEntry(
  n: number,
  params: { uuids: number[]; anchor: number; logicalParent: number },
): SessionEntry {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: uuid(n),
    parentUuid: null,
    logicalParentUuid: uuid(params.logicalParent),
    compactMetadata: {
      trigger: "manual",
      preTokens: 1000,
      preservedMessages: {
        anchorUuid: uuid(params.anchor),
        uuids: params.uuids.map(uuid),
      },
    },
  };
}

function summaryEntry(n: number, text: string, boundary: number): SessionEntry {
  return {
    type: "user",
    uuid: uuid(n),
    isCompactSummary: true,
    parentUuid: uuid(boundary),
    message: { role: "user", content: text },
  };
}

/**
 * Raw chain user(1) → assistant(2) → user(3) → assistant(4), then an up_to
 * compaction that preserved the first exchange: boundary(5) anchored at
 * summary(6), relinking assistant(2)@5 → user(3)@5; leaf = the relinked
 * user(3)@5. Full tree: 1 → 2 → 3 → 4 → 5 → 6 → 2@5 → 3@5. Display tree:
 * the relinked rows are hidden behind the summary and the boundary
 * re-anchors at raw 3, forking there with 4.
 */
const BOUNDARY = uuid(5);
const ENTRIES = [
  userEntry(1, "hello world"),
  assistantEntry(2, "hi there", 1),
  userEntry(3, "second question", 2),
  assistantEntry(4, "answer two", 3),
  boundaryEntry(5, { uuids: [2, 3], anchor: 6, logicalParent: 4 }),
  summaryEntry(6, "summary text", 5),
];
const ENTRY_OF = entriesByUuid(ENTRIES);
const PARENT_MAP = buildTree(ENTRIES, failOnInvalid);
const DISPLAY_TREE = buildDisplayTree(ENTRIES, failOnInvalid);
const LEAF: TreeNodeRef = { uuid: uuid(3), viaBoundary: BOUNDARY };

function resolve(pick: TreeNodeRef): unknown {
  return resolveTreePick(PARENT_MAP, ENTRIES, ENTRY_OF, pick, failOnInvalid);
}

test("resolveTreePick: assistant pick rewinds to itself", () => {
  assert.deepEqual(resolve({ uuid: uuid(4) }), {
    kind: "rewind",
    rewindTo: { uuid: uuid(4) },
  });
});

test("resolveTreePick: user pick rewinds to its assistant with editorText", () => {
  assert.deepEqual(resolve({ uuid: uuid(3) }), {
    kind: "rewind",
    rewindTo: { uuid: uuid(2) },
    editorText: "second question",
  });
});

test("resolveTreePick: a viaBoundary user pick's ancestor keeps its occurrence", () => {
  assert.deepEqual(resolve({ uuid: uuid(3), viaBoundary: BOUNDARY }), {
    kind: "rewind",
    rewindTo: { uuid: uuid(2), viaBoundary: BOUNDARY },
    editorText: "second question",
  });
});

// Success criterion 3: a post-compaction user row is raw in the display
// tree, but its full-tree ancestry runs through the relinked chain — the
// resolved ancestor keeps its viaBoundary occurrence, so editing the
// message stays inside the compacted context.
test("resolveTreePick: post-compaction user pick keeps the compacted context", () => {
  const entries = [...ENTRIES, userEntry(7, "after compaction", 3)];
  const action = resolveTreePick(
    buildTree(entries, failOnInvalid),
    entries,
    entriesByUuid(entries),
    { uuid: uuid(7) },
    failOnInvalid,
  );
  assert.deepEqual(action, {
    kind: "rewind",
    rewindTo: { uuid: uuid(2), viaBoundary: BOUNDARY },
    editorText: "after compaction",
  });
});

test("resolveTreePick: boundary pick undoes the boundary, no editorText", () => {
  assert.deepEqual(resolve({ uuid: uuid(5) }), {
    kind: "rewind",
    rewindTo: { uuid: uuid(4) },
  });
});

test("resolveTreePick: summary pick is the same undo, no editorText", () => {
  assert.deepEqual(resolve({ uuid: uuid(6) }), {
    kind: "rewind",
    rewindTo: { uuid: uuid(4) },
  });
});

// A from-shape summary's display row is the relinked occurrence S@B — its
// pick is the same boundary undo, keyed off the entry, not the occurrence.
test("resolveTreePick: from-shape relinked summary pick undoes its boundary", () => {
  const entries = [
    userEntry(1, "hello"),
    assistantEntry(2, "reply", 1),
    boundaryEntry(3, { uuids: [1, 2], anchor: 3, logicalParent: 2 }),
    summaryEntry(4, "recap", 3),
  ];
  const action = resolveTreePick(
    buildTree(entries, failOnInvalid),
    entries,
    entriesByUuid(entries),
    { uuid: uuid(4), viaBoundary: uuid(3) },
    failOnInvalid,
  );
  assert.deepEqual(action, {
    kind: "rewind",
    rewindTo: { uuid: uuid(2) },
  });
});

test("resolveTreePick: no assistant ancestor is a newRoot pick", () => {
  assert.deepEqual(resolve({ uuid: uuid(1) }), {
    kind: "newRoot",
    editorText: "hello world",
  });
});

// The pre-boundary context tip can itself be a relinked occurrence of an
// older boundary — the undo resolves it via the pre-boundary effective
// chain, not raw ancestors of logicalParentUuid.
test("resolveTreePick: boundary undo lands on an older boundary's relinked tip", () => {
  const entries = [
    userEntry(1, "hello"),
    assistantEntry(2, "reply", 1),
    boundaryEntry(3, { uuids: [2], anchor: 4, logicalParent: 1 }),
    summaryEntry(4, "first summary", 3),
    boundaryEntry(5, { uuids: [2], anchor: 4, logicalParent: 2 }),
  ];
  const action = resolveTreePick(
    buildTree(entries, failOnInvalid),
    entries,
    entriesByUuid(entries),
    { uuid: uuid(5) },
    failOnInvalid,
  );
  assert.deepEqual(action, {
    kind: "rewind",
    rewindTo: { uuid: uuid(2), viaBoundary: uuid(3) },
  });
});

test("resolveTreePick: boundary undo with no pre-boundary assistant is newRoot without editorText", () => {
  const entries = [
    userEntry(1, "hello"),
    boundaryEntry(2, { uuids: [1], anchor: 3, logicalParent: 1 }),
    summaryEntry(3, "summary", 2),
  ];
  const action = resolveTreePick(
    buildTree(entries, failOnInvalid),
    entries,
    entriesByUuid(entries),
    { uuid: uuid(2) },
    failOnInvalid,
  );
  assert.deepEqual(action, { kind: "newRoot" });
});

// A summary whose parent is not a boundary (corrupt or hand-crafted file)
// falls back to ordinary user-row pick semantics.
test("resolveTreePick: malformed summary pick uses user-row semantics", () => {
  const entries = [
    userEntry(1, "hello"),
    assistantEntry(2, "reply", 1),
    { ...userEntry(3, "orphan summary", 2), isCompactSummary: true },
  ];
  const action = resolveTreePick(
    buildTree(entries, failOnInvalid),
    entries,
    entriesByUuid(entries),
    { uuid: uuid(3) },
    failOnInvalid,
  );
  assert.deepEqual(action, {
    kind: "rewind",
    rewindTo: { uuid: uuid(2) },
    editorText: "orphan summary",
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
    DISPLAY_TREE,
    ENTRY_OF,
    (pick) => picks.push(pick),
    () => cancels.push(1),
  );
  return { selector, picks, cancels };
}

test("selector shows the display rows with the leaf's representative pre-selected", () => {
  const { selector } = makeSelector();
  const summaries = renderedRows(selector).map((row) =>
    row.replace(/^[\s│├└─*•]*/u, ""),
  );
  // The relinked occurrences are hidden; the boundary re-anchors at raw 3
  // (the last preserved uuid's row), forking there with 4; the active
  // branch renders first.
  assert.deepEqual(summaries, [
    "user: hello world",
    "assistant: hi there",
    "user: second question",
    "[compaction: 1k tokens]",
    "compaction: summary text",
    "assistant: answer two",
  ]);
  // Initial selection: the hidden relinked leaf's representative, the
  // summary row (block tail).
  assert.match(selectedRow(selector)!, /\* compaction: summary text$/u);
});

test("selector enter reports the selected row's own occurrence ref", () => {
  const { selector, picks } = makeSelector();
  selector.handleInput(ENTER);
  assert.deepEqual(picks, [{ uuid: uuid(6) }]);
});

test("selector navigation wraps around", () => {
  const { selector, picks } = makeSelector();
  selector.handleInput(DOWN); // to the last row
  selector.handleInput(DOWN); // wraps to the first
  selector.handleInput(ENTER);
  assert.deepEqual(picks, [{ uuid: uuid(1) }]);
  selector.handleInput(UP); // and back to the last
  selector.handleInput(ENTER);
  assert.deepEqual(picks.at(-1), { uuid: uuid(4) });
});

test("selector search filters rows and recovers selection via ancestors", () => {
  const { selector } = makeSelector();
  for (const char of "answer") {
    selector.handleInput(char);
  }
  // Only assistant(4) matches (off the active path, so no marker); none of
  // the selected summary row's ancestors are visible, so the selection
  // clamps to it. The leaf visibility exemption does not apply to search.
  assert.deepEqual(renderedRows(selector), ["assistant: answer two"]);
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
  assert.deepEqual(renderedRows(selector), ["assistant: answer two"]);
});

test("selector escape clears the search, then cancels", () => {
  const { selector, cancels } = makeSelector();
  selector.handleInput("z");
  selector.handleInput(ESCAPE);
  assert.equal(cancels.length, 0);
  assert.equal(renderedRows(selector).length, 6);
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
