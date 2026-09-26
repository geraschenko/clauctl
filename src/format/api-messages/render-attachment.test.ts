import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "../../core/session/file.ts";
import { renderAttachmentEntry } from "./render-attachment.ts";

function attachmentEntry(
  attachment: Record<string, unknown>,
  rendered: unknown = null,
): SessionEntry {
  return {
    type: "attachment",
    attachment,
    rendered,
    uuid: "00000000-0000-4000-8000-000000000001",
    parentUuid: null,
    timestamp: "2026-09-26T10:00:00.000Z",
  };
}

test("a valid rendered snapshot is replayed as persisted, string and text-block items alike", () => {
  const rendering = renderAttachmentEntry(
    attachmentEntry({ type: "total_tokens_reminder", text: "payload" }, [
      { content: "<system-reminder>\nfirst\n</system-reminder>" },
      { content: [{ type: "text", text: "second" }] },
    ]),
  );
  assert.deepEqual(rendering, {
    texts: ["<system-reminder>\nfirst\n</system-reminder>", "second"],
    renderedBy: "snapshot",
  });
});

test("an invalid snapshot (empty, or a non-text block) falls back to the payload text", () => {
  for (const rendered of [[], [{ content: [{ type: "image" }] }]]) {
    assert.deepEqual(
      renderAttachmentEntry(
        attachmentEntry(
          { type: "total_tokens_reminder", text: "payload" },
          rendered,
        ),
      ),
      { texts: ["payload"], renderedBy: "fallback" },
    );
  }
});

test("RENDERS_NOTHING types and a batch-head-rendered queued_command render nothing", () => {
  for (const attachment of [
    { type: "todo_reminder", content: [{ content: "x" }] },
    { type: "thinking_drop" },
    { type: "queued_command", prompt: "p", renderedByBatchHead: true },
  ]) {
    assert.equal(renderAttachmentEntry(attachmentEntry(attachment)), undefined);
  }
});

test("fallback picks the first string field among text/content/prompt/message, else the JSON", () => {
  assert.deepEqual(
    renderAttachmentEntry(attachmentEntry({ type: "mystery", prompt: "p" })),
    { texts: ["p"], renderedBy: "fallback" },
  );
  assert.deepEqual(
    renderAttachmentEntry(attachmentEntry({ type: "mystery", n: 1 })),
    { texts: ['{"type":"mystery","n":1}'], renderedBy: "fallback" },
  );
});

test("deferred_tools_delta is external-state with and without a snapshot", () => {
  const entry = attachmentEntry({
    type: "deferred_tools_delta",
    addedNames: ["a"],
  });
  assert.equal(renderAttachmentEntry(entry)?.renderedBy, "external-state");
  assert.equal(
    renderAttachmentEntry({ ...entry, rendered: [{ content: "snap" }] })
      ?.renderedBy,
    "external-state",
  );
});
