/**
 * Probe ids in comments (e.g. P1 d, P3 m4) cite the experiments in
 * docs/derisk/compact-boundary-injection/FINDINGS.md that established each
 * behavior.
 */

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import {
  effectiveChain,
  effectiveTreeNodeChain,
  seedFromEntries,
} from "./effective-chain.ts";
import type { SessionEntry } from "./session-file.ts";

const uuid = (): UUID => randomUUID();

/** onInvalid sink for well-formed files: any diagnostic is a test failure. */
const failOnInvalid = (message: string): never => {
  throw new Error(`unexpected onInvalid: ${message}`);
};

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
  assert.deepEqual(effectiveChain([u1, a1, u2a, u2b], failOnInvalid), [
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
  assert.deepEqual(effectiveChain(base, failOnInvalid), [
    summaryUuid,
    u2.uuid,
    a2.uuid,
  ]);

  // A post-boundary turn parents onto the preserved tail (never the boundary).
  const u3 = userEntry(a2.uuid, sid);
  assert.deepEqual(effectiveChain([...base, u3], failOnInvalid), [
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
  assert.deepEqual(effectiveChain(base, failOnInvalid), [
    u1.uuid,
    a1.uuid,
    summary.uuid,
  ]);

  // From-shape post-boundary writes chain through the synthetic assistant →
  // summary; the summary's effective parent carries the walk across the
  // preserved uuids.
  const synthetic = assistantEntry(summary.uuid, sid);
  assert.deepEqual(effectiveChain([...base, synthetic], failOnInvalid), [
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
  assert.deepEqual(effectiveChain([u1, a1, u2, boundary], failOnInvalid), [
    u2.uuid,
  ]);
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
  assert.deepEqual(effectiveChain([u1, a1, first, second], failOnInvalid), [
    u1.uuid,
    a1.uuid,
  ]);
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
  assert.deepEqual(effectiveChain(entries.slice(0, 2), failOnInvalid), [
    u1.uuid,
    a1.uuid,
  ]);
  assert.deepEqual(effectiveChain(entries, failOnInvalid), [a1.uuid]);
});

// --- effectiveTreeNodeChain ------------------------------------------------
// Shapes A–D from docs/specs/boundary-substructure.md "Concrete examples".

test("tree-node chain, up_to shape (example A): bare summary, relinked uuids, bare post entries", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const u2 = assistantEntry(u1.uuid, sid);
  const u3 = userEntry(u2.uuid, sid);
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u2.uuid, u3.uuid],
    anchor: summaryUuid,
    logicalParentUuid: u3.uuid,
  });
  const summary = summaryEntry(boundary.uuid, sid, summaryUuid);
  const base = [u1, u2, u3, boundary, summary];
  // No post entries: the tip is the last relinked uuid.
  assert.deepEqual(effectiveTreeNodeChain(base, failOnInvalid), [
    { uuid: summaryUuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
    { uuid: u3.uuid, viaBoundary: boundary.uuid },
  ]);
  const u4 = userEntry(u3.uuid, sid);
  assert.deepEqual(effectiveTreeNodeChain([...base, u4], failOnInvalid), [
    { uuid: summaryUuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
    { uuid: u3.uuid, viaBoundary: boundary.uuid },
    { uuid: u4.uuid },
  ]);
});

test("tree-node chain, from shape (example B): relinked uuids end in the relinked summary", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const u2 = assistantEntry(u1.uuid, sid);
  const u3 = userEntry(u2.uuid, sid);
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u1.uuid, u2.uuid],
    anchor: "own",
    logicalParentUuid: u2.uuid,
  });
  const summary = summaryEntry(boundary.uuid, sid);
  const base = [u1, u2, u3, boundary, summary];
  // No post entries: the tip is the relinked summary.
  assert.deepEqual(effectiveTreeNodeChain(base, failOnInvalid), [
    { uuid: u1.uuid, viaBoundary: boundary.uuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
    { uuid: summary.uuid, viaBoundary: boundary.uuid },
  ]);
  const u4 = userEntry(summary.uuid, sid);
  assert.deepEqual(effectiveTreeNodeChain([...base, u4], failOnInvalid), [
    { uuid: u1.uuid, viaBoundary: boundary.uuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
    { uuid: summary.uuid, viaBoundary: boundary.uuid },
    { uuid: u4.uuid },
  ]);
});

test("tree-node chain, stacked boundaries (example C): only the last boundary annotates", () => {
  const sid = uuid();
  const a = userEntry(null, sid);
  const b = assistantEntry(a.uuid, sid);
  const c = userEntry(b.uuid, sid);
  const s1Uuid = uuid();
  const first = boundaryEntry({
    sessionId: sid,
    uuids: [c.uuid],
    anchor: s1Uuid,
    logicalParentUuid: c.uuid,
  });
  const s1 = summaryEntry(first.uuid, sid, s1Uuid);
  const d = assistantEntry(c.uuid, sid);
  const s2Uuid = uuid();
  const second = boundaryEntry({
    sessionId: sid,
    uuids: [d.uuid],
    anchor: s2Uuid,
    logicalParentUuid: d.uuid,
  });
  const s2 = summaryEntry(second.uuid, sid, s2Uuid);
  const e = userEntry(d.uuid, sid);
  assert.deepEqual(
    effectiveTreeNodeChain(
      [a, b, c, first, s1, d, second, s2, e],
      failOnInvalid,
    ),
    [
      { uuid: s2Uuid },
      { uuid: d.uuid, viaBoundary: second.uuid },
      { uuid: e.uuid },
    ],
  );
});

