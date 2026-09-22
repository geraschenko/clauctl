/**
 * Test cases transliterated from the decompiled loader transform recorded
 * in docs/specs/session-tree.md "Ground truth"; probe ids (e.g. P10,
 * p14) cite docs/derisk/compact-boundary-injection/FINDINGS.md.
 */

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry } from "../session/file.ts";
import {
  compactBoundaryOf,
  effectiveParent,
  invalidRelinkReason,
  loadedContext,
  parentOfPreserved,
  type OnInvalid,
} from "./loader.ts";

const loadedContextUuids = (
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): UUID[] => loadedContext(entries, onInvalid).map((ref) => ref.uuid);

const uuid = (): UUID => randomUUID();

/** onInvalid sink for well-formed files: any diagnostic is a test failure. */
const failOnInvalid = (message: string): never => {
  throw new Error(`unexpected onInvalid: ${message}`);
};

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

function assistantEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "assistant",
    sessionId,
    message: {
      role: "assistant",
      id: `msg_${randomUUID().slice(0, 8)}`,
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

/** A boundary carrying no modeled metadata (no preservedMessages). */
function bareBoundaryEntry(sessionId: UUID): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid: null,
    logicalParentUuid: null,
    type: "system",
    subtype: "compact_boundary",
    sessionId,
    compactMetadata: { trigger: "auto" },
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

// --- parsing and rules -----------------------------------------------------

test("compactBoundaryOf parses preservedMessages and throws on a non-boundary", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const anchor = uuid();
  const boundary = boundaryEntry({ sessionId: sid, uuids: [u1.uuid], anchor });
  const parsed = compactBoundaryOf([u1, boundary][1]!);
  assert.deepEqual(parsed, {
    uuid: boundary.uuid,
    preservedMessages: { anchorUuid: anchor, uuids: [u1.uuid] },
  });
  assert.throws(
    () => compactBoundaryOf([u1, boundary][0]!),
    /not a uuid-bearing compact_boundary/,
  );
});

test("compactBoundaryOf: absent preservedMessages normalizes to a wipe", () => {
  const sid = uuid();
  const bare = bareBoundaryEntry(sid);
  assert.deepEqual(compactBoundaryOf([bare][0]!), {
    uuid: bare.uuid,
    preservedMessages: { anchorUuid: bare.uuid, uuids: [] },
  });
  // Legacy segment-only metadata normalizes the same way.
  const segmentOnly = {
    ...bareBoundaryEntry(sid),
    compactMetadata: { preservedSegment: { startUuid: uuid() } },
  };
  assert.deepEqual(compactBoundaryOf([segmentOnly][0]!), {
    uuid: segmentOnly.uuid,
    preservedMessages: { anchorUuid: segmentOnly.uuid, uuids: [] },
  });
});

test("compactBoundaryOf: present-but-malformed preservedMessages throws", () => {
  const sid = uuid();
  const noUuidsArray = {
    ...bareBoundaryEntry(sid),
    compactMetadata: { preservedMessages: { anchorUuid: uuid() } },
  };
  assert.throws(
    () => compactBoundaryOf([noUuidsArray][0]!),
    /malformed preservedMessages/,
  );
  const noAnchor = {
    ...bareBoundaryEntry(sid),
    compactMetadata: { preservedMessages: { uuids: [uuid()] } },
  };
  assert.throws(
    () => compactBoundaryOf([noAnchor][0]!),
    /malformed preservedMessages/,
  );
});

