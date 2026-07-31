import assert from "node:assert/strict";
import { test } from "node:test";
import { CanonicalEntryFilter } from "../core/session/entry-stream.ts";
import type { SessionEntry } from "../core/session/file.ts";
import { formatEntryLine, type EntryFormatOptions } from "./entries.ts";
import { decodeFormatInput, type FormatInput } from "./input.ts";

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
): string {
  return formatEntryLine(entry as SessionEntry, { ...OPTIONS, ...options });
}

test("uuid column shows the uuid, type is padded, summary follows", () => {
  assert.equal(
    line({
      uuid: UUID,
      type: "user",
      message: { role: "user", content: "Fix the torn-tail bug" },
    }),
    `${UUID_DISPLAY} user       Fix the torn-tail bug`,
  );
});

test("uuid-less entries blank-pad the uuid column", () => {
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

test("assistant content renders markers and text", () => {
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
    `${UUID_DISPLAY} assistant  [thinking] [tool:Read] reading the parser`,
  );
});

test("bookkeeping types get concise summaries", () => {
  assert.match(
    line({ uuid: UUID, type: "system", subtype: "compact_boundary" }),
    / system {5}compact_boundary$/u,
  );
  assert.match(
    line({ type: "permission-mode", permissionMode: "plan" }),
    / permission-mode plan$/u,
  );
  assert.match(line({ type: "mode", mode: "normal" }), / mode {7}normal$/u);
  assert.match(line({ type: "ai-title", aiTitle: "Testing" }), / Testing$/u);
  assert.match(
    line({ type: "custom-title", customTitle: "My run" }),
    / My run$/u,
  );
  assert.match(line({ type: "last-prompt", lastPrompt: "What?" }), / What\?$/u);
  assert.match(
    line({ type: "queue-operation", operation: "dequeue" }),
    / queue-operation dequeue$/u,
  );
  assert.match(
    line({ type: "attachment", attachment: { type: "deferred_tools_delta" } }),
    / attachment deferred_tools_delta$/u,
  );
  assert.match(
    line({
      type: "file-history-snapshot",
      snapshot: { trackedFileBackups: { "a.ts": {}, "b.ts": {} } },
    }),
    / 2 tracked file backups$/u,
  );
  assert.match(
    line({ type: "file-history-delta", trackingPath: "src/a.ts" }),
    / src\/a\.ts$/u,
  );
});

test("unknown types degrade to a generic summary rather than disappearing", () => {
  const rendered = line({ type: "brand-new-type", detail: 7 });
  assert.match(rendered, /brand-new-type/u);
  assert.match(rendered, /"detail":7/u);
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
  assert.match(rendered, /multi line x+…$/u);
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
    `2026-07-29T00:00:00.000Z ${UUID_DISPLAY} user       hi`,
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
  let output = "";
  for await (const entry of input.records) {
    const accepted = filter.accept(entry);
    if (accepted !== undefined) {
      output += `${formatEntryLine(accepted, OPTIONS)}\n`;
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
