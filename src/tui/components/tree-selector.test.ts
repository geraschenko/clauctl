import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import { buildTree } from "../../core/tree/build-tree.ts";
import { toContextTree } from "../../core/tree/context-tree.ts";
import { toDisplayTree } from "../../core/tree/display-tree.ts";
import { entriesByUuid, type SessionEntry } from "../../core/session/file.ts";
import type { TreeNodeRef } from "../../core/tree/nodes.ts";
import { stripAnsi } from "../../core/generated/text.ts";
import { resolveTreePick, TreeSelectorComponent } from "./tree-selector.ts";

function uuid(n: number): UUID {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

const failOnInvalid = (message: string): never => {
  throw new Error(`unexpected onInvalid: ${message}`);
};

/** A user entry with text that the CLI did not attribute to the human:
 *  origin-era writer, no `origin`. */
function nonHumanUserEntry(
  n: number,
  text: string,
  parent?: number,
): SessionEntry {
  return {
    type: "user",
    uuid: uuid(n),
    parentUuid: parent === undefined ? null : uuid(parent),
    version: "2.1.258",
    message: { role: "user", content: text },
  };
}

function userEntry(n: number, text: string, parent?: number): SessionEntry {
  return { ...nonHumanUserEntry(n, text, parent), origin: { kind: "human" } };
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
const DISPLAY_TREE = toDisplayTree(
  PARENT_MAP,
  toContextTree(PARENT_MAP, ENTRY_OF),
  ENTRY_OF,
);
const LEAF: TreeNodeRef = { uuid: uuid(3), viaBoundary: BOUNDARY };

function resolveIn(entries: SessionEntry[], pick: TreeNodeRef): unknown {
  const byUuid = entriesByUuid(entries);
  return resolveTreePick(
    toContextTree(buildTree(entries, failOnInvalid), byUuid),
    byUuid,
    pick,
  );
}

function resolve(pick: TreeNodeRef): unknown {
  return resolveIn(ENTRIES, pick);
}

test("resolveTreePick: assistant pick rewinds to itself", () => {
  assert.deepEqual(resolve({ uuid: uuid(4) }), { rewindTo: { uuid: uuid(4) } });
});

test("resolveTreePick: user pick rewinds to its context parent with editorText", () => {
  assert.deepEqual(resolve({ uuid: uuid(3) }), {
    rewindTo: { uuid: uuid(2) },
    editorText: "second question",
  });
});

test("resolveTreePick: a viaBoundary user pick's parent keeps its occurrence", () => {
  assert.deepEqual(resolve({ uuid: uuid(3), viaBoundary: BOUNDARY }), {
    rewindTo: { uuid: uuid(2), viaBoundary: BOUNDARY },
    editorText: "second question",
  });
});

// A post-compaction user row is raw in the display tree, but its
// context-tree parent is the relinked leaf — the rewind stays inside the
// compacted context.
test("resolveTreePick: post-compaction user pick keeps the compacted context", () => {
  const entries = [...ENTRIES, userEntry(7, "after compaction", 3)];
  assert.deepEqual(resolveIn(entries, { uuid: uuid(7) }), {
    rewindTo: { uuid: uuid(3), viaBoundary: BOUNDARY },
    editorText: "after compaction",
  });
});

// A prompt's context parent need not be an assistant: the state before
// the prompt is whatever it was parented on. Only real prompts step back;
// system entries, isMeta prompts and tool results rewind to themselves.
test("resolveTreePick: only a human prompt rewinds to its parent", () => {
  const entries: SessionEntry[] = [
    userEntry(1, "hello"),
    assistantEntry(2, "reply", 1),
    {
      type: "system",
      subtype: "turn_duration",
      uuid: uuid(3),
      parentUuid: uuid(2),
    },
    userEntry(4, "next", 3),
    { ...nonHumanUserEntry(5, "skill expansion", 4), isMeta: true },
    {
      type: "user",
      uuid: uuid(6),
      parentUuid: uuid(5),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    },
    nonHumanUserEntry(7, "<command-name>/compact</command-name>", 6),
  ];
  assert.deepEqual(resolveIn(entries, { uuid: uuid(4) }), {
    rewindTo: { uuid: uuid(3) },
    editorText: "next",
  });
  for (const n of [3, 5, 6, 7]) {
    assert.deepEqual(resolveIn(entries, { uuid: uuid(n) }), {
      rewindTo: { uuid: uuid(n) },
    });
  }
});

// Summary and boundary picks keep the compaction in effect: the state
// right after it — for up_to, the last preserved relinked row (the summary
// precedes the preserved rows in context).
test("resolveTreePick: summary and boundary picks rewind to the up_to compaction tip", () => {
  const tip = { rewindTo: { uuid: uuid(3), viaBoundary: BOUNDARY } };
  assert.deepEqual(resolve({ uuid: uuid(6) }), tip);
  assert.deepEqual(resolve({ uuid: uuid(5) }), tip);
});

// From shape: the summary is raw under the relinked tail, so it is the
// tip; the post-compaction turn (5) is dropped.
test("resolveTreePick: from-shape summary and boundary picks rewind to the summary", () => {
  const entries = [
    userEntry(1, "hello"),
    assistantEntry(2, "reply", 1),
    boundaryEntry(3, { uuids: [1, 2], anchor: 3, logicalParent: 2 }),
    summaryEntry(4, "recap", 3),
    userEntry(5, "after compaction", 4),
  ];
  const tip = { rewindTo: { uuid: uuid(4) } };
  assert.deepEqual(resolveIn(entries, { uuid: uuid(4) }), tip);
  assert.deepEqual(resolveIn(entries, { uuid: uuid(3) }), tip);
});

test("resolveTreePick: no-summary rewind boundary pick rewinds to its last preserved row", () => {
  const entries = [
    userEntry(1, "hello"),
    assistantEntry(2, "reply", 1),
    userEntry(3, "more", 2),
    assistantEntry(4, "reply two", 3),
    boundaryEntry(5, { uuids: [1, 2], anchor: 5, logicalParent: 2 }),
  ];
  assert.deepEqual(resolveIn(entries, { uuid: uuid(5) }), {
    rewindTo: { uuid: uuid(2), viaBoundary: uuid(5) },
  });
});

test("resolveTreePick: wipe boundary pick is the empty context", () => {
  const entries = [
    userEntry(1, "hello"),
    assistantEntry(2, "reply", 1),
    boundaryEntry(3, { uuids: [], anchor: 3, logicalParent: 2 }),
  ];
  assert.deepEqual(resolveIn(entries, { uuid: uuid(3) }), { rewindTo: null });
});

test("resolveTreePick: root user pick is the empty context with editorText", () => {
  assert.deepEqual(resolve({ uuid: uuid(1) }), {
    rewindTo: null,
    editorText: "hello world",
  });
});

// A summary whose parent is not a boundary (corrupt or hand-crafted file)
// is an ordinary user prompt.
test("resolveTreePick: malformed summary pick uses user-row semantics", () => {
  const entries = [
    userEntry(1, "hello"),
    assistantEntry(2, "reply", 1),
    { ...userEntry(3, "orphan summary", 2), isCompactSummary: true },
  ];
  assert.deepEqual(resolveIn(entries, { uuid: uuid(3) }), {
    rewindTo: { uuid: uuid(2) },
    editorText: "orphan summary",
  });
});

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const BACKSPACE = "\x7f";

function isInverse(line: string): boolean {
  return line.includes("\x1b[7m");
}

/** The tree row lines of a render: everything between the header line and
 *  the trailing search/warning lines, ANSI-stripped, connector-only filler
 *  lines dropped. */
function renderedRows(selector: TreeSelectorComponent): string[] {
  return selector
    .render(100)
    .slice(1)
    .map((line) => stripAnsi(line))
    .filter(
      (line) =>
        !/^(search: |context changed)/.test(line) && /[a-z[]/.test(line),
    );
}

/** A rendered row line minus its graph prefix and glyph. */
function labelOf(row: string): string {
  return row.replace(/^[^a-z[(]*/u, "");
}

function selectedRow(selector: TreeSelectorComponent): string | undefined {
  const line = selector.render(100).find(isInverse);
  return line === undefined ? undefined : stripAnsi(line);
}

function makeSelector(sizes = false): {
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
    new Map<string, string>(),
    { showSizes: sizes },
    (pick) => picks.push(pick),
    () => cancels.push(1),
  );
  // Rows exist only once rendered at a width (summaries are width-bounded).
  selector.render(100);
  return { selector, picks, cancels };
}

test("selector shows the display rows with the leaf's visible row pre-selected", () => {
  const { selector } = makeSelector();
  // The relinked occurrences are hidden; the boundary re-anchors at raw 3
  // (the last preserved uuid's row), forking there with 4; rows are in
  // file order with the active chain in column 0.
  const rows = selector.render(100).slice(1).map(stripAnsi);
  assert.deepEqual(rows, [
    "❯  hello world",
    "●  hi there",
    "❯    second question",
    "├─╮",
    "│ ●  answer two",
    "═  [compaction: 1k tokens]",
    "□  summary text",
  ]);
  // With sizes: right-aligned at the render width; connector lines carry none.
  const sized = makeSelector(true).selector.render(100).slice(1).map(stripAnsi);
  assert.equal(sized[0], `${"❯  hello world".padEnd(97)} 11`);
  assert.equal(sized[3], "├─╮");
  // Initial selection: the hidden relinked leaf's nearest visible row, the
  // summary row.
  assert.equal(selectedRow(selector), "□  summary text");
});

test("selector enter reports the selected row's own occurrence ref", () => {
  const { selector, picks } = makeSelector();
  selector.handleInput(ENTER);
  assert.deepEqual(picks, [{ uuid: uuid(6) }]);
});

test("selector navigation stops at the ends", () => {
  const { selector, picks } = makeSelector();
  selector.handleInput(DOWN); // already on the last row: stays
  selector.handleInput(ENTER);
  assert.deepEqual(picks, [{ uuid: uuid(6) }]);
  for (let step = 0; step < 10; step += 1) {
    selector.handleInput(UP);
  }
  selector.handleInput(UP); // on the first row: stays
  selector.handleInput(ENTER);
  assert.deepEqual(picks.at(-1), { uuid: uuid(1) });
});

test("selector navigation skips connector lines", () => {
  const { selector, picks } = makeSelector();
  selector.handleInput(UP);
  selector.handleInput(UP);
  assert.equal(labelOf(selectedRow(selector)!), "answer two");
  selector.handleInput(UP); // over the ├─╮ line
  assert.equal(labelOf(selectedRow(selector)!), "second question");
  selector.handleInput(DOWN);
  selector.handleInput(ENTER);
  assert.deepEqual(picks, [{ uuid: uuid(4) }]);
});

test("selector search filters rows and recovers selection via ancestors", () => {
  const { selector } = makeSelector();
  for (const char of "answer") {
    selector.handleInput(char);
  }
  // Only assistant(4) matches, shown as a flat glyph + label line; none
  // of the selected summary row's ancestors are visible, so the selection
  // clamps to it. The leaf visibility exemption does not apply to search.
  assert.deepEqual(renderedRows(selector), ["● answer two"]);
  assert.equal(selectedRow(selector), "● answer two");
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
  assert.deepEqual(renderedRows(selector), ["● answer two"]);
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
