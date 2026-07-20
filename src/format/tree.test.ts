import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import { buildTree } from "../core/build-tree.ts";
import type { SessionSnapshot } from "../core/tree.ts";
import { effectiveTreeNodeChain } from "../core/effective-chain.ts";
import { entriesByUuid, type SessionEntry } from "../core/session-file.ts";
import {
  formatSessionSnapshot,
  formatTreeNodeLine,
  toLayoutTree,
  type TreeFormatOptions,
} from "./tree.ts";
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

// --- occurrence identity -------------------------------------------------------

// The relinked occurrence duplicates the raw entry's uuid; only the
// viaBoundary-matching occurrence carries the leaf marker (both embed the
// same entry, so both render the same summary).
test("with a duplicated uuid, only the viaBoundary-matching occurrence is the leaf", () => {
  const boundaryUuid = uuid(3);
  const input: SessionSnapshot = {
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
  assert.equal(
    render(input),
    "• 00000001 user: Start\n" +
      "├─ • 00000003 [compaction: 1k tokens]\n" +
      "│     * 00000002 assistant: Reply\n" +
      "└─ 00000002 assistant: Reply\n" +
      `[cursor: ${uuid(2)}]\n`,
  );
});

// End-to-end over effectiveTreeNodeChain (the get-entries handler's leaf
// composition): the boundary substructure renders, the `*` lands on the
// relinked node — distinguished from its raw duplicate — and the layout's
// unique-id precondition holds.
test("a compacted session renders with the leaf on the relinked node", () => {
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
    leaf: effectiveTreeNodeChain(entries, failOnInvalid).at(-1) ?? null,
  };
  assert.equal(
    render(input, { filter: "all" }),
    "• 00000001 user: Start\n" +
      "• 00000002 assistant: Reply\n" +
      "• 00000003 [compaction: 2k tokens]\n" +
      "• 00000004 compaction: Earlier: a reply\n" +
      "* 00000002 assistant: Reply\n" +
      `[cursor: ${uuid(2)}]\n`,
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

test("a duplicated raw uuid fails loudly", () => {
  const entry = userEntry(uuid(1), "hello");
  assert.throws(
    () => render({ entries: [entry, { ...entry }], leaf: null }),
    /duplicate occurrence .* corrupt/,
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
  const roots = toLayoutTree(
    buildTree(entries, () => {}),
    entriesByUuid(entries),
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
