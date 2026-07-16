import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageError } from "../core/generated/util.ts";
import { parseSessionRecords, parseTailRecords } from "./input.ts";

const MESSAGE_LINE = JSON.stringify({
  type: "user",
  message: { role: "user", content: "hi" },
});
const TAIL_LINE = JSON.stringify({ event: { kind: "interruptSent" } });

test("parseSessionRecords accepts message JSONL", () => {
  const records = parseSessionRecords(`${MESSAGE_LINE}\n${MESSAGE_LINE}\n`);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.type, "user");
});

test("parseSessionRecords points tail-shaped input at format events", () => {
  assert.throws(
    () => parseSessionRecords(`${TAIL_LINE}\n`),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes("clauctl format events"),
  );
});

test("a typed entry with a snapshot payload is a session record", () => {
  const line = JSON.stringify({
    type: "file-history-snapshot",
    snapshot: { trackedFileBackups: {} },
  });
  assert.equal(parseSessionRecords(`${line}\n`).length, 1);
});

test("parseSessionRecords rejects records without a type", () => {
  assert.throws(() => parseSessionRecords('{"foo": 1}\n'), UsageError);
});

test("parseTailRecords accepts tail JSONL", () => {
  const records = parseTailRecords(`${TAIL_LINE}\n`);
  assert.equal(records.length, 1);
  assert.ok("event" in records[0]!);
});

test("parseTailRecords points message-shaped input at format messages", () => {
  assert.throws(
    () => parseTailRecords(`${MESSAGE_LINE}\n`),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes("clauctl format messages"),
  );
});

test("parseTailRecords rejects unrecognized records", () => {
  assert.throws(() => parseTailRecords('{"foo": 1}\n'), UsageError);
});

test("parseTailRecords rejects malformed framing", () => {
  assert.throws(() => parseTailRecords('{"snapshot": null}\n'), UsageError);
  assert.throws(
    () => parseTailRecords('{"snapshot": {}, "event": {}}\n'),
    UsageError,
  );
});
