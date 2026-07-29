import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StreamEvent } from "../generated/streaming/driver.ts";
import {
  canonicalizeEntries,
  readEntriesAfterStreamFlush,
  SessionEntryClient,
  waitForEntry,
  type EntryStreamState,
} from "./entry-stream.ts";
import type { SessionEntry } from "./file.ts";

const uuid = (): UUID => randomUUID();

const jsonl = (entries: readonly SessionEntry[]): string =>
  entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

function tempFile(entries: readonly SessionEntry[], suffix = ""): string {
  const file = join(mkdtempSync(join(tmpdir(), "clauctl-es-")), "s.jsonl");
  writeFileSync(file, jsonl(entries) + suffix);
  return file;
}

/** Pulls one event without `for await` (whose early exit would cancel the
 *  queue); done:true means the queue closed. */
type EntryEvents = AsyncIterator<StreamEvent<SessionEntry, EntryStreamState>>;
const iterate = (subscription: {
  events: AsyncIterable<StreamEvent<SessionEntry, EntryStreamState>>;
}): EntryEvents => subscription.events[Symbol.asyncIterator]();

async function nextEntry(
  events: EntryEvents,
): Promise<StreamEvent<SessionEntry, EntryStreamState>> {
  const result = await events.next();
  assert.equal(result.done, false, "event queue closed unexpectedly");
  return result.value as StreamEvent<SessionEntry, EntryStreamState>;
}

test("canonicalizeEntries preserves order and payloads of unique entries", () => {
  const entries: SessionEntry[] = [
    { uuid: uuid(), type: "user", custom: { nested: true } },
    { type: "summary" },
    { uuid: uuid(), type: "assistant" },
  ];
  assert.deepEqual(canonicalizeEntries(entries), entries);
});

test("canonicalizeEntries keeps the first occurrence, ignoring a changed later copy", () => {
  const duplicated = uuid();
  const first = { uuid: duplicated, type: "user", toolUseResult: "original" };
  const rePersisted = {
    uuid: duplicated,
    type: "user",
    toolUseResult: "mutated",
  };
  const after = { uuid: uuid(), type: "assistant" };
  assert.deepEqual(canonicalizeEntries([first, rePersisted, after]), [
    first,
    after,
  ]);
});

test("canonicalizeEntries retains every uuid-less occurrence in position", () => {
  const a = { uuid: uuid(), type: "user" };
  const bare = { type: "summary" };
  const entries = [bare, a, bare, { ...a }, bare];
  assert.deepEqual(canonicalizeEntries(entries), [bare, a, bare, bare]);
});

test("canonicalizeEntries treats a non-string uuid field like a uuid-less entry", () => {
  const odd = { uuid: 42, type: "user" } as unknown as SessionEntry;
  assert.deepEqual(canonicalizeEntries([odd, { ...odd }]), [odd, { ...odd }]);
});

test("canonicalizeEntries since starts output after the cursor's first occurrence", () => {
  const cursor = uuid();
  const before = { uuid: uuid(), type: "user" };
  const bareBefore = { type: "summary" };
  const cursorEntry = { uuid: cursor, type: "assistant" };
  const bareAfter = { type: "summary", when: "after" };
  const after = { uuid: uuid(), type: "user" };
  assert.deepEqual(
    canonicalizeEntries(
      [bareBefore, before, cursorEntry, bareAfter, after],
      cursor,
    ),
    [bareAfter, after],
  );
});

test("canonicalizeEntries since cannot be bypassed by a post-cursor duplicate", () => {
  const cursor = uuid();
  const preCursor = { uuid: uuid(), type: "user", payload: "history" };
  const rePersisted = { ...preCursor, payload: "mutated" };
  const after = { uuid: uuid(), type: "assistant" };
  assert.deepEqual(
    canonicalizeEntries(
      [preCursor, { uuid: cursor, type: "user" }, rePersisted, after],
      cursor,
    ),
    [after],
  );
});

