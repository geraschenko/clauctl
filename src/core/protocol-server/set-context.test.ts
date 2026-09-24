/**
 * normalizePreservedUuids unit tests (docs/specs/loaded-context.md):
 * completion of mismatched tool call/result pairs from the file, and the
 * fail-closed rejections whose presented context would silently diverge
 * from the list; buildBoundaryEntries shape tests. Fixture shapes mirror real sessions (parallel group structure
 * from parity fixture readonly-fold.jsonl). Probe ids (e.g. P10, p19,
 * p20-part1) cite docs/derisk/compact-boundary-injection/FINDINGS.md.
 */

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendSessionEntries,
  entriesByUuid,
  readSessionEntries,
  type SessionEntry,
} from "../session/file.ts";
import {
  buildBoundaryEntries,
  normalizePreservedUuids,
} from "./set-context.ts";

const uuid = (): UUID => randomUUID();

// --- entry builders --------------------------------------------------------

function userEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
  text = "hi",
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "user",
    sessionId,
    message: { role: "user", content: text },
  };
}

function textEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
  apiMessageId: string,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "assistant",
    sessionId,
    message: {
      role: "assistant",
      id: apiMessageId,
      content: [{ type: "text", text: "ok" }],
    },
  };
}

function callEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
  apiMessageId: string,
  callId: string,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "assistant",
    sessionId,
    message: {
      role: "assistant",
      id: apiMessageId,
      content: [{ type: "tool_use", id: callId, name: "Bash", input: {} }],
    },
  };
}

function resultEntry(
  call: SessionEntry & { uuid: UUID },
  sessionId: UUID,
): SessionEntry & { uuid: UUID } {
  const callId = (call.message as { content: { id: string }[] }).content[0]!.id;
  return {
    uuid: uuid(),
    parentUuid: call.uuid,
    type: "user",
    sessionId,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: callId, content: "ok" }],
    },
  };
}

function thinkingEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
  apiMessageId: string,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "assistant",
    sessionId,
    message: {
      role: "assistant",
      id: apiMessageId,
      content: [{ type: "thinking", thinking: "hm", signature: "sig" }],
    },
  };
}

// --- completion ------------------------------------------------------------

test("a missing result is inserted immediately after its call and reported", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const call = callEntry(u1.uuid, sid, "msg_1", "toolu_1");
  const result = resultEntry(call, sid);
  const u2 = userEntry(result.uuid, sid);
  const normalized = normalizePreservedUuids(
    [u1.uuid, call.uuid, u2.uuid],
    entriesByUuid([u1, call, result, u2]),
  );
  assert.deepEqual(normalized, {
    ok: true,
    uuids: [u1.uuid, call.uuid, result.uuid, u2.uuid],
    added: [result.uuid],
  });
});

test("a missing call is inserted immediately before its result and reported", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const call = callEntry(u1.uuid, sid, "msg_1", "toolu_1");
  const result = resultEntry(call, sid);
  const normalized = normalizePreservedUuids(
    [u1.uuid, result.uuid],
    entriesByUuid([u1, call, result]),
  );
  assert.deepEqual(normalized, {
    ok: true,
    uuids: [u1.uuid, call.uuid, result.uuid],
    added: [call.uuid],
  });
});

test("a complete list passes through with nothing added", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const call = callEntry(u1.uuid, sid, "msg_1", "toolu_1");
  const result = resultEntry(call, sid);
  const requested = [u1.uuid, call.uuid, result.uuid];
  assert.deepEqual(
    normalizePreservedUuids(requested, entriesByUuid([u1, call, result])),
    { ok: true, uuids: requested, added: [] },
  );
  // The empty list (deliberate context reset, P10; see file comment) is
  // also complete.
  assert.deepEqual(normalizePreservedUuids([], entriesByUuid([u1])), {
    ok: true,
    uuids: [],
    added: [],
  });
});

test("only the requested calls' pairs are completed — an omitted sibling pair stays omitted (p20-part1; see file comment)", () => {
  // Parallel group thinking + callA + callB; the list keeps only
  // callA's pair. Legal: the cut removes callB and resultB from the
  // recovery universe, so the exclusion is presented as-is.
  const sid = uuid();
  const messageId = "msg_par";
  const u1 = userEntry(null, sid);
  const thinking = thinkingEntry(u1.uuid, sid, messageId);
  const callA = callEntry(thinking.uuid, sid, messageId, "toolu_A");
  const callB = callEntry(callA.uuid, sid, messageId, "toolu_B");
  const resultB = resultEntry(callB, sid);
  const resultA = resultEntry(callA, sid);
  const byUuid = entriesByUuid([u1, thinking, callA, callB, resultB, resultA]);
  assert.deepEqual(
    normalizePreservedUuids([u1.uuid, thinking.uuid, callA.uuid], byUuid),
    {
      ok: true,
      uuids: [u1.uuid, thinking.uuid, callA.uuid, resultA.uuid],
      added: [resultA.uuid],
    },
  );
  // Likewise excluding a thinking sibling while keeping a pair is legal.
  assert.deepEqual(
    normalizePreservedUuids([u1.uuid, callA.uuid, resultA.uuid], byUuid),
    {
      ok: true,
      uuids: [u1.uuid, callA.uuid, resultA.uuid],
      added: [],
    },
  );
});

