import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { err, ok } from "neverthrow";
import {
  entriesByUuid,
  entryOrThrow,
  entryToSessionMessage,
  projectKey,
  queuedCommandPrompt,
  queuedCommandSourceUuid,
  readEntriesAt,
  readSessionEntries,
  SessionEntryParser,
  sessionFilePath,
  type SessionEntry,
} from "./file.ts";

const uuid = (): UUID => randomUUID();

test("queuedCommandPrompt/SourceUuid read string and block-form attachments alike", () => {
  const sourceUuid = uuid();
  const attachment = (prompt: unknown): SessionEntry =>
    ({
      type: "attachment",
      uuid: uuid(),
      attachment: { type: "queued_command", prompt, source_uuid: sourceUuid },
    }) as unknown as SessionEntry;
  const stringForm = attachment("also say QUEUED");
  assert.equal(queuedCommandPrompt(stringForm), "also say QUEUED");
  assert.equal(queuedCommandSourceUuid(stringForm), sourceUuid);
  const blockForm = attachment([
    { type: "text", text: "first block" },
    { type: "image", source: {} },
    { type: "text", text: "second block" },
  ]);
  assert.equal(queuedCommandPrompt(blockForm), "first block\nsecond block");
  assert.equal(queuedCommandSourceUuid(blockForm), sourceUuid);
  const malformed = attachment(42);
  assert.equal(queuedCommandPrompt(malformed), undefined);
  assert.equal(queuedCommandSourceUuid(malformed), undefined);
  const user = { type: "user", uuid: uuid() } as unknown as SessionEntry;
  assert.equal(queuedCommandPrompt(user), undefined);
});

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

test("SessionEntryParser yields multiple entries from one chunk with their byte ranges", () => {
  const parser = new SessionEntryParser();
  const a = { uuid: uuid(), type: "user", text: "héllo → 🚀" };
  const b = { type: "summary", note: "no uuid" };
  const aLine = `${JSON.stringify(a)}\n`;
  const bLine = `${JSON.stringify(b)}\r\n`;
  const aLength = Buffer.byteLength(aLine);
  assert.deepEqual(parser.push(Buffer.from(aLine + bLine)), [
    ok({ entry: a, range: { offset: 0, length: aLength } }),
    ok({
      entry: b,
      range: { offset: aLength, length: Buffer.byteLength(bLine) },
    }),
  ]);
});

test("SessionEntryParser ranges skip blank lines and span a line torn across pushes", () => {
  const parser = new SessionEntryParser();
  const a = { uuid: uuid(), type: "user" };
  const b = { uuid: uuid(), type: "assistant" };
  const aLine = `${JSON.stringify(a)}\n`;
  const bLine = `${JSON.stringify(b)}\n`;
  const bStart = aLine.length + 1;
  const first = Buffer.from(`${aLine}\n${bLine.slice(0, 5)}`);
  assert.deepEqual(parser.push(first), [
    ok({ entry: a, range: { offset: 0, length: aLine.length } }),
  ]);
  assert.deepEqual(parser.push(Buffer.from(bLine.slice(5))), [
    ok({ entry: b, range: { offset: bStart, length: bLine.length } }),
  ]);
});

test("SessionEntryParser counts blank lines toward error line numbers", () => {
  const parser = new SessionEntryParser();
  const entry = { uuid: uuid() };
  const firstChunk = `${JSON.stringify(entry)}\n\n`;
  const range = { offset: 0, length: firstChunk.length - 1 };
  assert.deepEqual(parser.push(Buffer.from(firstChunk)), [
    ok({ entry, range }),
  ]);
  const malformed = {
    range: { offset: firstChunk.length + 4, length: 10 },
    lineNumber: 4,
    reason: "not-json",
  } as const;
  assert.deepEqual(parser.push(Buffer.from("   \nmalformed\n")), [
    err(malformed),
  ]);
  assert.throws(
    () => entryOrThrow("/s.jsonl", err(malformed)),
    /^Error: \/s\.jsonl:4: malformed session file line$/,
  );
});

test("SessionEntryParser reports malformed lines in file order and keeps parsing", () => {
  const parser = new SessionEntryParser();
  const entry = { uuid: uuid() };
  const entryLine = `${JSON.stringify(entry)}\n`;
  assert.deepEqual(parser.push(Buffer.from(`bad\n[1]\n${entryLine}`)), [
    err({ range: { offset: 0, length: 4 }, lineNumber: 1, reason: "not-json" }),
    err({
      range: { offset: 4, length: 4 },
      lineNumber: 2,
      reason: "not-object",
    }),
    ok({ entry, range: { offset: 8, length: entryLine.length } }),
  ]);
});

test("readEntriesAt reads entries by range without the rest of the file; a stale range throws", () => {
  const file = join(mkdtempSync(join(tmpdir(), "clauctl-sf-")), "s.jsonl");
  const entries = [
    { uuid: uuid(), type: "user", text: "🚀" },
    { uuid: uuid(), type: "assistant" },
    { uuid: uuid(), type: "user" },
  ];
  const content = entries.map((e) => `${JSON.stringify(e)}\n`).join("");
  writeFileSync(file, content);
  const ranges = new SessionEntryParser()
    .push(Buffer.from(content))
    .map((line) => entryOrThrow(file, line).range);
  assert.deepEqual(readEntriesAt(file, [ranges[2]!, ranges[0]!]), [
    entries[2],
    entries[0],
  ]);
  assert.deepEqual(readEntriesAt(file, []), []);
  const stale = { offset: ranges[1]!.offset + 1, length: ranges[1]!.length };
  assert.throws(
    () => readEntriesAt(file, [stale]),
    /malformed session file line/,
  );
  const pastEnd = { offset: Buffer.byteLength(content), length: 10 };
  assert.throws(
    () => readEntriesAt(file, [pastEnd]),
    /does not hold one entry line/,
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
