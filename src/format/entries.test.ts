import assert from "node:assert/strict";
import { test } from "node:test";
import { CanonicalEntryFilter } from "../core/session/entry-stream.ts";
import type { SessionEntry } from "../core/session/file.ts";
import { formatEntryLine, type EntryFormatOptions } from "./entries.ts";
import { decodeFormatInput, type FormatInput } from "./input.ts";
import { trackToolNames } from "../core/session/track-tool-names.ts";

const OPTIONS: EntryFormatOptions = {
  timestamps: false,
  full: false,
  width: 120,
};

const UUID = "7f3f2c9e-93d1-4b8a-b1a2-000000000001";
/** What displayUuid renders for UUID. */
const UUID_DISPLAY = "7f3f2c9e";

function line(
  entry: Record<string, unknown>,
  options: Partial<EntryFormatOptions> = {},
  toolNames: ReadonlyMap<string, string> = new Map(),
): string {
  return formatEntryLine(
    entry as SessionEntry,
    { ...OPTIONS, ...options },
    toolNames,
  );
}

/** `body` padded so `size` ends at the OPTIONS width. */
function withSize(body: string, size: string, width = OPTIONS.width): string {
  return `${body.padEnd(width - size.length - 1)} ${size}`;
}

test("uuid column shows the uuid, type is padded, summary and size follow", () => {
  assert.equal(
    line({
      uuid: UUID,
      type: "user",
      message: { role: "user", content: "Fix the torn-tail bug" },
    }),
    withSize(`${UUID_DISPLAY} user       Fix the torn-tail bug`, "21"),
  );
});

test("uuid-less entries blank-pad the uuid column; a 0 size shows no column", () => {
  const rendered = line({
    type: "queue-operation",
    operation: "enqueue",
    content: "Also update the tests",
  });
  assert.equal(
    rendered,
    `${" ".repeat(8)} queue-operation enqueue: Also update the tests`,
  );
});

test("assistant content renders thinking, tool calls and text", () => {
  assert.equal(
    line({
      uuid: UUID,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "..." },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "text", text: "reading the parser" },
        ],
      },
    }),
    withSize(
      `${UUID_DISPLAY} assistant  [thinking] ... [Read] reading the parser`,
      "21",
    ),
  );
});

test("tool results name their tool once trackToolNames saw the call", () => {
  const call = {
    uuid: UUID,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
    },
  } as SessionEntry;
  const resultEntry = {
    uuid: UUID,
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok!" }],
    },
  };
  const toolNames = new Map<string, string>();
  assert.match(line(resultEntry, {}, toolNames), / user {7}tool: ok +3$/u);
  trackToolNames(call, toolNames);
  assert.match(line(resultEntry, {}, toolNames), / user {7}Read: ok +3$/u);
});

test("bookkeeping types get concise summaries", () => {
  assert.match(
    line({ uuid: UUID, type: "system", subtype: "compact_boundary" }),
    / system {5}\[compaction\] *$/u,
  );
  assert.match(
    line({ uuid: UUID, type: "system", subtype: "local_command" }),
    / system {5}system: local_command *$/u,
  );
  assert.match(
    line({ type: "permission-mode", permissionMode: "plan" }),
    / permission-mode plan *$/u,
  );
  assert.match(line({ type: "mode", mode: "normal" }), / mode {7}normal *$/u);
  assert.match(line({ type: "ai-title", aiTitle: "Testing" }), / Testing *$/u);
  assert.match(
    line({ type: "custom-title", customTitle: "My run" }),
    / My run *$/u,
  );
  assert.match(
    line({ type: "last-prompt", lastPrompt: "What?" }),
    / What\? *$/u,
  );
  assert.match(
    line({ type: "queue-operation", operation: "dequeue" }),
    / queue-operation dequeue *$/u,
  );
  assert.match(
    line({ type: "attachment", attachment: { type: "deferred_tools_delta" } }),
    / attachment deferred_tools_delta: \+0 -0 +31$/u,
  );
  assert.match(
    line({
      type: "file-history-snapshot",
      snapshot: { trackedFileBackups: { "a.ts": {}, "b.ts": {} } },
    }),
    / 2 tracked file backups *$/u,
  );
  assert.match(
    line({ type: "file-history-delta", trackingPath: "src/a.ts" }),
    / src\/a\.ts *$/u,
  );
});

test("unknown types render as their type rather than disappearing", () => {
  assert.match(
    line({ type: "brand-new-type", detail: 7 }),
    / brand-new-type brand-new-type *$/u,
  );
});

test("summaries are one-lined and truncated to the width budget", () => {
  const rendered = line(
    {
      uuid: UUID,
      type: "user",
      message: { role: "user", content: `multi\nline ${"x".repeat(200)}` },
    },
    { width: 80 },
  );
  assert.equal(rendered.length, 80);
  assert.match(rendered, /multi line x+… +211$/u);
});

test("the size column is aligned by code points", () => {
  const rendered = line({
    uuid: UUID,
    type: "user",
    message: { role: "user", content: "😀 hi" },
  });
  assert.equal([...rendered].length, OPTIONS.width);
  assert.match(rendered, /😀 hi +5$/u);
});

test("--timestamps prefixes the entry timestamp", () => {
  const rendered = line(
    {
      uuid: UUID,
      type: "user",
      timestamp: "2026-07-29T00:00:00.000Z",
      message: { role: "user", content: "hi" },
    },
    { timestamps: true },
  );
  assert.equal(
    rendered,
    withSize(`2026-07-29T00:00:00.000Z ${UUID_DISPLAY} user       hi`, "2"),
  );
});

test("--full appends the raw entry JSON", () => {
  const entry = { uuid: UUID, type: "mode", mode: "normal" };
  assert.equal(
    line(entry, { full: true }),
    `${UUID_DISPLAY} mode       normal ${JSON.stringify(entry)}`,
  );
});

async function formatEntriesInput(input: FormatInput): Promise<string> {
  assert.equal(input.kind, "entries");
  if (input.kind !== "entries") {
    return "";
  }
  const filter = new CanonicalEntryFilter();
  const toolNames = new Map<string, string>();
  let output = "";
  for await (const entry of input.records) {
    const accepted = filter.accept(entry);
    if (accepted !== undefined) {
      output += `${formatEntryLine(accepted, OPTIONS, toolNames)}\n`;
      trackToolNames(accepted, toolNames);
    }
  }
  return output;
}

test("get-entries document and raw JSONL of the same session format identically", async () => {
  // Duplicate-heavy: the re-persisted copy must never render.
  const entries = [
    { uuid: UUID, type: "user", message: { role: "user", content: "hi" } },
    { type: "queue-operation", operation: "dequeue" },
    { uuid: UUID, type: "user", message: { role: "user", content: "mutated" } },
    {
      uuid: "7f3f2c9e-93d1-4b8a-b1a2-000000000002",
      type: "assistant",
      message: { role: "assistant", content: [] },
    },
  ];
  const jsonl = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  const document = JSON.stringify({ entries, leaf: { uuid: UUID } }, null, 2);
  const feed = (text: string) =>
    decodeFormatInput(
      (async function* () {
        yield Buffer.from(text);
      })(),
    );
  const fromJsonl = await formatEntriesInput(await feed(jsonl));
  const fromDocument = await formatEntriesInput(await feed(document));
  assert.equal(fromJsonl, fromDocument);
  assert.match(fromJsonl, /hi/u);
  assert.doesNotMatch(fromJsonl, /mutated/u);
});
