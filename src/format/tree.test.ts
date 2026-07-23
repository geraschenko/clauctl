import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import { buildTree } from "../core/tree/build-tree.ts";
import { parseTreeNodeRef, type SessionSnapshot } from "../core/tree/nodes.ts";
import { loadedContext } from "../core/tree/loader.ts";
import { entriesByUuid, type SessionEntry } from "../core/session-file.ts";
import {
  formatSessionSnapshot,
  formatTreeNodeLine,
  type TreeFormatOptions,
} from "./tree.ts";
import { toLayoutTree } from "./generated/flat-tree.ts";
import { flattenVisibleTree } from "./generated/tree-layout.ts";

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

// --- markers, ordering, geometry ---------------------------------------------

test("branches render with the active branch first and leaf/ancestor markers", () => {
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
    "• 00000001 user: Start\n" +
      "├─ • 00000003 user: Second branch\n" +
      "│     * 00000004 assistant: active leaf\n" +
      "└─ 00000002 assistant: First branch\n" +
      `[cursor: ${uuid(4)}]\n`,
  );
});

// Pins pictl parity for multi-root sessions: virtual-root children render
// flush without connectors (their own descendants indent one extra level).
// Known divergence from pi's TreeSelector, which shifts EVERY node's display
// indent under multiple roots — see the format-tree.md work log.
test("multiple roots render flush under the virtual root", () => {
  const input: SessionSnapshot = {
    entries: [userEntry(uuid(1), "root one"), userEntry(uuid(2), "root two")],
    leaf: { uuid: uuid(2) },
  };
  assert.equal(
    render(input),
    "* 00000002 user: root two\n" +
      "00000001 user: root one\n" +
      `[cursor: ${uuid(2)}]\n`,
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
    "• 00000001 user: Set up the build\n" +
      "• 00000002 assistant: Build green\n" +
      "├─ • 00000004 user: Fix the first failure\n" +
      "│     * 00000005 assistant: Fixed\n" +
      "└─ 00000003 [compaction: 42k tokens]\n" +
      "      00000006 compaction: Earlier we set up the build\n" +
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
// relinked leaf's marker lands on its representative (the raw row), and the
// tree reads as a plain linear conversation.
test("a hidden boundary's relinked leaf marks its representative raw row", () => {
  assert.equal(
    render(hiddenBoundarySession()),
    "• 00000001 user: Start\n" +
      "* 00000002 assistant: Reply\n" +
      `[cursor: ${uuid(2)}]\n`,
  );
});

// `raw` mode is buildTree's output verbatim: the boundary block forks off
// the raw chain and the relinked occurrence renders as its own row, marked
// `~` immediately before the uuid column.
test("raw mode shows the boundary block with ~ on relinked rows", () => {
  assert.equal(
    render(hiddenBoundarySession(), { filter: "raw" }),
    "• 00000001 user: Start\n" +
      "├─ • 00000003 [compaction: 1k tokens]\n" +
      "│     * ~00000002 assistant: Reply\n" +
      "└─ 00000002 assistant: Reply\n" +
      `[cursor: ${uuid(2)}]\n`,
  );
});

// A filter that hides the representative row leaves the marker absent,
// matching existing filtered-leaf behavior; the cursor line is unaffected.
test("a filter-hidden representative row drops the marker", () => {
  const output = render(hiddenBoundarySession(), { filter: "user-only" });
  assert.equal(output, "• 00000001 user: Start\n" + `[cursor: ${uuid(2)}]\n`);
});

// End-to-end over loadedContext (the get-entries handler's leaf
// composition): a fresh up_to compaction renders linear, the `*` lands on
// the summary row (the hidden relinked leaf's visible row), and the
// cursor line keeps the true leaf uuid — marker row and cursor uuid
// legitimately differ.
test("a compacted session renders linear with the leaf marker on the summary", () => {
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
    "• 00000001 user: Start\n" +
      "• 00000002 assistant: Reply\n" +
      "• 00000003 [compaction: 2k tokens]\n" +
      "* 00000004 compaction: Earlier: a reply\n" +
      `[cursor: ${uuid(2)}]\n`,
  );
});

// The spec's up_to example (success criterion 1): a compaction mid-way
// through a linear conversation with a follow-up turn renders as one
// straight chain, each occurrence exactly once.
test("an up_to compaction with a follow-up turn renders as one linear chain", () => {
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
  assert.equal(
    render(input),
    "• 00000001 user: Start\n" +
      "• 00000002 assistant: First reply\n" +
      "• 00000004 user: Continue\n" +
      "• 00000005 assistant: Second reply\n" +
      "• 00000006 [compaction: 3k tokens]\n" +
      "• 00000003 compaction: Earlier: setup\n" +
      "* 00000007 user: After compaction\n" +
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
    "• 00000001 user: Start\n" +
      "• 00000002 assistant: First reply\n" +
      "├─ • 00000006 [compaction: 4k tokens]\n" +
      "│     • 00000007 compaction: Recap of the abandoned tail\n" +
      "│     * 00000008 user: New direction\n" +
      "└─ 00000004 user: Abandoned\n" +
      "      00000005 assistant: Abandoned reply\n" +
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

test("conversation hides tool traffic and re-attaches visible descendants", () => {
  assert.equal(
    render(toolSession()),
    "• 00000001 user: Run a tool\n" +
      "* 00000004 assistant: Done\n" +
      `[cursor: ${uuid(4)}]\n`,
  );
});

test("no-tools hides tool-only assistant and tool_result-only user entries", () => {
  assert.equal(
    render(toolSession(), { filter: "no-tools" }),
    "• 00000001 user: Run a tool\n" +
      "* 00000004 assistant: Done\n" +
      `[cursor: ${uuid(4)}]\n`,
  );
});

test("a tool-only assistant that is the current leaf stays visible", () => {
  const input = toolSession();
  input.leaf = { uuid: uuid(2) };
  for (const filter of ["conversation", "no-tools"] as const) {
    const lines = render(input, { filter }).split("\n");
    assert.equal(lines[1], "* 00000002 assistant: [tool: Bash]");
  }
});

test("a tool_result leaf stays hidden and the marker simply does not appear", () => {
  const input = toolSession();
  input.leaf = { uuid: uuid(3) };
  const lines = render(input, { filter: "no-tools" }).trimEnd().split("\n");
  const treeLines = lines.slice(0, -1);
  assert.ok(treeLines.every((line) => !line.includes("00000003")));
  assert.ok(treeLines.every((line) => !line.includes("*")));
  assert.equal(lines.at(-1), `[cursor: ${uuid(3)}]`);
});

test("user-only shows only user entries with text", () => {
  // The hidden leaf's ancestry stays marked: the active path is computed
  // over the full tree before filtering (pictl parity).
  assert.equal(
    render(toolSession(), { filter: "user-only" }),
    "• 00000001 user: Run a tool\n" + `[cursor: ${uuid(4)}]\n`,
  );
});

test("all shows every node", () => {
  assert.equal(
    render(toolSession(), { filter: "all" }),
    "• 00000001 user: Run a tool\n" +
      "• 00000002 assistant: [tool: Bash]\n" +
      "• 00000003 Bash: ok\n" +
      "* 00000004 assistant: Done\n" +
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
    "* 00000002 user: real text\n" + `[cursor: ${uuid(2)}]\n`,
  );
});

// --- summaries -------------------------------------------------------------------

/** Renders a single-entry snapshot under `all` and returns the summary part. */
function summaryOf(entry: SessionEntry): string {
  const output = render(
    { entries: [{ ...entry, uuid: uuid(1) }], leaf: null },
    { filter: "all" },
  );
  return output.split("\n")[0]!.replace("00000001 ", "");
}

test("summary: user text, compact summary, tool results", () => {
  assert.equal(summaryOf(userEntry(uuid(1), "hi\nthere")), "user: hi there");
  assert.equal(
    summaryOf({ ...userEntry(uuid(1), "recap"), isCompactSummary: true }),
    "compaction: recap",
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
  assert.equal(summaryOf(result(false)), "tool: ok");
  assert.equal(summaryOf(result(true)), "tool: error");
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
    "assistant: [thinking] [tool: Read] Looking.",
  );
  assert.equal(
    summaryOf({
      type: "assistant",
      message: { role: "assistant", content: [], stop_reason: "refusal" },
    }),
    "assistant: (refusal)",
  );
  assert.equal(
    summaryOf({
      type: "assistant",
      message: { role: "assistant", content: [] },
    }),
    "assistant: (no content)",
  );
});

test("summary: boundary token count and generic types", () => {
  assert.equal(
    summaryOf({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 123_456 },
    }),
    "[compaction: 123k tokens]",
  );
  assert.equal(
    summaryOf({ type: "system", subtype: "compact_boundary" }),
    "[compaction]",
  );
  assert.equal(summaryOf({ type: "attachment" }), "attachment");
  assert.equal(
    summaryOf({ type: "system", subtype: "informational" }),
    "system: informational",
  );
});

// --- width, edge cases ------------------------------------------------------------

test("width truncates the whole rendered line", () => {
  const input: SessionSnapshot = {
    entries: [userEntry(uuid(1), "a question that runs well past the width")],
    leaf: { uuid: uuid(1) },
  };
  const output = render(input, { width: 24 });
  assert.equal(output.split("\n")[0], "* 00000001 user: a ques…");
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

test("a leaf matching no occurrence renders no markers but keeps the cursor", () => {
  const input: SessionSnapshot = {
    entries: [userEntry(uuid(1), "hello")],
    leaf: { uuid: uuid(9) },
  };
  assert.equal(
    render(input),
    "00000001 user: hello\n" + `[cursor: ${uuid(9)}]\n`,
  );
});

test("a duplicated raw uuid renders once, silently (first-wins)", () => {
  // Re-persisted copies are a legal CLI file shape (see
  // docs/derisk/cli-history-repersistence/FINDINGS.md).
  const entry = userEntry(uuid(1), "hello");
  assert.equal(
    render({ entries: [entry, { ...entry }], leaf: null }),
    "00000001 user: hello\n[cursor: null]\n",
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

test("formatTreeNodeLine omitUuid drops the uuid column", () => {
  const entries = [userEntry(uuid(1), "hello there")];
  const entryOf = entriesByUuid(entries);
  const roots = toLayoutTree(
    buildTree(entries, () => {}),
    (id) => entryOf.get(parseTreeNodeRef(id).uuid)!,
  );
  const flat = flattenVisibleTree(roots, uuid(1), () => true);
  const toolNames = new Map<string, string>();
  assert.equal(
    formatTreeNodeLine(flat[0]!, toolNames, 80),
    "* 00000001 user: hello there",
  );
  assert.equal(
    formatTreeNodeLine(flat[0]!, toolNames, 80, true),
    "* user: hello there",
  );
});

// Rule 8's uuid-omitted half: on picker-style rows the `~` sits immediately
// before the summary text.
test("formatTreeNodeLine marks relinked rows with ~ before the summary when the uuid is omitted", () => {
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
  const entryOf = entriesByUuid(entries);
  const roots = toLayoutTree(
    buildTree(entries, () => {}),
    (id) => entryOf.get(parseTreeNodeRef(id).uuid)!,
  );
  const flat = flattenVisibleTree(roots, null, () => true);
  const relinkedRow = flat.find(
    (node) => parseTreeNodeRef(node.node.id).viaBoundary !== undefined,
  )!;
  const toolNames = new Map<string, string>();
  assert.equal(
    formatTreeNodeLine(relinkedRow, toolNames, 80),
    "~00000001 user: hello",
  );
  assert.equal(
    formatTreeNodeLine(relinkedRow, toolNames, 80, true),
    "~user: hello",
  );
});