test("tree-node chain, invalid relink (example D): loader-style skip to summary-only", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const u2 = assistantEntry(u1.uuid, sid);
  const u3 = userEntry(u2.uuid, sid);
  const summaryUuid = uuid();
  const duplicated = boundaryEntry({
    sessionId: sid,
    uuids: [u2.uuid, u2.uuid],
    anchor: summaryUuid,
    logicalParentUuid: u3.uuid,
  });
  const summary = summaryEntry(duplicated.uuid, sid, summaryUuid);
  const base = [u1, u2, u3, duplicated, summary];
  const invalidMessages: string[] = [];
  const collectInvalid = (message: string): void => {
    invalidMessages.push(message);
  };
  assert.deepEqual(effectiveTreeNodeChain(base, collectInvalid), [
    { uuid: summaryUuid },
  ]);
  assert.match(invalidMessages[0]!, /duplicated uuid/);
  // A uuid naming no earlier entry skips the same way.
  const missing = boundaryEntry({
    sessionId: sid,
    uuids: [u2.uuid, uuid()],
    anchor: summaryUuid,
    logicalParentUuid: u3.uuid,
  });
  assert.deepEqual(
    effectiveTreeNodeChain([u1, u2, u3, missing, summary], collectInvalid),
    [{ uuid: summaryUuid }],
  );
  assert.match(invalidMessages[1]!, /names no earlier entry/);
  // Post-skip writes parent onto the summary (P1 d; see file comment), all
  // bare.
  const u4 = userEntry(summaryUuid, sid);
  assert.deepEqual(effectiveTreeNodeChain([...base, u4], collectInvalid), [
    { uuid: summaryUuid },
    { uuid: u4.uuid },
  ]);
});

test("effectiveChain skips an invalid relink instead of applying it", () => {
  // Loader parity (P1 d, P3 m4; see file comment): a duplicated preserved
  // uuid used to be
  // silently deduped by the parent-map Map.set and the relink applied.
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u1.uuid, u1.uuid, a1.uuid],
    anchor: summaryUuid,
  });
  const summary = summaryEntry(boundary.uuid, sid, summaryUuid);
  const invalidMessages: string[] = [];
  assert.deepEqual(
    effectiveChain([u1, a1, boundary, summary], (message) =>
      invalidMessages.push(message),
    ),
    [summaryUuid],
  );
  assert.match(invalidMessages[0]!, /duplicated uuid/);
});

test("effectiveTreeNodeChain reports a parentUuid cycle and stops", () => {
  // Hand-corrupted file: two entries whose raw parentUuid pointers form a
  // cycle. The walk must terminate and surface the corruption.
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const cyclic = { ...u1, parentUuid: a1.uuid };
  const invalidMessages: string[] = [];
  assert.deepEqual(
    effectiveTreeNodeChain([cyclic, a1], (message) =>
      invalidMessages.push(message),
    ),
    [{ uuid: cyclic.uuid }, { uuid: a1.uuid }],
  );
  assert.match(invalidMessages[0]!, /cycle/);
});

// --- seedFromEntries -------------------------------------------------------

test("seedFromEntries on an empty file yields no values", () => {
  assert.deepEqual(seedFromEntries([], failOnInvalid), {});
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
  const seed = seedFromEntries([u1, a1, mode, u2, a2], failOnInvalid);
  assert.equal(seed.model, "claude-new");
  assert.equal(seed.claudeCodeVersion, "2.1.211");
  assert.equal(seed.permissionMode, "plan");
  assert.deepEqual(seed.leaf, { uuid: a2.uuid });
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
  const seed = seedFromEntries([u1, a1, u2, a2, boundary], failOnInvalid);
  assert.equal(seed.model, "claude-kept");
  assert.equal(seed.lastUsage?.input_tokens, 1);
  // The chain tip is a1's relinked occurrence under the boundary.
  assert.deepEqual(seed.leaf, {
    uuid: a1.uuid,
    viaBoundary: boundary.uuid,
  });
});

test("seedFromEntries leaf skips meta and sidechain entries", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const meta = { ...userEntry(a1.uuid, sid), isMeta: true };
  const seed = seedFromEntries([u1, a1, meta], failOnInvalid);
  assert.deepEqual(seed.leaf, { uuid: a1.uuid });
});

test("seedFromEntries: a trailing system entry does not become the leaf", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  // On the chain but never the fold's leaf: the stream only folds
  // user/assistant messages.
  const duration: SessionEntry = {
    uuid: uuid(),
    parentUuid: a1.uuid,
    type: "system",
    subtype: "turn_duration",
    sessionId: sid,
  };
  const seed = seedFromEntries([u1, a1, duration], failOnInvalid);
  assert.deepEqual(seed.leaf, { uuid: a1.uuid });
});

test("effectiveChain of a file ending in a bare empty-uuids boundary is []", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const boundary = boundaryEntry({ sessionId: sid, uuids: [], anchor: "own" });
  assert.deepEqual(effectiveChain([u1, a1, boundary], failOnInvalid), []);
});
