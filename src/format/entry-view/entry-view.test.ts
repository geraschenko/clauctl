import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "../../core/session/file.ts";
import { entryViewFor } from "./entry-view-for.ts";

const WIDTH = 80;
const NO_TOOLS: ReadonlyMap<string, string> = new Map();

/** `<glyph> <summary> <size>` of an entry, the shape every sink derives. */
function viewOf(
  entry: SessionEntry,
  toolNames: ReadonlyMap<string, string> = NO_TOOLS,
): [string, string, number] {
  const view = entryViewFor(entry);
  return [view.glyph, view.summary(entry, toolNames, WIDTH), view.size(entry)];
}

function userEntry(
  content: unknown,
  extra: Record<string, unknown> = {},
): SessionEntry {
  return {
    type: "user",
    version: "2.1.258",
    origin: { kind: "human" },
    message: { role: "user", content },
    ...extra,
  };
}

function assistantEntry(
  content: unknown,
  extra: Record<string, unknown> = {},
): SessionEntry {
  return {
    type: "assistant",
    message: { role: "assistant", content, stop_reason: "end_turn", ...extra },
  };
}

test("compact boundary and compact summary", () => {
  assert.deepEqual(
    viewOf({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 42_000 },
    }),
    ["═", "[compaction: 42k tokens]", 0],
  );
  assert.deepEqual(viewOf({ type: "system", subtype: "compact_boundary" }), [
    "═",
    "[compaction]",
    0,
  ]);
  assert.deepEqual(
    viewOf(
      userEntry("earlier\nwe", { isCompactSummary: true, origin: undefined }),
    ),
    ["□", "earlier we", 10],
  );
});

test("prompts: typed and steered", () => {
  assert.deepEqual(viewOf(userEntry("hi\n there")), ["❯", "hi there", 9]);
  assert.deepEqual(
    viewOf({
      type: "attachment",
      attachment: {
        type: "queued_command",
        prompt: "also\nsay",
        source_uuid: "x",
      },
    }),
    ["❯", "also say", 8],
  );
});

test("attachments: type-prefixed view summary, sized by the wire rendering", () => {
  // A `rendered` snapshot is the size, wrapper included.
  assert.deepEqual(
    viewOf({
      type: "attachment",
      attachment: { type: "file", displayPath: "a.ts" },
      rendered: [{ content: "<system-reminder>\nabc\n</system-reminder>" }],
    }),
    ["⎘", "file: a.ts", 40],
  );
  // Without a snapshot the renderer's fallback guess is the size; an
  // empty view summary leaves the bare type.
  assert.deepEqual(
    viewOf({ type: "attachment", attachment: { type: "date_change" } }),
    ["⎘", "date_change", '{"type":"date_change"}'.length],
  );
  // The CLI renders nothing for this type: never reaches the assistant.
  assert.deepEqual(
    viewOf({
      type: "attachment",
      attachment: { type: "todo_reminder", content: [{ id: 1 }] },
    }),
    ["·", "todo_reminder: 1 item", 0],
  );
});

test("tool results: named through the tool-name map, error glyph, content size", () => {
  const result = (isError: boolean): SessionEntry => ({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "abc" }, { type: "image" }],
          ...(isError && { is_error: true }),
        },
        { type: "tool_result", tool_use_id: "t2", content: "de" },
      ],
    },
  });
  assert.deepEqual(viewOf(result(false)), [
    "⤷",
    "tool: ok",
    3 + '{"type":"image"}'.length + 2,
  ]);
  const toolNames = new Map([["t1", "Read"]]);
  assert.deepEqual(viewOf(result(true), toolNames).slice(0, 2), [
    "✗",
    "Read: error",
  ]);
});

test("user text that is not a prompt", () => {
  assert.deepEqual(
    viewOf(userEntry("<command-name>/x</command-name>", { origin: undefined })),
    ["◌", "<command-name>/x</command-name>", 31],
  );
});

test("assistant: thinking, tool headers, text, stop reason, sizes", () => {
  assert.deepEqual(
    viewOf(
      assistantEntry(
        [
          { type: "thinking", thinking: "hmm\n  hm" },
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { description: "List", command: "ls\n-la", timeout: 5 },
          },
          { type: "text", text: "Looking." },
        ],
        { stop_reason: "tool_use" },
      ),
    ),
    [
      "▸",
      "[thinking] hmm hm [Bash: List — ls -la] Looking.",
      8 + (4 + 6 + 1) + 8,
    ],
  );
  // All-thinking: the CLI drops the message from the wire.
  assert.deepEqual(
    viewOf(assistantEntry([{ type: "thinking", thinking: "" }])),
    ["·", "[thinking]", 0],
  );
  assert.deepEqual(
    viewOf(assistantEntry([{ type: "redacted_thinking", data: "x" }])),
    ["·", "(no content)", 0],
  );
  assert.deepEqual(
    viewOf(
      assistantEntry([
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "" },
      ]),
    ),
    ["●", "[thinking] hm", 2],
  );
  assert.deepEqual(viewOf(assistantEntry([], { stop_reason: "refusal" })), [
    "●",
    "(refusal)",
    0,
  ]);
  assert.deepEqual(viewOf(assistantEntry([])), ["●", "(no content)", 0]);
  // A string content is both the summary and the size.
  assert.deepEqual(viewOf(assistantEntry("plain\ntext")), [
    "●",
    "plain text",
    10,
  ]);
  // Header parts use the tool's display name and the entry's cwd.
  assert.deepEqual(
    viewOf({
      ...assistantEntry([
        {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: { file_path: "/repo/a.ts" },
        },
        {
          type: "tool_use",
          id: "t2",
          name: "WebSearch",
          input: { query: "q" },
        },
        { type: "tool_use", id: "t3", name: "Grep", input: "not a record" },
      ]),
      cwd: "/repo",
    }).slice(0, 2),
    ["▸", '[Read: a.ts] [Web Search: "q"] [Grep]'],
  );
});

test("summaries are bounded by maxChars + 1 per text part", () => {
  const view = entryViewFor(userEntry("x".repeat(1000)));
  assert.equal(
    view.summary(userEntry("x".repeat(1000)), NO_TOOLS, 10).length,
    11,
  );
});

test("other: bookkeeping summaries, else type and subtype", () => {
  assert.deepEqual(viewOf({ type: "mode", mode: "normal" }), [
    "·",
    "normal",
    0,
  ]);
  assert.deepEqual(viewOf({ type: "system", subtype: "local_command" }), [
    "·",
    "system: local_command",
    0,
  ]);
  assert.deepEqual(viewOf({ type: "system" }), ["·", "system", 0]);
  assert.deepEqual(viewOf({ type: "new-type", subtype: "s" }), [
    "·",
    "new-type: s",
    0,
  ]);
  assert.deepEqual(viewOf({}), ["·", "unknown", 0]);
});
