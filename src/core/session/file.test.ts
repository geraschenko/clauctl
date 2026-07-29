import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendSessionEntries,
  buildBoundaryEntries,
  entriesByUuid,
  entryToSessionMessage,
  projectKey,
  readSessionEntries,
  SessionEntryParser,
  sessionFilePath,
  type SessionEntry,
} from "./file.ts";

const uuid = (): UUID => randomUUID();

test("projectKey replaces every non-alphanumeric character", () => {
  assert.equal(projectKey("/home/user/my_repo.git"), "-home-user-my-repo-git");
});

test("sessionFilePath composes configDir, projectKey, and session id", () => {
  const sessionId = uuid();
  assert.equal(
    sessionFilePath("/cfg", "/work/repo", sessionId),
    `/cfg/projects/-work-repo/${sessionId}.jsonl`,
  );
});

test("readSessionEntries preserves order and unknown fields, skips a torn tail", () => {
  const file = join(mkdtempSync(join(tmpdir(), "clauctl-sf-")), "s.jsonl");
  const a = { uuid: uuid(), type: "user", custom: { nested: true } };
  const b = { uuid: uuid(), type: "assistant" };
  writeFileSync(
    file,
    `${JSON.stringify(a)}\n${JSON.stringify(b)}\n{"uuid":"torn`,
  );
  assert.deepEqual(readSessionEntries(file), [a, b]);
});

test("readSessionEntries throws on malformed non-final lines and non-object values", () => {
  const dir = mkdtempSync(join(tmpdir(), "clauctl-sf-"));
  const entry = { uuid: uuid(), type: "user" };

  const tornMiddle = join(dir, "torn-middle.jsonl");
  writeFileSync(tornMiddle, `{"uuid":"torn\n${JSON.stringify(entry)}\n`);
  assert.throws(
    () => readSessionEntries(tornMiddle),
    /malformed session file line/,
  );

  // A terminated final line cannot be a torn append (the newline landed, so
  // the whole record did); malformed there is corruption too.
  const terminatedTail = join(dir, "terminated-tail.jsonl");
  writeFileSync(terminatedTail, `${JSON.stringify(entry)}\nmalformed\n`);
  assert.throws(
    () => readSessionEntries(terminatedTail),
    /malformed session file line/,
  );

  const nonObject = join(dir, "non-object.jsonl");
  writeFileSync(nonObject, `null\n${JSON.stringify(entry)}\n`);
  assert.throws(() => readSessionEntries(nonObject), /not an object/);
});