test("invalidRelinkReason: missing uuid, duplicate (fail-closed divergence, p14; see file comment), valid otherwise", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const fileUuids = new Set([u1.uuid]);
  const valid = compactBoundaryOf(
    [boundaryEntry({ sessionId: sid, uuids: [u1.uuid], anchor: "own" })][0]!,
  );
  assert.equal(invalidRelinkReason(fileUuids, valid), undefined);
  const missing = compactBoundaryOf(
    [
      boundaryEntry({
        sessionId: sid,
        uuids: [u1.uuid, uuid()],
        anchor: "own",
      }),
    ][0]!,
  );
  assert.match(
    invalidRelinkReason(fileUuids, missing)!,
    /names no earlier entry/,
  );
  const duplicated = compactBoundaryOf(
    [
      boundaryEntry({
        sessionId: sid,
        uuids: [u1.uuid, u1.uuid],
        anchor: "own",
      }),
    ][0]!,
  );
  assert.match(invalidRelinkReason(fileUuids, duplicated)!, /duplicated uuid/);
  // Deliberate divergence (like the duplicate rejection): an anchor among
  // the preserved uuids makes the binary's sequential passes self-parent
  // the chain, so the shape is rejected instead.
  const anchorInList = compactBoundaryOf(
    [
      boundaryEntry({
        sessionId: sid,
        uuids: [u1.uuid],
        anchor: u1.uuid,
      }),
    ][0]!,
  );
  assert.match(
    invalidRelinkReason(fileUuids, anchorInList)!,
    /anchorUuid appears/,
  );
  // Only entries written before the boundary count (deliberate fail-closed
  // divergence; see Edge cases in docs/specs/session-tree.md).
  assert.match(
    invalidRelinkReason(new Set(), valid)!,
    /names no earlier entry/,
  );
});

test("effectiveParent: the anchor-child rule, uuids[0] exempt", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const u2 = userEntry(u1.uuid, sid);
  const anchor = uuid();
  const boundary = compactBoundaryOf(
    [boundaryEntry({ sessionId: sid, uuids: [u1.uuid, u2.uuid], anchor })][0]!,
  );
  const anchorChild = userEntry(anchor, sid);
  assert.deepEqual(effectiveParent(boundary, anchorChild), {
    uuid: u2.uuid,
    viaBoundary: boundary.uuid,
  });
  // No relink in effect: the raw parent, always.
  assert.deepEqual(effectiveParent(undefined, anchorChild), { uuid: anchor });
  // uuids[0] keeps its raw parent even when it points at the anchor.
  assert.deepEqual(effectiveParent(boundary, { ...u1, parentUuid: anchor }), {
    uuid: anchor,
  });
  // A raw parent among the preserved uuids is its relinked occurrence.
  assert.deepEqual(effectiveParent(boundary, u2), {
    uuid: u1.uuid,
    viaBoundary: boundary.uuid,
  });
});

test("effectiveParent: a compact_boundary entry hangs off its logicalParentUuid", () => {
  const sid = uuid();
  const tip = uuid();
  const entry = boundaryEntry({
    sessionId: sid,
    uuids: [],
    anchor: "own",
    logicalParentUuid: tip,
  });
  assert.deepEqual(effectiveParent(undefined, entry), { uuid: tip });
  // A raw parent, when present, wins over the logical anchor.
  const rawParent = uuid();
  assert.deepEqual(
    effectiveParent(undefined, { ...entry, parentUuid: rawParent }),
    { uuid: rawParent },
  );
  // Non-boundary entries never use logicalParentUuid.
  const user = { ...userEntry(null, sid), logicalParentUuid: tip };
  assert.equal(effectiveParent(undefined, user), undefined);
});

test("parentOfPreserved: the chain-rewrite rule", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const u2 = userEntry(u1.uuid, sid);
  const anchor = uuid();
  const boundary = compactBoundaryOf(
    [boundaryEntry({ sessionId: sid, uuids: [u1.uuid, u2.uuid], anchor })][0]!,
  );
  assert.deepEqual(parentOfPreserved(boundary, 0), { uuid: anchor });
  assert.deepEqual(parentOfPreserved(boundary, 1), {
    uuid: u1.uuid,
    viaBoundary: boundary.uuid,
  });
  assert.throws(() => parentOfPreserved(boundary, 2), /no preserved uuid/);
});

// --- loadedContext: no transform -------------------------------------------

test("no boundary: the raw walk from the last entry (later branch wins)", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2a = userEntry(a1.uuid, sid); // abandoned branch
  const u2b = userEntry(a1.uuid, sid); // active branch (later in file)
  assert.deepEqual(loadedContextUuids([u1, a1, u2a, u2b], failOnInvalid), [
    u1.uuid,
    a1.uuid,
    u2b.uuid,
  ]);
});

