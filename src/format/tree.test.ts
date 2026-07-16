import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type { SessionTree, TreeNode } from "../core/build-tree.ts";
import type { SessionEntry } from "../core/session-file.ts";
import { formatSessionTree, type TreeFormatOptions } from "./tree.ts";

/** Deterministic uuids whose first 8 chars are readable: uuid(1) renders as
 *  "00000001". */
const uuid = (n: number): UUID =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000` as UUID;

function node(
  entry: SessionEntry,
  children: TreeNode[] = [],
  viaBoundary?: UUID,
): TreeNode {
  return {
    entry,
    children,
    ...(viaBoundary !== undefined && { viaBoundary }),
  };
}

function userEntry(entryUuid: UUID, text: string): SessionEntry {
  return {
    uuid: entryUuid,
    type: "user",
    message: { role: "user", content: text },
  };
}

function assistantEntry(entryUuid: UUID, text: string): SessionEntry {
  return {
    uuid: entryUuid,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    },
  };
}

function render(
  input: SessionTree,
  options: Partial<TreeFormatOptions> = {},
): string {
  return formatSessionTree(input, {
    filter: options.filter ?? "conversation",
    width: options.width ?? 120,
  });
}

// --- markers, ordering, geometry ---------------------------------------------

test("branches render with the active branch first and leaf/ancestor markers", () => {
  const leaf = node(assistantEntry(uuid(4), "active leaf"));
  const input: SessionTree = {
    tree: [
      node(userEntry(uuid(1), "Start"), [
        node(assistantEntry(uuid(2), "First branch")),
        node(userEntry(uuid(3), "Second branch"), [leaf]),
      ]),
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

// Pins pictl parity for multi-root forests: virtual-root children render
// flush without connectors (their own descendants indent one extra level).
// Known divergence from pi's TreeSelector, which shifts EVERY node's display
// indent under multiple roots — see the format-tree.md work log.
test("multiple roots render flush under the virtual root", () => {
  const input: SessionTree = {
    tree: [
      node(userEntry(uuid(1), "root one")),
      node(userEntry(uuid(2), "root two")),
    ],
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
  const input: SessionTree = {
    tree: [
      node(userEntry(uuid(1), "Set up the build"), [
        node(assistantEntry(uuid(2), "Build green"), [
          node(userEntry(uuid(4), "Fix the first failure"), [
            node(assistantEntry(uuid(5), "Fixed")),
          ]),
          node(
            {
              uuid: boundaryUuid,
              type: "system",
              subtype: "compact_boundary",
              compactMetadata: { preTokens: 42_000 },
            },
            [
              node({
                ...userEntry(uuid(6), "Earlier we set up the build"),
                isCompactSummary: true,
              }),
            ],
          ),
        ]),
      ]),
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

test("with a duplicated uuid, only the viaBoundary-matching occurrence is the leaf", () => {
  const duplicated = uuid(2);
  const boundaryUuid = uuid(3);
  const input: SessionTree = {
    tree: [
      node(userEntry(uuid(1), "Start"), [
        node(assistantEntry(duplicated, "raw occurrence")),
        node(
          {
            uuid: boundaryUuid,
            type: "system",
            subtype: "compact_boundary",
            compactMetadata: { preTokens: 1000 },
          },
          [
            node(
              assistantEntry(duplicated, "relinked occurrence"),
              [],
              boundaryUuid,
            ),
          ],
        ),
      ]),
    ],
    leaf: { uuid: duplicated, viaBoundary: boundaryUuid },
  };
  assert.equal(
    render(input),
    "• 00000001 user: Start\n" +
      "├─ • 00000003 [compaction: 1k tokens]\n" +
      "│     * 00000002 assistant: relinked occurrence\n" +
      "└─ 00000002 assistant: raw occurrence\n" +
      `[cursor: ${duplicated}]\n`,
  );
});

// --- filters --------------------------------------------------------------------

function toolSession(): SessionTree {
  const toolUse: SessionEntry = {
    uuid: uuid(2),
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: {} }],
      stop_reason: "tool_use",
    },
  };
  const toolResult: SessionEntry = {
    uuid: uuid(3),
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01", content: "ok" },
      ],
    },
  };
  return {
    tree: [
      node(userEntry(uuid(1), "Run a tool"), [
        node(toolUse, [
          node(toolResult, [node(assistantEntry(uuid(4), "Done"))]),
        ]),
      ]),
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
  const input: SessionTree = {
    tree: [
      node({ ...userEntry(uuid(1), "meta text"), isMeta: true }, [
        node(userEntry(uuid(2), "real text")),
      ]),
    ],
    leaf: { uuid: uuid(2) },
  };
  assert.equal(
    render(input),
    "* 00000002 user: real text\n" + `[cursor: ${uuid(2)}]\n`,
  );
});

// --- summaries -------------------------------------------------------------------

/** Renders a single-node tree under `all` and returns the summary part. */
function summaryOf(entry: SessionEntry): string {
  const output = render(
    { tree: [node({ ...entry, uuid: uuid(1) })], leaf: null },
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
  const input: SessionTree = {
    tree: [
      node(userEntry(uuid(1), "a question that runs well past the width")),
    ],
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

test("an empty tree renders just the cursor line", () => {
  assert.equal(render({ tree: [], leaf: null }), "[cursor: null]\n");
});

test("a leaf matching no node renders no markers but keeps the cursor", () => {
  const input: SessionTree = {
    tree: [node(userEntry(uuid(1), "hello"))],
    leaf: { uuid: uuid(9) },
  };
  assert.equal(
    render(input),
    "00000001 user: hello\n" + `[cursor: ${uuid(9)}]\n`,
  );
});
