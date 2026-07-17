import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import { effectiveChain, seedFromEntries } from "./effective-chain.ts";
import type { SessionEntry } from "./session-file.ts";

const uuid = (): UUID => randomUUID();

// --- entry builders ------------------------------------------------------------

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

function assistantEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
  apiMessageId = `msg_${randomUUID().slice(0, 8)}`,
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

function boundaryEntry(params: {
  sessionId: UUID;
  uuids: UUID[];
  anchor: "own" | UUID;
  logicalParentUuid?: UUID;
}): SessionEntry & { uuid: UUID } {
  const boundaryUuid = uuid();
  return {
    uuid: boundaryUuid,
    parentUuid: null,
    logicalParentUuid: params.logicalParentUuid ?? null,
    type: "system",
    subtype: "compact_boundary",
    sessionId: params.sessionId,
    compactMetadata: {
      trigger: "manual",
      preservedMessages: {
        anchorUuid: params.anchor === "own" ? boundaryUuid : params.anchor,
        uuids: params.uuids,
        allUuids: params.uuids,
      },
    },
  };
}

function summaryEntry(
  boundaryUuid: UUID,
  sessionId: UUID,
  presetUuid?: UUID,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: presetUuid ?? uuid(),
    parentUuid: boundaryUuid,
    type: "user",
    sessionId,
    message: { role: "user", content: "summary text" },
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  };
}

// --- effectiveChain ------------------------------------------------------------

test("effectiveChain without a boundary is the raw walk from the last entry", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2a = userEntry(a1.uuid, sid); // abandoned branch
  const u2b = userEntry(a1.uuid, sid); // active branch (later in file)
  assert.deepEqual(effectiveChain([u1, a1, u2a, u2b]), [
    u1.uuid,
    a1.uuid,
    u2b.uuid,
  ]);
});

test("effectiveChain up_to boundary: summary first, then uuids; post entries chain on", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2 = userEntry(a1.uuid, sid);
  const a2 = assistantEntry(u2.uuid, sid);
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u2.uuid, a2.uuid],
    anchor: summaryUuid,
  });
  const summary = summaryEntry(boundary.uuid, sid, summaryUuid);
  const base = [u1, a1, u2, a2, boundary, summary];
  assert.deepEqual(effectiveChain(base), [summaryUuid, u2.uuid, a2.uuid]);

  // A post-boundary turn parents onto the preserved tail (never the boundary).
  const u3 = userEntry(a2.uuid, sid);
  assert.deepEqual(effectiveChain([...base, u3]), [
    summaryUuid,
    u2.uuid,
    a2.uuid,
    u3.uuid,
  ]);
});

test("effectiveChain from-shape: uuids first, then summary; walk crosses the preserved uuids", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  const summary = summaryEntry(boundary.uuid, sid);
  const base = [u1, a1, boundary, summary];
  assert.deepEqual(effectiveChain(base), [u1.uuid, a1.uuid, summary.uuid]);

  // From-shape post-boundary writes chain through the synthetic assistant →
  // summary; the summary's effective parent carries the walk across the
  // preserved uuids.
  const synthetic = assistantEntry(summary.uuid, sid);
  assert.deepEqual(effectiveChain([...base, synthetic]), [
    u1.uuid,
    a1.uuid,
    summary.uuid,
    synthetic.uuid,
  ]);
});

test("effectiveChain no-summary boundary: context is exactly the preserved uuids", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2 = userEntry(a1.uuid, sid);
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u2.uuid],
    anchor: "own",
  });
  assert.deepEqual(effectiveChain([u1, a1, u2, boundary]), [u2.uuid]);
});

test("effectiveChain stacked boundaries: the last one wins entirely", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const first = boundaryEntry({
    sessionId: sid,
    uuids: [a1.uuid],
    anchor: "own",
  });
  const second = boundaryEntry({
    sessionId: sid,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  assert.deepEqual(effectiveChain([u1, a1, first, second]), [u1.uuid, a1.uuid]);
});

test("effectiveChain on a truncated file ignores later boundaries", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [a1.uuid],
    anchor: "own",
  });
  // "Context when a1 first appeared": the boundary does not exist yet.
  const entries = [u1, a1, boundary];
  assert.deepEqual(effectiveChain(entries.slice(0, 2)), [u1.uuid, a1.uuid]);
  assert.deepEqual(effectiveChain(entries), [a1.uuid]);
});

// --- seedFromEntries -------------------------------------------------------

test("seedFromEntries on an empty file yields no values", () => {
  assert.deepEqual(seedFromEntries([]), {});
});

test("seedFromEntries derives every field from a linear session", () => {
  const sid = uuid();
  const u1 = { ...userEntry(null, sid), version: "2.1.190" };
  const a1 = {
    ...assistantEntry(u1.uuid, sid),
    message: {
      role: "assistant",
      model: "claude-old",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [],
    },
  };
  const mode = {
    type: "permission-mode",
    permissionMode: "plan",
    sessionId: sid,
  };
  const u2 = { ...userEntry(a1.uuid, sid), version: "2.1.211" };
  const a2 = {
    ...assistantEntry(u2.uuid, sid),
    message: {
      role: "assistant",
      model: "claude-new",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 30,
      },
      content: [],
    },
  };
  const seed = seedFromEntries([u1, a1, mode, u2, a2]);
  assert.equal(seed.model, "claude-new");
  assert.equal(seed.claudeCodeVersion, "2.1.211");
  assert.equal(seed.permissionMode, "plan");
  assert.equal(seed.lastTranscriptUuid, a2.uuid);
  // Null token counters are coerced to 0.
  assert.deepEqual(seed.lastUsage, {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 30,
  });
});

test("seedFromEntries reads usage/model from the effective chain, not abandoned branches", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = {
    ...assistantEntry(u1.uuid, sid),
    message: {
      role: "assistant",
      model: "claude-kept",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [],
    },
  };
  const u2 = userEntry(a1.uuid, sid);
  const a2 = {
    ...assistantEntry(u2.uuid, sid),
    message: {
      role: "assistant",
      model: "claude-summarized-away",
      usage: { input_tokens: 100, output_tokens: 200 },
      content: [],
    },
  };
  // The boundary preserves only the first turn; a2 is off the chain.
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  const seed = seedFromEntries([u1, a1, u2, a2, boundary]);
  assert.equal(seed.model, "claude-kept");
  assert.equal(seed.lastUsage?.input_tokens, 1);
  assert.equal(seed.lastTranscriptUuid, a1.uuid);
});

test("seedFromEntries lastTranscriptUuid skips meta and sidechain entries", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const meta = { ...userEntry(a1.uuid, sid), isMeta: true };
  const seed = seedFromEntries([u1, a1, meta]);
  assert.equal(seed.lastTranscriptUuid, a1.uuid);
});