test("a metadata-less boundary cuts like a wipe (named divergence)", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const bare = bareBoundaryEntry(sid);
  assert.deepEqual(loadedContextUuids([u1, a1, bare], failOnInvalid), []);
  // The binary loads a file with NO metadata-bearing boundary untransformed;
  // our normalization cuts at the last boundary instead (hand-crafted/legacy
  // files only — see Edge cases in docs/specs/session-tree.md). The
  // post-boundary turn's parent is cut, so it stands alone.
  const u2 = userEntry(a1.uuid, sid);
  assert.deepEqual(loadedContextUuids([u1, a1, bare, u2], failOnInvalid), [
    u2.uuid,
  ]);
});

// --- loadedContext: the cut without rules -----------------------------------

test("a trailing metadata-less boundary supersedes an earlier metadata boundary, preserving nothing", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const withMeta = boundaryEntry({
    sessionId: sid,
    uuids: [a1.uuid],
    anchor: "own",
  });
  const bare = bareBoundaryEntry(sid);
  const entries = [u1, a1, withMeta, bare];
  assert.deepEqual(loadedContextUuids(entries, failOnInvalid), []);
  // A post-boundary turn whose parent was cut reparents onto the wipe's
  // tail — the boundary itself — so it stands alone.
  const u2 = userEntry(a1.uuid, sid);
  assert.deepEqual(loadedContextUuids([...entries, u2], failOnInvalid), [
    u2.uuid,
  ]);
});

test("P10 (see file comment): a trailing valid empty-uuids boundary wipes the context", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const wipe = boundaryEntry({ sessionId: sid, uuids: [], anchor: "own" });
  assert.deepEqual(loadedContextUuids([u1, a1, wipe], failOnInvalid), []);
});

// --- loadedContext: invalid boundary degrades to a wipe -----------------------

test("a missing preserved uuid degrades the boundary to a wipe (named divergence)", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [a1.uuid, uuid()],
    anchor: summaryUuid,
  });
  const summary = summaryEntry(boundary.uuid, sid, summaryUuid);
  const invalidMessages: string[] = [];
  const collectInvalid = (message: string): void => {
    invalidMessages.push(message);
  };
  // No rewrite: the walk from the summary ends at the boundary.
  assert.deepEqual(loadedContext([u1, a1, boundary, summary], collectInvalid), [
    { uuid: summaryUuid },
  ]);
  assert.match(invalidMessages[0]!, /names no earlier entry/);
  // The binary aborts the transform and loads raw parents, which would give
  // [u1, a1, u2] here; degrading to a wipe cuts pre-boundary history
  // instead, so the turn reparents onto the boundary and stands alone.
  const u2 = userEntry(a1.uuid, sid);
  assert.deepEqual(
    loadedContextUuids([u1, a1, boundary, summary, u2], collectInvalid),
    [u2.uuid],
  );
});

test("duplicated uuid in the preserved list degrades the same way (fail-closed divergence; binary rewrites unchecked, p14; see file comment)", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [a1.uuid, a1.uuid],
    anchor: summaryUuid,
  });
  const summary = summaryEntry(boundary.uuid, sid, summaryUuid);
  const invalidMessages: string[] = [];
  assert.deepEqual(
    loadedContext([u1, a1, boundary, summary], (message) =>
      invalidMessages.push(message),
    ),
    [{ uuid: summaryUuid }],
  );
  assert.match(invalidMessages[0]!, /duplicated uuid/);
});

test("an anchor among the preserved uuids degrades the same way", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  // Every preserved uuid names a file entry — the anchor-in-list rejection
  // is the only invalid reason in play.
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u1.uuid, a1.uuid],
    anchor: a1.uuid,
  });
  const u2 = userEntry(a1.uuid, sid);
  const invalidMessages: string[] = [];
  // The wipe cuts pre-boundary history; the post-boundary turn reparents
  // onto the boundary and stands alone.
  assert.deepEqual(
    loadedContextUuids([u1, a1, boundary, u2], (message) =>
      invalidMessages.push(message),
    ),
    [u2.uuid],
  );
  assert.match(invalidMessages[0]!, /anchorUuid appears/);
});