test("canonicalizeEntries since equal to the newest uuid yields no output", () => {
  const cursor = uuid();
  assert.deepEqual(
    canonicalizeEntries([{ uuid: uuid() }, { uuid: cursor }], cursor),
    [],
  );
});

test("canonicalizeEntries throws on a missing cursor", () => {
  const absent = uuid();
  assert.throws(
    () => canonicalizeEntries([{ uuid: uuid() }], absent),
    new RegExp(`since cursor ${absent} does not match any entry`),
  );
});

test("canonicalizeEntries only honors the cursor's FIRST occurrence position", () => {
  // The cursor's first occurrence sets the slice point; a later duplicate of
  // the cursor is an ordinary suppressed duplicate, not a second slice.
  const cursor = uuid();
  const after = { uuid: uuid(), type: "user" };
  assert.deepEqual(
    canonicalizeEntries(
      [{ uuid: cursor }, after, { uuid: cursor, mutated: true }],
      cursor,
    ),
    [after],
  );
});

test("history emit queues the extent's canonical entries, then follows live appends", async () => {
  const duplicated = uuid();
  const a = { uuid: duplicated, type: "user", payload: "original" };
  const rePersisted = { ...a, payload: "mutated" };
  const b = { uuid: uuid(), type: "assistant" };
  const file = tempFile([a, rePersisted, b]);
  const client = new SessionEntryClient(file, { history: "emit" });
  try {
    const subscription = await client.subscribe();
    assert.equal(subscription.seed.leaf, undefined);
    const events = iterate(subscription);
    const first = await nextEntry(events);
    assert.deepEqual(first.event, a);
    assert.equal(first.state.leaf, duplicated);
    const second = await nextEntry(events);
    assert.deepEqual(second.event, b);
    assert.equal(second.state.leaf, b.uuid);
    const live = { uuid: uuid(), type: "user", turn: 2 };
    appendFileSync(file, jsonl([live]));
    const third = await nextEntry(events);
    assert.deepEqual(third.event, live);
    assert.equal(third.state.leaf, live.uuid);
  } finally {
    client.close();
  }
});

test("history emit with since starts at the cursor and keeps suppressing duplicates live", async () => {
  const cursor = uuid();
  const preCursor = { uuid: uuid(), type: "user", payload: "history" };
  const after = { uuid: uuid(), type: "assistant" };
  const file = tempFile([preCursor, { uuid: cursor, type: "user" }, after]);
  const client = new SessionEntryClient(file, {
    history: "emit",
    since: cursor,
  });
  try {
    const subscription = await client.subscribe();
    assert.equal(subscription.seed.leaf, cursor);
    const events = iterate(subscription);
    assert.deepEqual((await nextEntry(events)).event, after);
    // A live re-persisted copy of pre-cursor history must not leak through.
    const live = { uuid: uuid(), type: "user" };
    appendFileSync(file, jsonl([{ ...preCursor, payload: "mutated" }, live]));
    assert.deepEqual((await nextEntry(events)).event, live);
  } finally {
    client.close();
  }
});

test("history emit with since equal to the newest uuid stays resumable with zero output", async () => {
  const cursor = uuid();
  const file = tempFile([{ uuid: uuid(), type: "user" }, { uuid: cursor }]);
  const client = new SessionEntryClient(file, {
    history: "emit",
    since: cursor,
  });
  try {
    const subscription = await client.subscribe();
    assert.equal(subscription.seed.leaf, cursor);
    const events = iterate(subscription);
    const live = { uuid: uuid(), type: "user" };
    appendFileSync(file, jsonl([live]));
    const first = await nextEntry(events);
    assert.deepEqual(first.event, live);
  } finally {
    client.close();
  }
});

