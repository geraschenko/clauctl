/**
 * Cases follow docs/specs/session-tracker.md criterion 6 and the
 * "Structural projection" type design: payload leaves emptied, structure
 * and structural fields untouched, uuid-less entries verbatim.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry } from "./file.ts";
import { structuralEntry } from "./structural.ts";

const text = "payload text";

function assistant(content: unknown): SessionEntry {
  return {
    uuid: randomUUID(),
    type: "assistant",
    message: { role: "assistant", id: "msg_1", content },
  };
}

test("plain-string message content is emptied; usage and model survive", () => {
  const entry: SessionEntry = {
    uuid: randomUUID(),
    type: "user",
    message: { role: "user", content: text, model: "m", usage: { input: 1 } },
  };
  assert.deepEqual(structuralEntry(entry), {
    ...entry,
    message: { role: "user", content: "", model: "m", usage: { input: 1 } },
  });
});

test("content block payload leaves are emptied; block type, id, name and tool_use_id are not", () => {
  const entry = assistant([
    { type: "text", text },
    { type: "thinking", thinking: text, signature: text },
    {
      type: "tool_use",
      id: text,
      name: text,
      input: { command: text, nested: { deeper: [text, 1, null] } },
    },
    { type: "tool_result", tool_use_id: text, content: text },
    {
      type: "tool_result",
      tool_use_id: "t",
      content: [{ type: "text", text }],
    },
    { type: "image", source: { type: "base64", data: text, media_type: text } },
  ]);
  assert.deepEqual(
    (structuralEntry(entry).message as { content: unknown }).content,
    [
      { type: "text", text: "" },
      { type: "thinking", thinking: "", signature: "" },
      {
        type: "tool_use",
        id: text,
        name: text,
        input: { command: "", nested: { deeper: ["", 1, null] } },
      },
      { type: "tool_result", tool_use_id: text, content: "" },
      {
        type: "tool_result",
        tool_use_id: "t",
        content: [{ type: "text", text: "" }],
      },
      { type: "image", source: { type: "base64", data: "", media_type: text } },
    ],
  );
});

test("toolUseResult and attachment are emptied at every depth; other top-level fields are not", () => {
  const entry: SessionEntry = {
    uuid: randomUUID(),
    type: "user",
    cwd: text,
    compactMetadata: { trigger: "manual", preTokens: 1 },
    toolUseResult: { stdout: text, file: { content: text }, list: [text] },
    attachment: { type: "x", content: text },
  };
  assert.deepEqual(structuralEntry(entry), {
    ...entry,
    toolUseResult: { stdout: "", file: { content: "" }, list: [""] },
    attachment: { type: "", content: "" },
  });
});

test("nothing to empty: the same entry object", () => {
  const entry = assistant([{ type: "text", text: "" }]);
  assert.equal(structuralEntry(entry), entry);
});

test("untouched subtrees are shared with the input", () => {
  const untouched = { type: "text", text: "" };
  const entry = assistant([untouched, { type: "text", text }]);
  const content = (structuralEntry(entry).message as { content: unknown[] })
    .content;
  assert.equal(content[0], untouched);
});

test("uuid-less entries are returned unchanged", () => {
  const entry: SessionEntry = { type: "queue-operation", content: text };
  assert.equal(structuralEntry(entry), entry);
});