// --- loadedContext: the rules -------------------------------------------------

test("up_to shape: chain rewrite hangs the preserved uuids under the summary; the tail is the leaf", () => {
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
  // The file ends at the summary — the anchor — so the leaf is the
  // preserved tail: the preserved uuids are PRESENTED after the summary.
  assert.deepEqual(loadedContext(base, failOnInvalid), [
    { uuid: summaryUuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
    { uuid: a2.uuid, viaBoundary: boundary.uuid },
  ]);
  // A post-boundary turn parents onto the preserved tail and chains on.
  const u3 = userEntry(a2.uuid, sid);
  assert.deepEqual(loadedContextUuids([...base, u3], failOnInvalid), [
    summaryUuid,
    u2.uuid,
    a2.uuid,
    u3.uuid,
  ]);
});

test("from shape: the anchor-child rule reparents the summary onto the preserved tail; the summary ref is bare", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2 = userEntry(a1.uuid, sid);
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  const summary = summaryEntry(boundary.uuid, sid);
  // u2 is abandoned by the rewind and cut away.
  assert.deepEqual(
    loadedContext([u1, a1, u2, boundary, summary], failOnInvalid),
    [
      { uuid: u1.uuid, viaBoundary: boundary.uuid },
      { uuid: a1.uuid, viaBoundary: boundary.uuid },
      { uuid: summary.uuid },
    ],
  );
});

test("no-summary boundary: the context is exactly the preserved uuids", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2 = userEntry(a1.uuid, sid);
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u2.uuid],
    anchor: "own",
  });
  assert.deepEqual(loadedContext([u1, a1, u2, boundary], failOnInvalid), [
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
  ]);
});

test("stacked boundaries: the last one wins entirely", () => {
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
  assert.deepEqual(loadedContextUuids([u1, a1, first, second], failOnInvalid), [
    u1.uuid,
    a1.uuid,
  ]);
});

test("a truncated file ignores later boundaries", () => {
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
  assert.deepEqual(loadedContextUuids(entries.slice(0, 2), failOnInvalid), [
    u1.uuid,
    a1.uuid,
  ]);
  assert.deepEqual(loadedContextUuids(entries, failOnInvalid), [a1.uuid]);
});

test("orphan reparent lands a surviving turn on the preserved tail", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [a1.uuid],
    anchor: "own",
  });
  // Hand-crafted: a post-boundary turn parenting onto the deleted u1.
  const u2 = userEntry(u1.uuid, sid);
  assert.deepEqual(loadedContext([u1, a1, boundary, u2], failOnInvalid), [
    { uuid: a1.uuid, viaBoundary: boundary.uuid },
    { uuid: u2.uuid },
  ]);
});

// --- loadedContext: leaf selection ------------------------------------------

test("the leaf climb starts at the last file entry and skips trailing system entries", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u1.uuid, a1.uuid],
    anchor: summaryUuid,
  });
  const summary = summaryEntry(boundary.uuid, sid, summaryUuid);
  // Two branches off the preserved tail: the later one wins.
  const u2a = userEntry(a1.uuid, sid);
  const u2b = userEntry(a1.uuid, sid);
  // A trailing system entry: the climb finds the nearest user/assistant.
  const duration: SessionEntry = {
    uuid: uuid(),
    parentUuid: u2b.uuid,
    type: "system",
    subtype: "turn_duration",
    sessionId: sid,
  };
  assert.deepEqual(
    loadedContextUuids(
      [u1, a1, boundary, summary, u2a, u2b, duration],
      failOnInvalid,
    ),
    [summaryUuid, u1.uuid, a1.uuid, u2b.uuid],
  );
});

// --- loadedContext: duplicated raw uuids --------------------------------------

