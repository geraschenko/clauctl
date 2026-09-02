import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import { buildTree } from "../core/tree/build-tree.ts";
import type { SessionSnapshot } from "../core/tree/nodes.ts";
import { loadedContext } from "../core/tree/loader.ts";
import { entriesByUuid, type SessionEntry } from "../core/session/file.ts";
import {
  formatSessionSnapshot,
  treeLines,
  type TreeFormatOptions,
} from "./tree.ts";

/** Deterministic uuids whose first 8 chars are readable: uuid(1) renders as
 *  "00000001". */
const uuid = (n: number): UUID =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000` as UUID;

function userEntry(
  entryUuid: UUID,
  text: string,
  parentUuid: UUID | null = null,
): SessionEntry {
  return {
    uuid: entryUuid,
    parentUuid,
    type: "user",
    message: { role: "user", content: text },
  };
}

function assistantEntry(
  entryUuid: UUID,
  text: string,
  parentUuid: UUID | null = null,
): SessionEntry {
  return {
    uuid: entryUuid,
    parentUuid,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    },
  };
}

function render(
  input: SessionSnapshot,
  options: Partial<TreeFormatOptions> = {},
): string {
  return formatSessionSnapshot(input, {
    filter: options.filter ?? "conversation",
    width: options.width ?? 120,
  });
}

// --- ordering, geometry ----------------------------------------------------------
// Exact connector geometry is renderdag's (docs/specs/tree-presentation.md);
// these pin its actual output.

test("a fork renders chronologically with the active chain in column 0", () => {
  const input: SessionSnapshot = {
    entries: [
      userEntry(uuid(1), "Start"),
      assistantEntry(uuid(2), "First branch", uuid(1)),
      userEntry(uuid(3), "Second branch", uuid(1)),
      assistantEntry(uuid(4), "active leaf", uuid(3)),
    ],
    leaf: { uuid: uuid(4) },
  };
  assert.equal(
    render(input),
    "❯    00000001 Start\n" +
      "├─╮\n" +
      "│ ●  00000002 First branch\n" +
      "❯  00000003 Second branch\n" +
      "●  00000004 active leaf\n" +
      `[cursor: ${uuid(4)}]\n`,
  );
});

// The leaf rewound to a row with children: the active chain ends there,
// column 0 is reserved below it (terminator + padding), both branches
// move right.
test("a leaf with children keeps column 0 empty below it", () => {
  const input: SessionSnapshot = {
    entries: [
      userEntry(uuid(1), "Start"),
      assistantEntry(uuid(2), "First branch", uuid(1)),
      userEntry(uuid(3), "Second branch", uuid(1)),
      assistantEntry(uuid(4), "active leaf", uuid(3)),
    ],
    leaf: { uuid: uuid(1) },
  };
  assert.equal(
    render(input),
    "❯      00000001 Start\n" +
      "├─┬─╮\n" +
      "│ │ │\n" +
      "~ │ │\n" +
      "  │ │\n" +
      "  ● │  00000002 First branch\n" +
      "    ❯  00000003 Second branch\n" +
      "    ●  00000004 active leaf\n" +
      `[cursor: ${uuid(1)}]\n`,
  );
});

// The active root takes column 0 even when it is not the first root; with
// no leaf, renderdag separates two unconnected one-line rows with a blank
// filler line.
test("multiple roots: the active root is column 0", () => {
  const entries = [
    userEntry(uuid(1), "root one"),
    userEntry(uuid(2), "root two"),
  ];
  assert.equal(
    render({ entries, leaf: { uuid: uuid(2) } }),
    "  ❯  00000001 root one\n" +
      "❯  00000002 root two\n" +
      `[cursor: ${uuid(2)}]\n`,
  );
  assert.equal(
    render({ entries, leaf: null }),
    "❯  00000001 root one\n" + "\n" + "❯  00000002 root two\n[cursor: null]\n",
  );
});

test("a boundary and its summary render off the active path", () => {
  const boundaryUuid = uuid(3);
  const input: SessionSnapshot = {
    entries: [
      userEntry(uuid(1), "Set up the build"),
      assistantEntry(uuid(2), "Build green", uuid(1)),
      userEntry(uuid(4), "Fix the first failure", uuid(2)),
      assistantEntry(uuid(5), "Fixed", uuid(4)),
      {
        uuid: boundaryUuid,
        parentUuid: null,
        logicalParentUuid: uuid(2),
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { preTokens: 42_000 },
      },
      {
        ...userEntry(uuid(6), "Earlier we set up the build", boundaryUuid),
        isCompactSummary: true,
      },
    ],
    leaf: { uuid: uuid(5) },
  };
  assert.equal(
    render(input),
    "❯  00000001 Set up the build\n" +
      "●    00000002 Build green\n" +
      "├─╮\n" +
      "❯ │  00000004 Fix the first failure\n" +
      "● │  00000005 Fixed\n" +
      "  ═  00000003 [compaction: 42k tokens]\n" +
      "  □  00000006 Earlier we set up the build\n" +
      `[cursor: ${uuid(5)}]\n`,
  );
});

// --- boundary linearization ----------------------------------------------------

/** Summary-less from-shape boundary preserving [2] with the leaf on the
 *  relinked occurrence — the hidden-boundary shape. */
function hiddenBoundarySession(): SessionSnapshot {
  const boundaryUuid = uuid(3);
  return {
    entries: [
      userEntry(uuid(1), "Start"),
      assistantEntry(uuid(2), "Reply", uuid(1)),
      {
        uuid: boundaryUuid,
        parentUuid: null,
        logicalParentUuid: uuid(1),
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: {
          preTokens: 1000,
          preservedMessages: { anchorUuid: boundaryUuid, uuids: [uuid(2)] },
        },
      },
    ],
    leaf: { uuid: uuid(2), viaBoundary: boundaryUuid },
  };
}

// A summary-less boundary with no displayed descendants disappears; the
// relinked leaf's chain ends on its representative (the raw row), and the
// tree reads as a plain linear conversation.
test("a hidden boundary's relinked leaf ends the chain on its representative raw row", () => {
  assert.equal(
    render(hiddenBoundarySession()),
    "❯  00000001 Start\n" + "●  00000002 Reply\n" + `[cursor: ${uuid(2)}]\n`,
  );
});

// `raw` mode is buildTree's output verbatim: the raw reply forks off the
// chain, the boundary and its relinked block (marked `~` before the uuid)
// carry the active chain.
test("raw mode shows the boundary block with ~ on relinked rows", () => {
  assert.equal(
    render(hiddenBoundarySession(), { filter: "raw" }),
    "❯    00000001 Start\n" +
      "├─╮\n" +
      "│ ●  00000002 Reply\n" +
      "═  00000003 [compaction: 1k tokens]\n" +
      "●  ~00000002 Reply\n" +
      `[cursor: ${uuid(2)}]\n`,
  );
});

// A filter that hides the representative row ends the chain at its nearest
// visible ancestor; the cursor line is unaffected.
test("a filter-hidden representative row ends the chain at its visible ancestor", () => {
  const output = render(hiddenBoundarySession(), { filter: "user-only" });
  assert.equal(output, "❯  00000001 Start\n" + `[cursor: ${uuid(2)}]\n`);
});

// End-to-end over loadedContext (the get-entries handler's leaf
// composition): a fresh up_to compaction renders linear, the chain ends on
// the summary row (the hidden relinked leaf's visible row), and the cursor
// line keeps the true leaf uuid — chain end and cursor uuid legitimately
// differ.
test("a compacted session renders linear with the chain ending on the summary", () => {
  const start = userEntry(uuid(1), "Start");
  const reply = assistantEntry(uuid(2), "Reply", uuid(1));
  const boundary: SessionEntry = {
    uuid: uuid(3),
    parentUuid: null,
    logicalParentUuid: uuid(2),
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: {
      preTokens: 2000,
      preservedMessages: { anchorUuid: uuid(4), uuids: [uuid(2)] },
    },
  };
  const summary: SessionEntry = {
    ...userEntry(uuid(4), "Earlier: a reply", uuid(3)),
    isCompactSummary: true,
  };
  const failOnInvalid = (message: string): never => {
    throw new Error(`unexpected onInvalid: ${message}`);
  };
  const entries = [start, reply, boundary, summary];
  const input: SessionSnapshot = {
    entries,
    leaf: loadedContext(entries, failOnInvalid).at(-1) ?? null,
  };
  assert.equal(
    render(input, { filter: "all" }),
    "❯  00000001 Start\n" +
      "●  00000002 Reply\n" +
      "═  00000003 [compaction: 2k tokens]\n" +
      "□  00000004 Earlier: a reply\n" +
      `[cursor: ${uuid(2)}]\n`,
  );
});

/** The spec's up_to example: a compaction mid-way through a linear
 *  conversation with a follow-up turn. */
function upToSession(): SessionSnapshot {
  const boundary: SessionEntry = {
    uuid: uuid(6),
    parentUuid: null,
    logicalParentUuid: uuid(2),
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: {
      preTokens: 3000,
      preservedMessages: { anchorUuid: uuid(3), uuids: [uuid(4), uuid(5)] },
    },
  };
  const input: SessionSnapshot = {
    entries: [
      userEntry(uuid(1), "Start"),
      assistantEntry(uuid(2), "First reply", uuid(1)),
      userEntry(uuid(4), "Continue", uuid(2)),
      assistantEntry(uuid(5), "Second reply", uuid(4)),
      boundary,
      {
        ...userEntry(uuid(3), "Earlier: setup", uuid(6)),
        isCompactSummary: true,
      },
      userEntry(uuid(7), "After compaction", uuid(5)),
    ],
    leaf: { uuid: uuid(7) },
  };
  return input;
}

// Display mode: one straight chain, each occurrence exactly once.
test("an up_to compaction with a follow-up turn renders as one linear chain", () => {
  assert.equal(
    render(upToSession()),
    "❯  00000001 Start\n" +
      "●  00000002 First reply\n" +
      "❯  00000004 Continue\n" +
      "●  00000005 Second reply\n" +
      "═  00000006 [compaction: 3k tokens]\n" +
      "□  00000003 Earlier: setup\n" +
      "❯  00000007 After compaction\n" +
      `[cursor: ${uuid(7)}]\n`,
  );
});

// Raw mode (success criterion 6): the relinked block appears right after
// its summary row, connected under it; the file's raw 4 and 5 keep their
// place under 2, ending that column.
test("raw mode shows the up_to block connected under its summary row", () => {
  assert.equal(
    render(upToSession(), { filter: "raw" }),
    "❯  00000001 Start\n" +
      "●    00000002 First reply\n" +
      "├─╮\n" +
      "│ ❯  00000004 Continue\n" +
      "│ ●  00000005 Second reply\n" +
      "═  00000006 [compaction: 3k tokens]\n" +
      "□  00000003 Earlier: setup\n" +
      "❯  ~00000004 Continue\n" +
      "●  ~00000005 Second reply\n" +
      "❯  00000007 After compaction\n" +
      `[cursor: ${uuid(7)}]\n`,
  );
});

// From-shape boundary with a summary: the display forks at the rewind
// target; the summary's single occurrence is raw (the anchor-child rule
// places it under the relinked tail), so no row carries `~` outside raw
// mode (criterion 4).
test("a from-shape summary row renders under the boundary without ~", () => {
  const boundaryUuid = uuid(6);
  const input: SessionSnapshot = {
    entries: [
      userEntry(uuid(1), "Start"),
      assistantEntry(uuid(2), "First reply", uuid(1)),
      userEntry(uuid(4), "Abandoned", uuid(2)),
      assistantEntry(uuid(5), "Abandoned reply", uuid(4)),
      {
        uuid: boundaryUuid,
        parentUuid: null,
        logicalParentUuid: uuid(5),
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: {
          preTokens: 4000,
          preservedMessages: {
            anchorUuid: boundaryUuid,
            uuids: [uuid(1), uuid(2)],
          },
        },
      },
      {
        ...userEntry(uuid(7), "Recap of the abandoned tail", boundaryUuid),
        isCompactSummary: true,
      },
      userEntry(uuid(8), "New direction", uuid(7)),
    ],
    leaf: { uuid: uuid(8) },
  };
  assert.equal(
    render(input),
    "❯  00000001 Start\n" +
      "●    00000002 First reply\n" +
      "├─╮\n" +
      "│ ❯  00000004 Abandoned\n" +
      "│ ●  00000005 Abandoned reply\n" +
      "═  00000006 [compaction: 4k tokens]\n" +
      "□  00000007 Recap of the abandoned tail\n" +
      "❯  00000008 New direction\n" +
      `[cursor: ${uuid(8)}]\n`,
  );
});

// --- filters --------------------------------------------------------------------

function toolSession(): SessionSnapshot {
  const toolUse: SessionEntry = {
    uuid: uuid(2),
    parentUuid: uuid(1),
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: {} }],
      stop_reason: "tool_use",
    },
  };
  const toolResult: SessionEntry = {
    uuid: uuid(3),
    parentUuid: uuid(2),
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01", content: "ok" },
      ],
    },
  };
  return {
    entries: [
      userEntry(uuid(1), "Run a tool"),
      toolUse,
      toolResult,
      assistantEntry(uuid(4), "Done", uuid(3)),
    ],
    leaf: { uuid: uuid(4) },
  };
}

test("conversation and no-tools hide tool traffic and re-attach visible descendants", () => {
  for (const filter of ["conversation", "no-tools"] as const) {
    assert.equal(
      render(toolSession(), { filter }),
      "❯  00000001 Run a tool\n" +
        "●  00000004 Done\n" +
        `[cursor: ${uuid(4)}]\n`,
    );
  }
});

// The leaf exemption keeps the tool call visible; as a leaf with a child
// it gets the reserved column below it.
test("a tool-only assistant that is the current leaf stays visible", () => {
  const input = toolSession();
  input.leaf = { uuid: uuid(2) };
  for (const filter of ["conversation", "no-tools"] as const) {
    assert.equal(
      render(input, { filter }),
      "❯  00000001 Run a tool\n" +
        "▸    00000002 [tool: Bash]\n" +
        "├─╮\n" +
        "│ │\n" +
        "~ │\n" +
        "  │\n" +
        "  ●  00000004 Done\n" +
        `[cursor: ${uuid(2)}]\n`,
    );
  }
});

// The tool_result exemption does not exist under no-tools: the hidden leaf
// ends the chain at its nearest visible ancestor (the user row), which gets
// the reserved column; the cursor line keeps the true leaf.
test("a filter-hidden tool_result leaf ends the chain at its visible ancestor", () => {
  const input = toolSession();
  input.leaf = { uuid: uuid(3) };
  assert.equal(
    render(input, { filter: "no-tools" }),
    "❯    00000001 Run a tool\n" +
      "├─╮\n" +
      "│ │\n" +
      "~ │\n" +
      "  │\n" +
      "  ●  00000004 Done\n" +
      `[cursor: ${uuid(3)}]\n`,
  );
});

test("user-only shows only user entries with text", () => {
  assert.equal(
    render(toolSession(), { filter: "user-only" }),
    "❯  00000001 Run a tool\n" + `[cursor: ${uuid(4)}]\n`,
  );
});

test("all shows every node, with the tool call and result glyphs", () => {
  assert.equal(
    render(toolSession(), { filter: "all" }),
    "❯  00000001 Run a tool\n" +
      "▸  00000002 [tool: Bash]\n" +
      "⤷  00000003 Bash: ok\n" +
      "●  00000004 Done\n" +
      `[cursor: ${uuid(4)}]\n`,
  );
});

test("conversation hides isMeta user entries", () => {
  const input: SessionSnapshot = {
    entries: [
      { ...userEntry(uuid(1), "meta text"), isMeta: true },
      userEntry(uuid(2), "real text", uuid(1)),
    ],
    leaf: { uuid: uuid(2) },
  };
  assert.equal(
    render(input),
    "❯  00000002 real text\n" + `[cursor: ${uuid(2)}]\n`,
  );
});

// --- glyphs and summaries ----------------------------------------------------------

/** Renders a single-entry snapshot under `all` and returns its row minus
 *  the uuid column: "<glyph>  <summary>". */
function summaryOf(entry: SessionEntry): string {
  const output = render(
    { entries: [{ ...entry, uuid: uuid(1) }], leaf: null },
    { filter: "all" },
  );
  return output.split("\n")[0]!.replace("00000001 ", "");
}

test("summary: user text, compact summary, tool results", () => {
  assert.equal(summaryOf(userEntry(uuid(1), "hi\nthere")), "❯  hi there");
  assert.equal(
    summaryOf({ ...userEntry(uuid(1), "recap"), isCompactSummary: true }),
    "□  recap",
  );
  const result = (isError: boolean): SessionEntry => ({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_unknown",
          content: "output",
          ...(isError && { is_error: true }),
        },
      ],
    },
  });
  assert.equal(summaryOf(result(false)), "⤷  tool: ok");
  assert.equal(summaryOf(result(true)), "⤷  tool: error");
});

test("summary: assistant parts, abnormal stop_reason, no content", () => {
  assert.equal(
    summaryOf({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "text", text: "Looking." },
        ],
        stop_reason: "tool_use",
      },
    }),
    "▸  [thinking] [tool: Read] Looking.",
  );
  assert.equal(
    summaryOf({
      type: "assistant",
      message: { role: "assistant", content: [], stop_reason: "refusal" },
    }),
    "●  (refusal)",
  );
  assert.equal(
    summaryOf({
      type: "assistant",
      message: { role: "assistant", content: [] },
    }),
    "●  (no content)",
  );
});

test("summary: boundary token count and generic types", () => {
  assert.equal(
    summaryOf({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 123_456 },
    }),
    "═  [compaction: 123k tokens]",
  );
  assert.equal(
    summaryOf({ type: "system", subtype: "compact_boundary" }),
    "═  [compaction]",
  );
  assert.equal(summaryOf({ type: "attachment" }), "·  attachment");
  assert.equal(
    summaryOf({ type: "system", subtype: "informational" }),
    "·  system: informational",
  );
});

// --- width, edge cases ------------------------------------------------------------

test("width truncates the whole rendered line", () => {
  const input: SessionSnapshot = {
    entries: [userEntry(uuid(1), "a question that runs well past the width")],
    leaf: { uuid: uuid(1) },
  };
  const output = render(input, { width: 24 });
  assert.equal(output.split("\n")[0], "❯  00000001 a question …");
  assert.ok(
    output
      .trimEnd()
      .split("\n")
      .every((line) => [...line].length <= 24 || line.startsWith("[cursor")),
  );
});

test("an empty snapshot renders just the cursor line", () => {
  assert.equal(render({ entries: [], leaf: null }), "[cursor: null]\n");
});

test("a leaf matching no occurrence renders no chain but keeps the cursor", () => {
  const input: SessionSnapshot = {
    entries: [userEntry(uuid(1), "hello")],
    leaf: { uuid: uuid(9) },
  };
  assert.equal(render(input), "❯  00000001 hello\n" + `[cursor: ${uuid(9)}]\n`);
});

test("a duplicated raw uuid renders once, silently (first-wins)", () => {
  // Re-persisted copies are a legal CLI file shape (see
  // docs/derisk/cli-history-repersistence/FINDINGS.md).
  const entry = userEntry(uuid(1), "hello");
  assert.equal(
    render({ entries: [entry, { ...entry }], leaf: null }),
    "❯  00000001 hello\n[cursor: null]\n",
  );
});

// --- picker filter -----------------------------------------------------------

test("picker keeps user text, final assistants with text, boundaries, and the leaf", () => {
  const thinking: SessionEntry = {
    uuid: uuid(2),
    parentUuid: uuid(1),
    type: "assistant",
    message: {
      role: "assistant",
      id: "msg_1",
      content: [{ type: "text", text: "draft" }],
    },
  };
  const final: SessionEntry = {
    uuid: uuid(3),
    parentUuid: uuid(2),
    type: "assistant",
    message: {
      role: "assistant",
      id: "msg_1",
      content: [{ type: "text", text: "answer" }],
    },
  };
  const toolResult: SessionEntry = {
    uuid: uuid(4),
    parentUuid: uuid(3),
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
  };
  const boundary: SessionEntry = {
    uuid: uuid(5),
    parentUuid: uuid(4),
    type: "system",
    subtype: "compact_boundary",
  };
  const input: SessionSnapshot = {
    entries: [userEntry(uuid(1), "ask"), thinking, final, toolResult, boundary],
    leaf: { uuid: uuid(4) },
  };
  const output = render(input, { filter: "picker" });
  // The non-final same-message.id assistant is hidden; the tool_result-only
  // user survives only through the current-leaf exemption.
  assert.ok(!output.includes("00000002"));
  assert.ok(output.includes("00000001"));
  assert.ok(output.includes("00000003"));
  assert.ok(output.includes("00000004"));
  assert.ok(output.includes("00000005"));
});

// --- treeLines (the /tree rendering) ----------------------------------------------

test("treeLines omitUuid drops the uuid column and the ~ marker", () => {
  const boundaryUuid = uuid(2);
  const entries: SessionEntry[] = [
    userEntry(uuid(1), "hello"),
    {
      uuid: boundaryUuid,
      parentUuid: null,
      logicalParentUuid: uuid(1),
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: {
        preservedMessages: { anchorUuid: boundaryUuid, uuids: [uuid(1)] },
      },
    },
  ];
  const byUuid = entriesByUuid(entries);
  const fullTree = buildTree(entries, () => {});
  const toolNames = new Map<string, string>();
  const labels = (omitUuid: boolean): string[] =>
    treeLines(fullTree, byUuid, null, () => true, toolNames, omitUuid)
      .filter((line) => line.rowId !== undefined)
      .map((line) => `${line.glyph} ${line.label}`);
  assert.deepEqual(labels(false), [
    "❯ 00000001 hello",
    "═ 00000002 [compaction]",
    "❯ ~00000001 hello",
  ]);
  // Relinked rows are told apart by rowId (the sink dims the glyph).
  assert.deepEqual(labels(true), ["❯ hello", "═ [compaction]", "❯ hello"]);
});

test("treeLines rejects a row preceding its parent", () => {
  const entries = [
    userEntry(uuid(1), "hello"),
    userEntry(uuid(2), "reply", uuid(1)),
  ];
  const outOfOrder = new Map<string, string | null>([
    [uuid(2), uuid(1)],
    [uuid(1), null],
  ]);
  assert.throws(
    () =>
      treeLines(
        outOfOrder,
        entriesByUuid(entries),
        null,
        () => true,
        new Map(),
        false,
      ),
    /precedes its parent/,
  );
});