test("SessionEntryParser yields multiple entries from one chunk", () => {
  const parser = new SessionEntryParser("/s.jsonl");
  const a = { uuid: uuid(), type: "user" };
  const b = { type: "summary", note: "no uuid" };
  const entries = parser.push(
    Buffer.from(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`),
  );
  assert.deepEqual(entries, [a, b]);
});

test("SessionEntryParser buffers a line split across pushes", () => {
  const parser = new SessionEntryParser("/s.jsonl");
  const entry = { uuid: uuid(), type: "user", custom: { nested: true } };
  const line = `${JSON.stringify(entry)}\n`;
  assert.deepEqual(parser.push(Buffer.from(line.slice(0, 10))), []);
  assert.deepEqual(parser.push(Buffer.from(line.slice(10, 20))), []);
  assert.deepEqual(parser.push(Buffer.from(line.slice(20))), [entry]);
});

test("SessionEntryParser reassembles a UTF-8 code point split across pushes", () => {
  const parser = new SessionEntryParser("/s.jsonl");
  const entry = { uuid: uuid(), text: "snowman \u{2603} and beyond \u{1f680}" };
  const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
  const rocketStart = bytes.indexOf(Buffer.from("\u{1f680}")) + 2;
  assert.deepEqual(parser.push(bytes.subarray(0, rocketStart)), []);
  assert.deepEqual(parser.push(bytes.subarray(rocketStart)), [entry]);
});

test("SessionEntryParser emits a torn tail once its newline arrives", () => {
  const parser = new SessionEntryParser("/s.jsonl");
  const a = { uuid: uuid(), type: "user" };
  const b = { uuid: uuid(), type: "assistant" };
  const torn = JSON.stringify(b);
  assert.deepEqual(
    parser.push(Buffer.from(`${JSON.stringify(a)}\n${torn.slice(0, 5)}`)),
    [a],
  );
  assert.deepEqual(parser.push(Buffer.from(`${torn.slice(5)}\n`)), [b]);
});

test("SessionEntryParser counts blank lines toward error line numbers", () => {
  const parser = new SessionEntryParser("/s.jsonl");
  const entry = { uuid: uuid() };
  assert.deepEqual(parser.push(Buffer.from(`${JSON.stringify(entry)}\n\n`)), [
    entry,
  ]);
  assert.throws(
    () => parser.push(Buffer.from("   \nmalformed\n")),
    /^Error: \/s\.jsonl:4: malformed session file line$/,
  );
});

test("SessionEntryParser throws on a terminated non-object line", () => {
  const parser = new SessionEntryParser("/s.jsonl");
  assert.throws(
    () => parser.push(Buffer.from("[1,2]\n")),
    /^Error: \/s\.jsonl:1: session file line is not an object$/,
  );
});

test("entriesByUuid keeps the first occurrence of a duplicated uuid and skips uuid-less entries", () => {
  const duplicated = uuid();
  const first = { uuid: duplicated, type: "user", payload: "original" };
  const rePersisted = { uuid: duplicated, type: "user", payload: "mutated" };
  const uuidLess = { type: "summary" };
  const other = { uuid: uuid(), type: "assistant" };
  const byUuid = entriesByUuid([first, uuidLess, rePersisted, other]);
  assert.equal(byUuid.size, 2);
  assert.equal(byUuid.get(duplicated), first);
  assert.equal(byUuid.get(other.uuid), other);
});

test("buildBoundaryEntries with summary, anchor summary (up_to shape)", () => {
  const sessionId = uuid();
  const uuids = [uuid(), uuid()];
  const leaf = uuid();
  const { entries, result } = buildBoundaryEntries({
    sessionId,
    cwd: "/work",
    uuids,
    summaryText: "the summary",
    anchor: "summary",
    logicalParentUuid: leaf,
    version: "2.2.7",
    preTokens: 12345,
  });
  assert.equal(entries.length, 2);
  const [boundary, summary] = entries as [SessionEntry, SessionEntry];
  assert.equal(boundary.type, "system");
  assert.equal(boundary.subtype, "compact_boundary");
  assert.equal(boundary.parentUuid, null);
  assert.equal(boundary.logicalParentUuid, leaf);
  assert.equal(boundary.uuid, result.boundaryUuid);
  assert.equal(boundary.sessionId, sessionId);
  assert.equal(boundary.cwd, "/work");
  const metadata = boundary.compactMetadata as {
    trigger: string;
    preservedMessages: { anchorUuid: UUID; uuids: UUID[]; allUuids: UUID[] };
  };
  assert.equal(metadata.trigger, "manual");
  assert.equal(boundary.version, "2.2.7");
  assert.equal(
    (boundary.compactMetadata as { preTokens: number }).preTokens,
    12345,
  );
  assert.equal(metadata.preservedMessages.anchorUuid, result.summaryUuid);
  assert.deepEqual(metadata.preservedMessages.uuids, uuids);
  assert.deepEqual(metadata.preservedMessages.allUuids, uuids);
  assert.equal(summary.type, "user");
  assert.equal(summary.uuid, result.summaryUuid);
  assert.equal(summary.parentUuid, result.boundaryUuid);
  assert.equal(summary.isCompactSummary, true);
  assert.deepEqual(summary.message, { role: "user", content: "the summary" });
});

test("buildBoundaryEntries with summary, anchor boundary (from shape)", () => {
  const { entries, result } = buildBoundaryEntries({
    sessionId: uuid(),
    cwd: "/work",
    uuids: [uuid()],
    summaryText: "kept prefix",
    anchor: "boundary",
    logicalParentUuid: null,
    version: undefined,
    preTokens: 0,
  });
  const boundary = entries[0]!;
  const metadata = boundary.compactMetadata as {
    preservedMessages: { anchorUuid: UUID };
  };
  assert.equal(metadata.preservedMessages.anchorUuid, result.boundaryUuid);
  assert.equal(entries.length, 2);
  assert.notEqual(result.summaryUuid, undefined);
});

test("buildBoundaryEntries without summary writes only the boundary", () => {
  const { entries, result } = buildBoundaryEntries({
    sessionId: uuid(),
    cwd: "/work",
    uuids: [uuid()],
    anchor: "boundary",
    logicalParentUuid: null,
    version: undefined,
    preTokens: 0,
  });
  assert.equal(entries.length, 1);
  // An unobserved version falls back to the recipe's proven constant.
  assert.equal(entries[0]!.version, "2.1.211");
  assert.equal(result.summaryUuid, undefined);
  const metadata = entries[0]!.compactMetadata as {
    preservedMessages: { anchorUuid: UUID };
  };
  assert.equal(metadata.preservedMessages.anchorUuid, result.boundaryUuid);
});

test("appendSessionEntries round-trips through readSessionEntries", () => {
  const file = join(mkdtempSync(join(tmpdir(), "clauctl-sf-")), "s.jsonl");
  const existing = { uuid: uuid(), type: "user" };
  writeFileSync(file, `${JSON.stringify(existing)}\n`);
  const { entries } = buildBoundaryEntries({
    sessionId: uuid(),
    cwd: "/work",
    uuids: [existing.uuid],
    summaryText: "s",
    anchor: "summary",
    logicalParentUuid: existing.uuid,
    version: undefined,
    preTokens: 0,
  });
  appendSessionEntries(file, entries);
  assert.deepEqual(readSessionEntries(file), [existing, ...entries]);
});

test("entryToSessionMessage maps user/assistant entries and drops the rest", () => {
  const entryUuid = uuid();
  const sid = uuid();
  const entry = {
    uuid: entryUuid,
    parentUuid: null,
    type: "user",
    sessionId: sid,
    message: { role: "user", content: "hi" },
    timestamp: "2026-07-18T00:00:00.000Z",
  };
  assert.deepEqual(entryToSessionMessage(entry), {
    type: "user",
    uuid: entryUuid,
    session_id: sid,
    message: { role: "user", content: "hi" },
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: "2026-07-18T00:00:00.000Z",
  });
  assert.equal(
    entryToSessionMessage({ uuid: uuid(), type: "system" }),
    undefined,
  );
  assert.equal(
    entryToSessionMessage({ uuid: uuid(), type: "user", isMeta: true }),
    undefined,
  );
  assert.equal(
    entryToSessionMessage({
      uuid: uuid(),
      type: "assistant",
      isSidechain: true,
    }),
    undefined,
  );
  assert.equal(entryToSessionMessage({ type: "user" }), undefined);
});