test("duplicated raw uuids (re-persisted copies) are tolerated silently, last-wins", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2 = userEntry(a1.uuid, sid);
  const a2 = assistantEntry(u2.uuid, sid);
  // The CLI re-persists dropped history (materialized parents) right before
  // a later /compact; the new boundary then cuts the copies away.
  const u1Copy = { ...u1 };
  const a1Copy = { ...a1 };
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u2.uuid, a2.uuid],
    anchor: summaryUuid,
  });
  const summary = summaryEntry(boundary.uuid, sid, summaryUuid);
  assert.deepEqual(
    loadedContext(
      [u1, a1, u2, a2, u1Copy, a1Copy, boundary, summary],
      failOnInvalid,
    ),
    [
      { uuid: summaryUuid },
      { uuid: u2.uuid, viaBoundary: boundary.uuid },
      { uuid: a2.uuid, viaBoundary: boundary.uuid },
    ],
  );
});

// --- loadedContext: stage 3 (parallel-group expansion) -----------------------

/** An assistant tool-call entry; parallel calls share apiMessageId. */
function callEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
  apiMessageId: string,
  callId: string,
  timestamp: string,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "assistant",
    sessionId,
    timestamp,
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
  timestamp: string,
): SessionEntry & { uuid: UUID } {
  const callId = (call.message as { content: { id: string }[] }).content[0]!.id;
  return {
    uuid: uuid(),
    parentUuid: call.uuid,
    type: "user",
    sessionId,
    timestamp,
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
  timestamp: string,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "assistant",
    sessionId,
    timestamp,
    message: {
      role: "assistant",
      id: apiMessageId,
      content: [{ type: "thinking", thinking: "hm", signature: "sig" }],
    },
  };
}

/** The readonly-fold shape (parity fixture readonly-fold.jsonl, turn
 *  xbYKZyKk): thinking → callA; callB chains off callA; resultB is written
 *  FIRST (child of callB), resultA last; the continuation parents on
 *  resultA, the last-written result. The walk alone loses callB and
 *  resultB. */
function parallelTurnFixture(): {
  entries: SessionEntry[];
  uuids: Record<
    "u1" | "thinking" | "callA" | "callB" | "resultA" | "resultB" | "u2",
    UUID
  >;
} {
  const sid = uuid();
  const messageId = "msg_parallel";
  const u1 = userEntry(null, sid);
  const thinking = thinkingEntry(u1.uuid, sid, messageId, "T1");
  const callA = callEntry(thinking.uuid, sid, messageId, "toolu_A", "T2");
  const callB = callEntry(callA.uuid, sid, messageId, "toolu_B", "T3");
  const resultB = resultEntry(callB, sid, "T4");
  const resultA = resultEntry(callA, sid, "T5");
  const u2 = userEntry(resultA.uuid, sid);
  return {
    entries: [u1, thinking, callA, callB, resultB, resultA, u2],
    uuids: {
      u1: u1.uuid,
      thinking: thinking.uuid,
      callA: callA.uuid,
      callB: callB.uuid,
      resultA: resultA.uuid,
      resultB: resultB.uuid,
      u2: u2.uuid,
    },
  };
}

test("stage 3: the off-path call and result splice after the group's last on-chain assistant", () => {
  const { entries, uuids } = parallelTurnFixture();
  const { u1, thinking, callA, callB, resultA, resultB, u2 } = uuids;
  assert.deepEqual(loadedContextUuids(entries, failOnInvalid), [
    u1,
    thinking,
    callA,
    callB,
    resultB,
    resultA,
    u2,
  ]);
  // `.at(-1)` leaf invariant: the chain tip is the file's last entry.
  assert.equal(loadedContextUuids(entries, failOnInvalid).at(-1), u2);
});