test("history skip emits nothing from the extent but seeds dedup and the leaf", async () => {
  const historyEntry = { uuid: uuid(), type: "user", payload: "history" };
  const tip = { uuid: uuid(), type: "assistant" };
  const file = tempFile([historyEntry, tip]);
  const client = new SessionEntryClient(file, { history: "skip" });
  try {
    const subscription = await client.subscribe();
    assert.equal(subscription.seed.leaf, tip.uuid);
    assert.equal(subscription.seed.seenUuids.has(historyEntry.uuid), true);
    const events = iterate(subscription);
    // A live duplicate of skipped history stays suppressed; the next unique
    // entry is the first event.
    const live = { uuid: uuid(), type: "user" };
    appendFileSync(
      file,
      jsonl([{ ...historyEntry, payload: "mutated" }, live]),
    );
    assert.deepEqual((await nextEntry(events)).event, live);
  } finally {
    client.close();
  }
});

test("a torn tail at the seed emits once completed, under history skip too", async () => {
  const complete = { uuid: uuid(), type: "user" };
  const torn = { uuid: uuid(), type: "assistant", text: "later" };
  const tornLine = JSON.stringify(torn);
  const file = tempFile([complete], tornLine.slice(0, 12));
  const client = new SessionEntryClient(file, { history: "skip" });
  try {
    const subscription = await client.subscribe();
    // The torn suffix is not yet an entry: it neither advances the leaf nor
    // appears in history.
    assert.equal(subscription.seed.leaf, complete.uuid);
    const events = iterate(subscription);
    appendFileSync(file, `${tornLine.slice(12)}\n`);
    assert.deepEqual((await nextEntry(events)).event, torn);
  } finally {
    client.close();
  }
});

test("one wake drains multiple appended entries in order", async () => {
  const file = tempFile([{ uuid: uuid(), type: "user" }]);
  const client = new SessionEntryClient(file, { history: "skip" });
  try {
    const subscription = await client.subscribe();
    const events = iterate(subscription);
    const batch = [
      { uuid: uuid(), n: 1 },
      { type: "summary", n: 2 },
      { uuid: uuid(), n: 3 },
    ];
    appendFileSync(file, jsonl(batch));
    assert.deepEqual((await nextEntry(events)).event, batch[0]);
    assert.deepEqual((await nextEntry(events)).event, batch[1]);
    const third = await nextEntry(events);
    assert.deepEqual(third.event, batch[2]);
    assert.equal(third.state.leaf, batch[2]!.uuid);
  } finally {
    client.close();
  }
});

test("seenUuids is a live monotone view shared with retained states", async () => {
  const file = tempFile([{ uuid: uuid(), type: "user" }]);
  const client = new SessionEntryClient(file, { history: "emit" });
  try {
    const subscription = await client.subscribe();
    const events = iterate(subscription);
    await nextEntry(events);
    const live = { uuid: uuid(), type: "user" };
    assert.equal(subscription.seed.seenUuids.has(live.uuid), false);
    appendFileSync(file, jsonl([live]));
    await nextEntry(events);
    assert.equal(subscription.seed.seenUuids.has(live.uuid), true);
  } finally {
    client.close();
  }
});

test("subscribe rejects on a missing file, a missing cursor, and a corrupt extent", async () => {
  const missing = new SessionEntryClient(
    join(mkdtempSync(join(tmpdir(), "clauctl-es-")), "absent.jsonl"),
    { history: "emit" },
  );
  await assert.rejects(missing.subscribe(), /ENOENT/);

  const absent = uuid();
  const missingCursor = new SessionEntryClient(
    tempFile([{ uuid: uuid(), type: "user" }]),
    { history: "emit", since: absent },
  );
  await assert.rejects(
    missingCursor.subscribe(),
    new RegExp(`since cursor ${absent} does not match any entry in `),
  );

  const corrupt = new SessionEntryClient(
    tempFile([{ uuid: uuid() }], "malformed\n"),
    { history: "emit" },
  );
  await assert.rejects(corrupt.subscribe(), /malformed session file line/);
});

