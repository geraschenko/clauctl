import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendSessionEntries,
  buildBoundaryEntries,
  projectKey,
  readSessionEntries,
  sessionFilePath,
  waitForEntryOnDisk,
  type SessionEntry,
} from "./session-file.ts";

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
  assert.throws(() => readSessionEntries(tornMiddle), /malformed session file line/);

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
  assert.equal(entries[0]!.version, "2.1.195");
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

test("waitForEntryOnDisk resolves immediately for a present entry", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "clauctl-sf-")), "s.jsonl");
  const entry = { uuid: uuid(), type: "user" };
  writeFileSync(file, `${JSON.stringify(entry)}\n`);
  await waitForEntryOnDisk(file, entry.uuid);
});

test("waitForEntryOnDisk resolves once the entry is appended", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "clauctl-sf-")), "s.jsonl");
  writeFileSync(file, `${JSON.stringify({ uuid: uuid() })}\n`);
  const target = uuid();
  const waiting = waitForEntryOnDisk(file, target);
  appendFileSync(file, `${JSON.stringify({ uuid: target })}\n`);
  await waiting;
});

test("waitForEntryOnDisk rejects on timeout", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "clauctl-sf-")), "s.jsonl");
  writeFileSync(file, `${JSON.stringify({ uuid: uuid() })}\n`);
  await assert.rejects(
    waitForEntryOnDisk(file, uuid(), 50),
    /did not appear/,
  );
});