test("stage 3: a post-boundary parallel turn recovers as bare refs after the preserved chain", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [a1.uuid],
    anchor: "own",
  });
  const messageId = "msg_postboundary";
  const thinking = thinkingEntry(a1.uuid, sid, messageId, "T1");
  const callA = callEntry(thinking.uuid, sid, messageId, "toolu_A", "T2");
  const callB = callEntry(callA.uuid, sid, messageId, "toolu_B", "T3");
  const resultB = resultEntry(callB, sid, "T4");
  const resultA = resultEntry(callA, sid, "T5");
  const u2 = userEntry(resultA.uuid, sid);
  assert.deepEqual(
    loadedContext(
      [u1, a1, boundary, thinking, callA, callB, resultB, resultA, u2],
      failOnInvalid,
    ),
    [
      { uuid: a1.uuid, viaBoundary: boundary.uuid },
      { uuid: thinking.uuid },
      { uuid: callA.uuid },
      { uuid: callB.uuid },
      { uuid: resultB.uuid },
      { uuid: resultA.uuid },
      { uuid: u2.uuid },
    ],
  );
});

test("stage 3: a pair cut away by a boundary is NOT recovered (p20-part1; see file comment)", () => {
  // A preserved list may omit a COMPLETE call/result pair of a parallel turn:
  // the cut removes the pair from the recovery universe, so the
  // exclusion is presented as-is.
  const { entries, uuids } = parallelTurnFixture();
  const sid = entries[0]!.sessionId as UUID;
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [uuids.u1, uuids.thinking, uuids.callA, uuids.resultA],
    anchor: "own",
  });
  const refs = loadedContext([...entries, boundary], failOnInvalid);
  assert.deepEqual(
    refs,
    [uuids.u1, uuids.thinking, uuids.callA, uuids.resultA].map((entryUuid) => ({
      uuid: entryUuid,
      viaBoundary: boundary.uuid,
    })),
  );
});

test("stage 3: a sibling cut away by a boundary is NOT recovered (p20-part1; see file comment)", () => {
  const sid = uuid();
  const messageId = "msg_excluded";
  const u1 = userEntry(null, sid);
  const thinking = thinkingEntry(u1.uuid, sid, messageId, "T1");
  const call = callEntry(thinking.uuid, sid, messageId, "toolu_X", "T2");
  const result = resultEntry(call, sid, "T3");
  // The list deliberately omits the thinking sibling: the loader
  // presents the exclusion as-is because the cut removes the sibling from
  // the recovery universe.
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [call.uuid, result.uuid],
    anchor: "own",
  });
  assert.deepEqual(
    loadedContextUuids([u1, thinking, call, result, boundary], failOnInvalid),
    [call.uuid, result.uuid],
  );
});

test("stage 3: single-call and interleaved same-id turns pass through untouched", () => {
  const sid = uuid();
  // Single call.
  const u1 = userEntry(null, sid);
  const call = callEntry(u1.uuid, sid, "msg_single", "toolu_S", "T1");
  const result = resultEntry(call, sid, "T2");
  const u2 = userEntry(result.uuid, sid);
  assert.deepEqual(loadedContextUuids([u1, call, result, u2], failOnInvalid), [
    u1.uuid,
    call.uuid,
    result.uuid,
    u2.uuid,
  ]);
  // Interleaved: call → result → call → result, one message.id, fully
  // on-chain (a later call parents onto the already-arrived result —
  // observed in real sessions, e.g. group gzs8Qh in session 4d92f439).
  const callA = callEntry(u1.uuid, sid, "msg_inter", "toolu_IA", "T1");
  const resultA = resultEntry(callA, sid, "T2");
  const callB = callEntry(resultA.uuid, sid, "msg_inter", "toolu_IB", "T3");
  const resultB = resultEntry(callB, sid, "T4");
  const u3 = userEntry(resultB.uuid, sid);
  assert.deepEqual(
    loadedContextUuids([u1, callA, resultA, callB, resultB, u3], failOnInvalid),
    [u1.uuid, callA.uuid, resultA.uuid, callB.uuid, resultB.uuid, u3.uuid],
  );
});

// --- loadedContext: stage 4 (resume sanitization) ----------------------------

