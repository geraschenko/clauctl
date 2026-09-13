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
import { canonicalizeEntries, SessionLogFollower } from "./entry-stream.ts";
import type { MalformedLine, ParsedEntry, SessionEntry } from "./file.ts";

const uuid = (): UUID => randomUUID();

const jsonl = (entries: readonly SessionEntry[]): string =>
  entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

function tempFile(entries: readonly SessionEntry[], suffix = ""): string {
  const file = join(mkdtempSync(join(tmpdir(), "clauctl-es-")), "s.jsonl");
  writeFileSync(file, jsonl(entries) + suffix);
  return file;
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

/** A follower whose callbacks record into arrays; `failed` is its
 *  whenFailed() promise so tests await the failure, not a clock. */
function recordingFollower(file: string): {
  follower: SessionLogFollower;
  parsed: ParsedEntry[];
  malformed: MalformedLine[];
  failed: Promise<Error>;
} {
  const parsed: ParsedEntry[] = [];
  const malformed: MalformedLine[] = [];
  const reported: Error[] = [];
  const follower = new SessionLogFollower(
    file,
    (entry) => parsed.push(entry),
    (line) => malformed.push(line),
    (error) => reported.push(error),
  );
  const failed = follower.whenFailed().then((error) => {
    assert.deepEqual(reported, [error]);
    return error;
  });
  return { follower, parsed, malformed, failed };
}

test("follower scans the extent synchronously in start, then follows appends with file byte ranges", async () => {
  const a = { uuid: uuid(), type: "user" };
  const b = { uuid: uuid(), type: "assistant" };
  const file = tempFile([a]);
  const { follower, parsed } = recordingFollower(file);
  try {
    follower.start();
    assert.deepEqual(parsed, [
      { entry: a, range: { offset: 0, length: jsonl([a]).length } },
    ]);
    const quiet = follower.whenQuiet(50);
    appendFileSync(file, jsonl([b]));
    await quiet;
    assert.deepEqual(parsed[1], {
      entry: b,
      range: { offset: jsonl([a]).length, length: jsonl([b]).length },
    });
    assert.equal(follower.failure, undefined);
  } finally {
    follower.close();
  }
});

test("follower reports a malformed line's range, skips it, and keeps following", async () => {
  const a = { uuid: uuid(), type: "user" };
  const b = { uuid: uuid(), type: "assistant" };
  const file = tempFile([a], "malformed\n");
  const { follower, parsed, malformed } = recordingFollower(file);
  try {
    follower.start();
    assert.deepEqual(malformed, [
      {
        range: { offset: jsonl([a]).length, length: 10 },
        lineNumber: 2,
        reason: "not-json",
      },
    ]);
    const quiet = follower.whenQuiet(50);
    appendFileSync(file, jsonl([b]));
    await quiet;
    assert.deepEqual(
      parsed.map((p) => p.entry),
      [a, b],
    );
    assert.equal(follower.failure, undefined);
  } finally {
    follower.close();
  }
});

test("follower fails on truncation; drainVisibleBytes throws the failure", async () => {
  const entries = [
    { uuid: uuid(), type: "user", padding: "x".repeat(200) },
    { uuid: uuid(), type: "assistant" },
  ];
  const file = tempFile(entries);
  const { follower, failed } = recordingFollower(file);
  try {
    follower.start();
    writeFileSync(file, jsonl([entries[0]!]));
    assert.throws(
      () => follower.drainVisibleBytes(),
      /truncated below the consumed byte extent/,
    );
    assert.match((await failed).message, /truncated below/);
    assert.equal(follower.failure, await failed);
    // No-op once closed.
    follower.drainVisibleBytes();
  } finally {
    follower.close();
  }
});

test("follower fails on replacement (rename away); whenFailed resolves", async () => {
  const file = tempFile([{ uuid: uuid(), type: "user" }]);
  const { follower, failed } = recordingFollower(file);
  try {
    follower.start();
    renameSync(file, `${file}.rotated`);
    assert.match((await failed).message, /replaced or removed/);
  } finally {
    follower.close();
  }
});

test("follower whenQuiet restarts its window on each read that yields bytes", async () => {
  const file = tempFile([{ uuid: uuid(), type: "user" }]);
  const { follower, parsed } = recordingFollower(file);
  try {
    follower.start();
    const quiet = follower.whenQuiet(80);
    // A drain inside the window delivers bytes, so quiet cannot have
    // resolved before the entry it delivers is parsed.
    appendFileSync(file, jsonl([{ uuid: uuid(), type: "assistant" }]));
    follower.drainVisibleBytes();
    assert.equal(parsed.length, 2);
    await quiet;
    assert.equal(parsed.length, 2);
  } finally {
    follower.close();
  }
});

test("follower start throws on a missing file; whenQuiet resolves on close", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "clauctl-es-")), "no.jsonl");
  const { follower } = recordingFollower(missing);
  assert.throws(() => follower.start(), /ENOENT/);
  const { follower: open } = recordingFollower(tempFile([{ uuid: uuid() }]));
  open.start();
  const quiet = open.whenQuiet(10_000);
  open.close();
  await quiet;
});