test("subscribe is allowed once per client; close is idempotent", async () => {
  const file = tempFile([{ uuid: uuid(), type: "user" }]);
  const client = new SessionEntryClient(file, { history: "skip" });
  try {
    await client.subscribe();
    await assert.rejects(client.subscribe(), /one subscribe\(\) per client/);
  } finally {
    client.close();
    client.close();
  }
});

test("truncation sets failure and closes the queue", async () => {
  const entries = [
    { uuid: uuid(), type: "user", padding: "x".repeat(200) },
    { uuid: uuid(), type: "assistant" },
  ];
  const file = tempFile(entries);
  const client = new SessionEntryClient(file, { history: "skip" });
  try {
    const subscription = await client.subscribe();
    const events = iterate(subscription);
    writeFileSync(file, jsonl([entries[0]!]));
    const result = await events.next();
    assert.equal(result.done, true);
    assert.match(
      client.failure!.message,
      /truncated below the consumed byte extent/,
    );
  } finally {
    client.close();
  }
});

test("mid-follow corruption sets failure and closes the queue", async () => {
  const file = tempFile([{ uuid: uuid(), type: "user" }]);
  const client = new SessionEntryClient(file, { history: "skip" });
  try {
    const subscription = await client.subscribe();
    const events = iterate(subscription);
    appendFileSync(file, "malformed\n");
    const result = await events.next();
    assert.equal(result.done, true);
    assert.match(client.failure!.message, /malformed session file line/);
  } finally {
    client.close();
  }
});

test("replacement (rename away) sets failure and closes the queue", async () => {
  const file = tempFile([{ uuid: uuid(), type: "user" }]);
  const client = new SessionEntryClient(file, { history: "skip" });
  try {
    const subscription = await client.subscribe();
    const events = iterate(subscription);
    renameSync(file, `${file}.rotated`);
    const result = await events.next();
    assert.equal(result.done, true);
    assert.match(client.failure!.message, /replaced or removed/);
  } finally {
    client.close();
  }
});

test("a clean close leaves failure undefined and ends the queue", async () => {
  const file = tempFile([{ uuid: uuid(), type: "user" }]);
  const client = new SessionEntryClient(file, { history: "skip" });
  const subscription = await client.subscribe();
  const events = iterate(subscription);
  client.close();
  const result = await events.next();
  assert.equal(result.done, true);
  assert.equal(client.failure, undefined);
});

test("waitForEntry resolves immediately for a present entry", async () => {
  const entry = { uuid: uuid(), type: "user" };
  await waitForEntry(tempFile([entry]), entry.uuid);
});

test("waitForEntry resolves once the entry is appended, even as a duplicate", async () => {
  const historyEntry = { uuid: uuid(), type: "user" };
  const file = tempFile([historyEntry]);
  const target = uuid();
  const waiting = waitForEntry(file, target);
  // seenUuids membership, not canonical emission: a re-persisted duplicate
  // ahead of the target must not stall the wait.
  appendFileSync(file, jsonl([historyEntry, { uuid: target }]));
  await waiting;
});

test("waitForEntry rejects on timeout", async () => {
  const file = tempFile([{ uuid: uuid() }]);
  await assert.rejects(waitForEntry(file, uuid(), 50), /did not appear/);
});

test("waitForEntry rejects with the client failure when the file is corrupted", async () => {
  const file = tempFile([{ uuid: uuid() }]);
  const waiting = waitForEntry(file, uuid());
  appendFileSync(file, "malformed\n");
  await assert.rejects(waiting, /malformed session file line/);
});

test("readEntriesAfterStreamFlush returns the whole file, including post-leaf entries", async () => {
  const leaf = { uuid: uuid(), type: "assistant" };
  const postLeaf = { uuid: uuid(), type: "user", after: true };
  const file = tempFile([leaf, postLeaf]);
  assert.deepEqual(await readEntriesAfterStreamFlush(file, leaf.uuid), [
    leaf,
    postLeaf,
  ]);
  assert.deepEqual(await readEntriesAfterStreamFlush(file, undefined), [
    leaf,
    postLeaf,
  ]);
});