test("stage 4: a result-less tool_use entry is dropped (p20-kill0, killed turn; see file comment)", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const call = callEntry(a1.uuid, sid, "msg_killed", "toolu_K", "T1");
  assert.deepEqual(loadedContextUuids([u1, a1, call], failOnInvalid), [
    u1.uuid,
    a1.uuid,
  ]);
  // Two calls, zero results: both dropped, the text sibling kept.
  const text = {
    ...assistantEntry(u1.uuid, sid),
    message: {
      role: "assistant",
      id: "msg_killed2",
      content: [{ type: "text", text: "ok" }],
    },
  };
  const callA = callEntry(text.uuid, sid, "msg_killed2", "toolu_A", "T1");
  const callB = callEntry(callA.uuid, sid, "msg_killed2", "toolu_B", "T2");
  assert.deepEqual(
    loadedContextUuids([u1, text, callA, callB], failOnInvalid),
    [u1.uuid, text.uuid],
  );
});

test("stage 4: an interrupted trailing turn keeps its unanswered calls (p20-kill1, healed; see file comment); a later turn makes them dead (p20-kill1-later)", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const callA = callEntry(u1.uuid, sid, "msg_partial", "toolu_A", "T1");
  const callB = callEntry(callA.uuid, sid, "msg_partial", "toolu_B", "T2");
  const resultA = resultEntry(callA, sid, "T3");
  assert.deepEqual(
    loadedContextUuids([u1, callA, callB, resultA], failOnInvalid),
    [u1.uuid, callA.uuid, callB.uuid, resultA.uuid],
  );
  const u2 = userEntry(resultA.uuid, sid);
  assert.deepEqual(
    loadedContextUuids([u1, callA, callB, resultA, u2], failOnInvalid),
    [u1.uuid, callA.uuid, resultA.uuid, u2.uuid],
  );
});

test("stage 4: a thinking-only turn is dropped whole (p19; see file comment), including one reduced by the call drop", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  // Pure thinking-only turn.
  const lone = thinkingEntry(u1.uuid, sid, "msg_lone", "T1");
  assert.deepEqual(loadedContextUuids([u1, lone], failOnInvalid), [u1.uuid]);
  // thinking + result-less call: the call drop reduces the group to
  // thinking-only, which then drops too.
  const thinking = thinkingEntry(u1.uuid, sid, "msg_reduced", "T1");
  const call = callEntry(thinking.uuid, sid, "msg_reduced", "toolu_R", "T2");
  assert.deepEqual(loadedContextUuids([u1, thinking, call], failOnInvalid), [
    u1.uuid,
  ]);
  // A thinking sibling of a COMPLETED call stays (the group is not
  // thinking-only).
  const thinking2 = thinkingEntry(u1.uuid, sid, "msg_kept", "T1");
  const call2 = callEntry(thinking2.uuid, sid, "msg_kept", "toolu_C", "T2");
  const result2 = resultEntry(call2, sid, "T3");
  assert.deepEqual(
    loadedContextUuids([u1, thinking2, call2, result2], failOnInvalid),
    [u1.uuid, thinking2.uuid, call2.uuid, result2.uuid],
  );
});

// --- loadedContext: corruption -------------------------------------------------

test("a boundary with a raw parentUuid is reported as producer drift", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const boundary = {
    ...boundaryEntry({ sessionId: sid, uuids: [a1.uuid], anchor: "own" }),
    parentUuid: a1.uuid,
  };
  const invalidMessages: string[] = [];
  // The transform itself still runs — the banner is a drift alarm, not
  // a degradation.
  assert.deepEqual(
    loadedContextUuids([u1, a1, boundary], (message) =>
      invalidMessages.push(message),
    ),
    [a1.uuid],
  );
  assert.match(invalidMessages[0]!, /raw parentUuid/);
});

test("a parentUuid cycle is reported and the walk stops", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const cyclic = { ...u1, parentUuid: a1.uuid };
  const invalidMessages: string[] = [];
  assert.deepEqual(
    loadedContext([cyclic, a1], (message) => invalidMessages.push(message)),
    [{ uuid: cyclic.uuid }, { uuid: a1.uuid }],
  );
  assert.match(invalidMessages[0]!, /cycle/);
});
