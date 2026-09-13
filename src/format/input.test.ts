import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageError } from "../core/generated/util.ts";
import {
  decodeFormatInput,
  parseSnapshotDocument,
  type FormatInput,
} from "./input.ts";

const ENTRY_LINE = JSON.stringify({
  type: "user",
  message: { role: "user", content: "hi" },
});
const MESSAGE_LINE = JSON.stringify({
  type: "user",
  uuid: "00000001-0000-4000-8000-000000000000",
  session_id: "s1",
  message: { role: "user", content: "hi" },
  parent_tool_use_id: null,
  parent_agent_id: null,
});
const CONTROL_LINE = JSON.stringify({
  type: "control",
  control: { kind: "model_changed", from: "a", to: "b" },
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

function chunksOf(...pieces: string[]): AsyncIterable<Buffer> {
  return (async function* () {
    for (const piece of pieces) {
      yield Buffer.from(piece);
    }
  })();
}

async function decode(...pieces: string[]): Promise<FormatInput> {
  return await decodeFormatInput(chunksOf(...pieces));
}

async function collect(input: FormatInput): Promise<unknown[]> {
  assert.notEqual(input.kind, "empty");
  const records: unknown[] = [];
  if (input.kind !== "empty") {
    for await (const record of input.records) {
      records.push(record);
    }
  }
  return records;
}

test("session-entry JSONL classifies as entries", async () => {
  const input = await decode(`${ENTRY_LINE}\n${ENTRY_LINE}\n`);
  assert.equal(input.kind, "entries");
  const records = await collect(input);
  assert.equal(records.length, 2);
  assert.equal((records[0] as { type: string }).type, "user");
});

test("an entry carrying snake_case session_id is still a session entry", async () => {
  // Real transcripts contain user/assistant entries with BOTH `sessionId`
  // and `session_id`; only parent_tool_use_id marks a canonical message.
  const line = JSON.stringify({
    type: "assistant",
    uuid: "00000001-0000-4000-8000-000000000000",
    parentUuid: null,
    sessionId: "s1",
    session_id: "s1",
    message: { role: "assistant", content: [] },
  });
  const input = await decode(`${line}\n`);
  assert.equal(input.kind, "entries");
});

test("a typed entry with a snapshot payload is a session entry", async () => {
  const line = JSON.stringify({
    type: "file-history-snapshot",
    snapshot: { trackedFileBackups: {} },
  });
  const input = await decode(`${line}\n`);
  assert.equal(input.kind, "entries");
  assert.equal((await collect(input)).length, 1);
});

test("canonical message JSONL classifies as messages", async () => {
  const input = await decode(`${MESSAGE_LINE}\n${CONTROL_LINE}\n`);
  assert.equal(input.kind, "messages");
  const records = await collect(input);
  assert.equal(records.length, 2);
  assert.equal((records[1] as { type: string }).type, "control");
});

test("a leading control record classifies as messages", async () => {
  const input = await decode(`${CONTROL_LINE}\n`);
  assert.equal(input.kind, "messages");
});

test("tail JSONL classifies as events", async () => {
  const input = await decode(`${TAIL_LINE}\n`);
  assert.equal(input.kind, "events");
  const records = await collect(input);
  assert.ok("event" in (records[0] as object));
});

test("malformed tail framing is rejected", async () => {
  await assert.rejects(decode('{"snapshot": null}\n'), UsageError);
  await assert.rejects(decode('{"snapshot": {}, "event": {}}\n'), UsageError);
});

test("empty and blank-only input classify as empty", async () => {
  assert.equal((await decode("")).kind, "empty");
  assert.equal((await decode("\n \n\n")).kind, "empty");
});

test("a torn final line with no complete record is not a record", async () => {
  assert.equal((await decode('{"type":"user"')).kind, "empty");
});

test("the get-entries document classifies as entries", async () => {
  for (const text of [
    SNAPSHOT_DOCUMENT,
    `${SNAPSHOT_DOCUMENT}\n`,
    // Minified: parses as one JSONL record but is snapshot-shaped.
    '{"entries":[{"uuid":"u1","type":"user"}],"leaf":null}\n',
  ]) {
    const input = await decode(text);
    assert.equal(input.kind, "entries");
    const records = await collect(input);
    assert.equal(records.length, 1);
    assert.equal((records[0] as { type: string }).type, "user");
  }
});

test("document entries are validated", async () => {
  await assert.rejects(
    decode('{"entries": [{"foo": 1}], "leaf": null}'),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes("entries[0] is not a session entry"),
  );
});

test("an unparseable non-document fails with the JSONL line error", async () => {
  await assert.rejects(
    decode("not json\n"),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes("invalid JSONL line 1"),
  );
});

test("an unrecognized first record is rejected", async () => {
  await assert.rejects(
    decode('{"foo": 1}\n'),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes("record 1 is not recognized"),
  );
  await assert.rejects(decode("[1,2]\n"), UsageError);
});

test("a mid-stream record of the wrong shape names its line number", async () => {
  const input = await decode(`${ENTRY_LINE}\n\n${TAIL_LINE}\n`);
  assert.equal(input.kind, "entries");
  // Line 3 in the file: the blank line is counted.
  await assert.rejects(
    collect(input),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes(
        "record 3 looks like tail output; use `clauctl format events`",
      ),
  );
  const messages = await decode(`${TAIL_LINE}\n${ENTRY_LINE}\n`);
  assert.equal(messages.kind, "events");
  await assert.rejects(
    collect(messages),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes(
        "record 2 looks like session-entry output; use `clauctl format messages`",
      ),
  );
});

test("records split across chunks are reassembled", async () => {
  const text = `${ENTRY_LINE}\n${ENTRY_LINE}\n`;
  const input = await decode(
    text.slice(0, 10),
    text.slice(10, 50),
    text.slice(50),
  );
  assert.equal(input.kind, "entries");
  assert.equal((await collect(input)).length, 2);
});

test("classification and iteration pull chunks lazily", async () => {
  let pulls = 0;
  const chunks = (async function* () {
    for (const piece of [`${ENTRY_LINE}\n`, `${ENTRY_LINE}\n`]) {
      pulls += 1;
      yield Buffer.from(piece);
    }
  })();
  const input = await decodeFormatInput(chunks);
  assert.equal(input.kind, "entries");
  assert.equal(pulls, 1);
  assert.notEqual(input.kind, "empty");
  if (input.kind === "entries") {
    const iterator = input.records[Symbol.asyncIterator]();
    await iterator.next();
    // The first record was classified without touching the second chunk.
    assert.equal(pulls, 1);
    await iterator.next();
    assert.equal(pulls, 2);
  }
});

test("parseSessionSnapshot accepts a pretty-printed snapshot document", () => {
  const snapshot = parseSnapshotDocument(SNAPSHOT_DOCUMENT);
  assert.equal(snapshot.entries.length, 1);
  assert.deepEqual(snapshot.leaf, { uuid: "u1" });
  assert.equal(
    parseSnapshotDocument('{"entries": [], "leaf": null}').leaf,
    null,
  );
});

test("parseSessionSnapshot validates the leaf and entry shapes", () => {
  assert.throws(() => parseSnapshotDocument('{"entries": []}'), UsageError);
  assert.throws(
    () => parseSnapshotDocument('{"entries": [], "leaf": 3}'),
    UsageError,
  );
  assert.throws(
    () =>
      parseSnapshotDocument('{"entries": [], "leaf": {"viaBoundary": "b"}}'),
    UsageError,
  );
  assert.throws(
    () => parseSnapshotDocument('{"entries": [{"foo": 1}], "leaf": null}'),
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
  const snapshot = parseSnapshotDocument(`${user}\n${assistant}\n`);
  assert.equal(snapshot.entries.length, 2);
  assert.deepEqual(snapshot.leaf, {
    uuid: "00000002-0000-4000-8000-000000000000",
  });
});

test("parseSessionSnapshot points the other shapes at their subcommands", () => {
  assert.throws(
    () => parseSnapshotDocument(`${TAIL_LINE}\n`),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes("clauctl format events"),
  );
  assert.throws(() => parseSnapshotDocument("not json"), UsageError);
  // Old get-tree documents get the generic error, not a special case.
  assert.throws(
    () => parseSnapshotDocument('{"tree": [], "leaf": null}'),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message.includes("not a session snapshot"),
  );
});