// --- rejections ------------------------------------------------------------

test("reject: duplicated uuid, with the clobbering mechanism in the reason", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const normalized = normalizePreservedUuids(
    [u1.uuid, u1.uuid],
    entriesByUuid([u1]),
  );
  assert.equal(normalized.ok, false);
  assert.match((normalized as { reason: string }).reason, /duplicated uuid/);
  assert.match((normalized as { reason: string }).reason, /clobbers/);
});

test("reject: a uuid naming no file entry", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const stranger = uuid();
  const normalized = normalizePreservedUuids(
    [u1.uuid, stranger],
    entriesByUuid([u1]),
  );
  assert.equal(normalized.ok, false);
  assert.match(
    (normalized as { reason: string }).reason,
    /names no earlier entry/,
  );
});

test("reject: a call with no tool_result anywhere in the file (killed turn, p20; see file comment)", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const call = callEntry(u1.uuid, sid, "msg_1", "toolu_1");
  const normalized = normalizePreservedUuids(
    [u1.uuid, call.uuid],
    entriesByUuid([u1, call]),
  );
  assert.equal(normalized.ok, false);
  assert.match(
    (normalized as { reason: string }).reason,
    /no tool_result anywhere in the file/,
  );
});

test("reject: a result whose call entry is missing from the file", () => {
  const sid = uuid();
  const phantomCall = callEntry(null, sid, "msg_1", "toolu_1");
  const orphan = resultEntry(phantomCall, sid);
  const normalized = normalizePreservedUuids(
    [orphan.uuid],
    entriesByUuid([orphan]),
  );
  assert.equal(normalized.ok, false);
  assert.match(
    (normalized as { reason: string }).reason,
    /no call entry in the file/,
  );
});

test("reject: a list keeping only thinking entries of a group (p19; see file comment)", () => {
  const sid = uuid();
  const messageId = "msg_think";
  const u1 = userEntry(null, sid);
  const thinking = thinkingEntry(u1.uuid, sid, messageId);
  const text = textEntry(thinking.uuid, sid, messageId);
  const normalized = normalizePreservedUuids(
    [u1.uuid, thinking.uuid],
    entriesByUuid([u1, thinking, text]),
  );
  assert.equal(normalized.ok, false);
  assert.match((normalized as { reason: string }).reason, /thinking-only/);
  // Keeping a non-thinking sibling makes the group legal.
  assert.deepEqual(
    normalizePreservedUuids(
      [u1.uuid, thinking.uuid, text.uuid],
      entriesByUuid([u1, thinking, text]),
    ),
    {
      ok: true,
      uuids: [u1.uuid, thinking.uuid, text.uuid],
      added: [],
    },
  );
});

test("buildBoundaryEntries with summary, anchor summary (up_to shape)", () => {
  const sessionId = uuid();
  const uuids = [uuid(), uuid()];
  const leaf = uuid();
  const { entries, response } = buildBoundaryEntries({
    sessionId,
    cwd: "/work",
    uuids,
    summaryText: "the summary",
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
  assert.equal(boundary.uuid, response.boundaryUuid);
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
  assert.equal(metadata.preservedMessages.anchorUuid, response.summaryUuid);
  assert.deepEqual(metadata.preservedMessages.uuids, uuids);
  assert.deepEqual(metadata.preservedMessages.allUuids, uuids);
  assert.equal(summary.type, "user");
  assert.equal(summary.uuid, response.summaryUuid);
  assert.equal(summary.parentUuid, response.boundaryUuid);
  assert.equal(summary.isCompactSummary, true);
  assert.deepEqual(summary.message, { role: "user", content: "the summary" });
});

test("buildBoundaryEntries without summary writes only the boundary", () => {
  const { entries, response } = buildBoundaryEntries({
    sessionId: uuid(),
    cwd: "/work",
    uuids: [uuid()],
    logicalParentUuid: null,
    version: undefined,
    preTokens: 0,
  });
  assert.equal(entries.length, 1);
  // An unobserved version falls back to the recipe's proven constant.
  assert.equal(entries[0]!.version, "2.1.211");
  assert.equal(response.summaryUuid, undefined);
  const metadata = entries[0]!.compactMetadata as {
    preservedMessages: { anchorUuid: UUID };
  };
  assert.equal(metadata.preservedMessages.anchorUuid, response.boundaryUuid);
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
    logicalParentUuid: existing.uuid,
    version: undefined,
    preTokens: 0,
  });
  appendSessionEntries(file, entries);
  assert.deepEqual(readSessionEntries(file), [existing, ...entries]);
});
