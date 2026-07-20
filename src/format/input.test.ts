import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageError } from "../core/generated/util.ts";
import {
  parseSessionEntries,
  parseSessionSnapshot,
  parseTailRecords,
} from "./input.ts";

const MESSAGE_LINE = JSON.stringify({
  type: "user",
  message: { role: "user", content: "hi" },
});
const TAIL_LINE = JSON.stringify({ event: { kind: "interruptSent" } });
// Pretty-printed like real get-entries output, so the first line is just "{".
const SNAPSHOT_DOCUMENT = JSON.stringify(
  {
    entries: [{ uuid: "u1", type: "user" }],
    leaf: { uuid: "u1" },
  },
  null,
  2,
);

test("parseSessionEntries accepts message JSONL", () => {
  const records = parseSessionEntries(`${MESSAGE_LINE}\n${MESSAGE_LINE}\n`);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.type, "user");
});

test("parseSessionEntries points tail-shaped input at format events", () => {
  assert.throws(
    () => parseSessionEntries(`${TAIL_LINE}\n`),
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
  assert.equal(parseSessionEntries(`${line}\n`).length, 1);
});

test("parseSessionEntries rejects records without a type", () => {
  assert.throws(() => parseSessionEntries('{"foo": 1}\n'), UsageError);
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

test("parseSessionSnapshot accepts a pretty-printed snapshot document", () => {
  const snapshot = parseSessionSnapshot(SNAPSHOT_DOCUMENT);
  assert.equal(snapshot.entries.length, 1);
  assert.deepEqual(snapshot.leaf, { uuid: "u1" });
  assert.equal(
    parseSessionSnapshot('{"entries": [], "leaf": null}').leaf,
    null,
  );
});

test("parseSessionSnapshot validates the leaf and entry shapes", () => {
  assert.throws(() => parseSessionSnapshot('{"entries": []}'), UsageError);
  assert.throws(
    () => parseSessionSnapshot('{"entries": [], "leaf": 3}'),
    UsageError,
  );
  assert.throws(
    () => parseSessionSnapshot('{"entries": [], "leaf": {"viaBoundary": "b"}}'),
    UsageError,
  );
  assert.throws(
    () => parseSessionSnapshot('{"entries": [{"foo": 1}], "leaf": null}'),
    UsageError,
  );
});

test("parseSessionSnapshot derives the leaf from raw session JSONL", () => {
  const user = JSON.stringify({
    uuid: "00000001-0000-4000-8000-000000000000",
    parentUuid: null,
    type: "user",
    message: { role: "user", content: "hi" },
  });
  const assistant = JSON.stringify({
    uuid: "00000002-0000-4000-8000-000000000000",
    parentUuid: "00000001-0000-4000-8000-000000000000",
    type: "assistant",
    message: { role: "assistant", content: [] },
  });
  const snapshot = parseSessionSnapshot(`${user}\n${assistant}\n`);
  assert.equal(snapshot.entries.length, 2);
  assert.deepEqual(snapshot.leaf, {
    uuid: "00000002-0000-4000-8000-000000000000",
  });
});

test("parseSessionSnapshot points the other shapes at their subcommands", () => {
  assert.throws(
    () => parseSessionSnapshot(`${TAIL_LINE}\n`),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes("clauctl format events"),
  );
  assert.throws(() => parseSessionSnapshot("not json"), UsageError);
  // Old get-tree documents get the generic error, not a special case.
  assert.throws(
    () => parseSessionSnapshot('{"tree": [], "leaf": null}'),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes("not a session snapshot"),
  );
});

test("parseSessionEntries and parseTailRecords point snapshot input at format tree", () => {
  for (const parse of [parseSessionEntries, parseTailRecords]) {
    assert.throws(
      () => parse(SNAPSHOT_DOCUMENT),
      (error: unknown) =>
        error instanceof UsageError &&
        error.message.includes("clauctl format tree"),
    );
  }
});
