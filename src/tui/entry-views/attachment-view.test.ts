import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentViewFor, defaultAttachmentView } from "./attachment-view.ts";
import { oneLinePrefix } from "../../format/generated/text.ts";

const WIDTH = 80;

function summaryOf(type: string, payload: unknown): string {
  return attachmentViewFor(type).summary(payload, WIDTH);
}

function sizeOf(type: string, payload: unknown): number {
  return attachmentViewFor(type).size(payload);
}

test("oneLinePrefix: collapses whitespace and stops at maxChars + 1", () => {
  assert.equal(oneLinePrefix("  a \n\t b  ", 10), "a b");
  assert.equal(oneLinePrefix("abcdef", 3), "abcd");
  assert.equal(oneLinePrefix("ab   cd", 3), "ab c");
  assert.equal(oneLinePrefix("", 5), "");
  assert.equal(oneLinePrefix("   ", 5), "");
});

test("oneLinePrefix: a trailing run is dropped when the input is exhausted, kept when it is the overflow character", () => {
  assert.equal(oneLinePrefix("ab \n ", 5), "ab");
  assert.equal(oneLinePrefix("ab cd", 2), "ab ");
  assert.equal(oneLinePrefix("abc  d", 3), "abc ");
});

test("total_tokens_reminder strips the tags", () => {
  const payload = { text: "<total_tokens>14973970 tokens left</total_tokens>" };
  assert.equal(
    summaryOf("total_tokens_reminder", payload),
    "14973970 tokens left",
  );
  assert.equal(sizeOf("total_tokens_reminder", payload), payload.text.length);
  assert.equal(summaryOf("total_tokens_reminder", {}), "");
});

test("todo/task reminders count items", () => {
  assert.equal(
    summaryOf("todo_reminder", { content: [], itemCount: 0 }),
    "0 items",
  );
  assert.equal(summaryOf("task_reminder", { content: [{ id: 1 }] }), "1 item");
  assert.equal(sizeOf("todo_reminder", { content: [{ id: 1 }] }), 10);
  assert.equal(sizeOf("todo_reminder", {}), 0);
});

test("file-like attachments show the display path and size the text", () => {
  assert.equal(
    summaryOf("file", { filename: "/x/a.ts", displayPath: "a.ts" }),
    "a.ts",
  );
  assert.equal(summaryOf("directory", { path: "/x" }), "/x");
  assert.equal(
    sizeOf("file", { content: { type: "text", file: { content: "abc" } } }),
    3,
  );
  assert.equal(sizeOf("nested_memory", { content: { content: "abcd" } }), 4);
  assert.equal(sizeOf("edited_text_file", { snippet: "ab" }), 2);
  assert.equal(sizeOf("directory", { content: "a\nb" }), 3);
  assert.equal(sizeOf("compact_file_reference", { filename: "/x" }), 0);
});

test("hook_success: event, exit code and first output line", () => {
  assert.equal(
    summaryOf("hook_success", {
      hookEvent: "PostToolUse",
      exitCode: 0,
      stdout: "formatted\nmore",
      stderr: "!",
    }),
    "PostToolUse exit 0: formatted",
  );
  assert.equal(
    summaryOf("hook_success", { hookEvent: "Stop", exitCode: 2, content: "c" }),
    "Stop exit 2: c",
  );
  assert.equal(
    summaryOf("hook_success", { hookEvent: "Stop", exitCode: 0, stdout: "" }),
    "Stop exit 0",
  );
  // The whole composed line is bounded, prefix included.
  assert.equal(
    attachmentViewFor("hook_success").summary(
      { hookEvent: "Stop", exitCode: 0, stdout: "x".repeat(100) },
      10,
    ).length,
    11,
  );
  // The bound is by code points and never leaves a split surrogate pair.
  assert.equal(
    attachmentViewFor("hook_success").summary(
      { hookEvent: "S", exitCode: 0, stdout: "😀".repeat(20) },
      12,
    ),
    "S exit 0: 😀😀😀",
  );
  assert.equal(sizeOf("hook_success", { stdout: "ab", stderr: "c" }), 3);
});

test("date_change, deferred_tools_delta, skill_listing", () => {
  assert.equal(
    summaryOf("date_change", { newDate: "2026-09-23" }),
    "2026-09-23",
  );
  assert.equal(
    sizeOf("date_change", { newDate: "2026-09-23" }),
    '{"newDate":"2026-09-23"}'.length,
  );
  assert.equal(
    summaryOf("deferred_tools_delta", {
      addedNames: ["a", "b"],
      addedLines: ["x", "yz"],
      removedNames: ["c"],
    }),
    "+2 -1",
  );
  assert.equal(sizeOf("deferred_tools_delta", { addedLines: ["x", "yz"] }), 3);
  assert.equal(
    summaryOf("skill_listing", { skillCount: 4, content: "abc" }),
    "4 skills",
  );
  assert.equal(summaryOf("skill_listing", { names: ["a"] }), "1 skill");
  assert.equal(sizeOf("skill_listing", { skillCount: 4, content: "abc" }), 3);
});

test("unknown types take the default view: text, content, else JSON", () => {
  assert.equal(attachmentViewFor("brand_new"), defaultAttachmentView);
  assert.equal(attachmentViewFor("constructor"), defaultAttachmentView);
  assert.equal(summaryOf("brand_new", { text: "t\nx", content: "c" }), "t x");
  assert.equal(summaryOf("brand_new", { content: "c" }), "c");
  assert.equal(summaryOf("brand_new", { n: 1 }), '{"n":1}');
  // Size: string fields by length, the rest by JSON length.
  assert.equal(sizeOf("brand_new", { text: "abc", names: ["a"] }), 3 + 5);
  assert.equal(sizeOf("brand_new", undefined), 0);
});
