import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry } from "./file.ts";
import { MessageProjector, type MessageRecord } from "./messages.ts";

const uuid = (): UUID => randomUUID();

function entry(fields: Record<string, unknown>): SessionEntry {
  return fields as SessionEntry;
}

function assistant(model: string): SessionEntry {
  return entry({
    uuid: uuid(),
    type: "assistant",
    sessionId: uuid(),
    message: { role: "assistant", model, content: [], stop_reason: null },
  });
}

function project(entries: SessionEntry[]): MessageRecord[] {
  const projector = new MessageProjector();
  return entries.flatMap((item) => projector.push(item));
}

test("user and assistant entries project to their SDK messages", () => {
  const user = entry({
    uuid: uuid(),
    type: "user",
    sessionId: uuid(),
    message: { role: "user", content: "hi" },
    timestamp: "2026-07-29T00:00:00.000Z",
  });
  const records = project([user, assistant("claude-fable-5")]);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.type, "user");
  assert.equal(records[1]!.type, "assistant");
});

test("model change emits a control only on an actual change", () => {
  const records = project([
    assistant("claude-fable-5"),
    assistant("claude-fable-5"),
    assistant("claude-opus-4-8"),
  ]);
  const controls = records.filter((record) => record.type === "control");
  assert.deepEqual(
    controls.map((record) => record.control),
    [{ kind: "model_changed", from: "claude-fable-5", to: "claude-opus-4-8" }],
  );
  // The control precedes its message.
  assert.equal(records[2]!.type, "control");
  assert.equal(records[3]!.type, "assistant");
});

test("permission-mode first sighting is silent, change emits a control", () => {
  const mode = (permissionMode: string) =>
    entry({ type: "permission-mode", permissionMode });
  const records = project([mode("auto"), mode("auto"), mode("plan")]);
  assert.deepEqual(records, [
    {
      type: "control",
      control: {
        kind: "permission_mode_changed",
        from: "auto",
        to: "plan",
      },
    },
  ]);
});

test("compact_boundary projects a compaction control with uuid and metadata", () => {
  const boundaryUuid = uuid();
  const records = project([
    entry({
      uuid: boundaryUuid,
      type: "system",
      subtype: "compact_boundary",
      timestamp: "2026-07-29T00:00:00.000Z",
      compactMetadata: { trigger: "manual", preTokens: 12345 },
    }),
  ]);
  assert.deepEqual(records, [
    {
      type: "control",
      control: { kind: "compaction", trigger: "manual", preTokens: 12345 },
      uuid: boundaryUuid,
      timestamp: "2026-07-29T00:00:00.000Z",
    },
  ]);
});

test("malformed compactMetadata still emits the boundary fact", () => {
  const records = project([
    entry({
      uuid: uuid(),
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { trigger: 7, preTokens: "many" },
    }),
  ]);
  assert.equal(records.length, 1);
  assert.deepEqual((records[0] as { control: unknown }).control, {
    kind: "compaction",
  });
});

test("queue-operation enqueue projects queued input, dequeue is silent", () => {
  const records = project([
    entry({
      type: "queue-operation",
      operation: "enqueue",
      content: "Also update the tests",
    }),
    entry({ type: "queue-operation", operation: "dequeue" }),
  ]);
  assert.deepEqual(records, [
    {
      type: "control",
      control: { kind: "queued_input", text: "Also update the tests" },
    },
  ]);
});

test("unprojected entry kinds return no records", () => {
  const silent = [
    entry({ type: "system", subtype: "init" }),
    entry({ type: "attachment", attachment: {} }),
    entry({ type: "mode", mode: "default" }),
    entry({ type: "file-history-snapshot", snapshot: {} }),
    entry({ uuid: uuid(), type: "user", isMeta: true, message: {} }),
    entry({ uuid: uuid(), type: "assistant", isSidechain: true, message: {} }),
    entry({ type: "user", message: { role: "user", content: "no uuid" } }),
  ];
  assert.deepEqual(project(silent), []);
});
