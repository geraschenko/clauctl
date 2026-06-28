/**
 * Fixtures follow the concrete examples in docs/specs/session-tree.md;
 * probe ids (e.g. P10) cite
 * docs/derisk/compact-boundary-injection/FINDINGS.md.
 */

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry } from "../session/file.ts";
import { buildTree } from "./build-tree.ts";

const uuid = (): UUID => randomUUID();

/** onInvalid sink for well-formed files: any diagnostic is a test failure. */
const failOnInvalid = (message: string): never => {
  throw new Error(`unexpected onInvalid: ${message}`);
};

// --- entry builders --------------------------------------------------------

function userEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "user",
    sessionId,
    message: { role: "user", content: "hi" },
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
    message: { role: "assistant", id: "msg_x", content: [] },
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

// --- native shapes (the spec's concrete examples) ---------------------------

test("up_to shape: block at the boundary's position, forward anchor, decorated post entries", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const e3 = userEntry(e2.uuid, sid);
  const e4 = assistantEntry(e3.uuid, sid);
  const summaryUuid = uuid();
  const b = boundaryEntry({
    sessionId: sid,
    uuids: [e3.uuid, e4.uuid],
    anchor: summaryUuid,
    logicalParentUuid: e4.uuid,
  });
  const s = summaryEntry(b.uuid, sid, summaryUuid);
  const e5 = userEntry(e4.uuid, sid);
  const tree = buildTree([e1, e2, e3, e4, b, s, e5], failOnInvalid);
  // Materialization order: raw rows at file position, the block at the
  // boundary's position (its anchor is a forward reference to the summary).
  assert.deepEqual(
    [...tree],
    [
      [e1.uuid, null],
      [e2.uuid, e1.uuid],
      [e3.uuid, e2.uuid],
      [e4.uuid, e3.uuid],
      [b.uuid, e4.uuid],
      [`${e3.uuid}@${b.uuid}`, summaryUuid],
      [`${e4.uuid}@${b.uuid}`, `${e3.uuid}@${b.uuid}`],
      [summaryUuid, b.uuid],
      [e5.uuid, `${e4.uuid}@${b.uuid}`],
    ],
  );
});

test("from shape: anchor-child rule places the summary under the relinked tail", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const e3 = userEntry(e2.uuid, sid);
  const e4 = assistantEntry(e3.uuid, sid);
  const x = boundaryEntry({
    sessionId: sid,
    uuids: [e1.uuid, e2.uuid],
    anchor: "own",
    logicalParentUuid: e2.uuid,
  });
  const t = summaryEntry(x.uuid, sid);
  const e5 = userEntry(t.uuid, sid);
  const tree = buildTree([e1, e2, e3, e4, x, t, e5], failOnInvalid);
  assert.deepEqual(
    [...tree],
    [
      [e1.uuid, null],
      [e2.uuid, e1.uuid],
      [e3.uuid, e2.uuid],
      [e4.uuid, e3.uuid],
      [x.uuid, e2.uuid],
      [`${e1.uuid}@${x.uuid}`, x.uuid],
      [`${e2.uuid}@${x.uuid}`, `${e1.uuid}@${x.uuid}`],
      [t.uuid, `${e2.uuid}@${x.uuid}`],
      [e5.uuid, t.uuid],
    ],
  );
});

test("stacked boundaries: only the latest boundary decorates", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const e3 = userEntry(e2.uuid, sid);
  const e4 = assistantEntry(e3.uuid, sid);
  const s1Uuid = uuid();
  const b1 = boundaryEntry({
    sessionId: sid,
    uuids: [e3.uuid, e4.uuid],
    anchor: s1Uuid,
    logicalParentUuid: e4.uuid,
  });
  const s1 = summaryEntry(b1.uuid, sid, s1Uuid);
  const e5 = userEntry(e4.uuid, sid);
  const e6 = assistantEntry(e5.uuid, sid);
  const s2Uuid = uuid();
  const b2 = boundaryEntry({
    sessionId: sid,
    uuids: [e5.uuid, e6.uuid],
    anchor: s2Uuid,
    logicalParentUuid: e6.uuid,
  });
  const s2 = summaryEntry(b2.uuid, sid, s2Uuid);
  const e7 = userEntry(e6.uuid, sid);
  const tree = buildTree(
    [e1, e2, e3, e4, b1, s1, e5, e6, b2, s2, e7],
    failOnInvalid,
  );
  assert.equal(tree.get(b1.uuid), e4.uuid);
  assert.equal(tree.get(e5.uuid), `${e4.uuid}@${b1.uuid}`);
  assert.equal(tree.get(e6.uuid), e5.uuid);
  // b2's logicalParent e6 is not preserved by b1 → raw anchor.
  assert.equal(tree.get(b2.uuid), e6.uuid);
  assert.equal(tree.get(`${e5.uuid}@${b2.uuid}`), s2Uuid);
  assert.equal(tree.get(`${e6.uuid}@${b2.uuid}`), `${e5.uuid}@${b2.uuid}`);
  // e7 resolves through b2, the latest boundary — not b1.
  assert.equal(tree.get(e7.uuid), `${e6.uuid}@${b2.uuid}`);
});

test("a boundary with no applicable relink ends the previous boundary's effect", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const b1 = boundaryEntry({
    sessionId: sid,
    uuids: [e2.uuid],
    anchor: "own",
    logicalParentUuid: e2.uuid,
  });
  const bare: SessionEntry & { uuid: UUID } = {
    uuid: uuid(),
    parentUuid: null,
    logicalParentUuid: e2.uuid,
    type: "system",
    subtype: "compact_boundary",
    sessionId: sid,
    compactMetadata: { trigger: "auto" },
  };
  // e3 parents onto e2, preserved by b1 — but bare is now the latest
  // boundary, so the reference stays raw.
  const e3 = userEntry(e2.uuid, sid);
  const tree = buildTree([e1, e2, b1, bare, e3], failOnInvalid);
  assert.equal(tree.get(e3.uuid), e2.uuid);
});

// --- corrupt shapes ----------------------------------------------------------

test("invalid relink: no block, boundary keeps its anchor, reported", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const b = boundaryEntry({
    sessionId: sid,
    uuids: [e2.uuid, uuid()],
    anchor: "own",
    logicalParentUuid: e2.uuid,
  });
  const invalidMessages: string[] = [];
  const tree = buildTree([e1, e2, b], (message) =>
    invalidMessages.push(message),
  );
  assert.deepEqual(
    [...tree],
    [
      [e1.uuid, null],
      [e2.uuid, e1.uuid],
      [b.uuid, e2.uuid],
    ],
  );
  assert.match(invalidMessages[0]!, /names no file entry/);
});

test("dangling up_to anchor: the block roots and is reported", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  // The anchor names a summary entry that never arrives.
  const b = boundaryEntry({
    sessionId: sid,
    uuids: [e1.uuid],
    anchor: uuid(),
    logicalParentUuid: e1.uuid,
  });
  const invalidMessages: string[] = [];
  const tree = buildTree([e1, b], (message) => invalidMessages.push(message));
  assert.equal(tree.get(`${e1.uuid}@${b.uuid}`), null);
  assert.match(invalidMessages[0]!, /names no tree occurrence/);
});

// --- duplicated raw uuids (re-persisted copies) ------------------------------

test("duplicate occurrence keys are first-wins and silent", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const bOld = boundaryEntry({
    sessionId: sid,
    uuids: [e2.uuid],
    anchor: "own",
    logicalParentUuid: e2.uuid,
  });
  const e3 = userEntry(e2.uuid, sid);
  const bNew = boundaryEntry({
    sessionId: sid,
    uuids: [e3.uuid],
    anchor: "own",
    logicalParentUuid: e3.uuid,
  });
  // Re-persisted copies (materialized parents) after the new boundary: the
  // copy's edge must not overwrite, and the re-appended old boundary must
  // not displace bNew as the latest boundary.
  const e1Copy = { ...e1, parentUuid: e2.uuid };
  const bOldCopy = { ...bOld };
  const e4 = userEntry(e3.uuid, sid);
  const tree = buildTree(
    [e1, e2, bOld, e3, bNew, e1Copy, bOldCopy, e4],
    failOnInvalid,
  );
  // The re-persist block contributes nothing: same tree as the file
  // without the duplicates.
  assert.deepEqual(
    tree,
    buildTree([e1, e2, bOld, e3, bNew, e4], failOnInvalid),
  );
  // One raw occurrence per uuid, first edge kept.
  assert.equal(tree.get(e1.uuid), null);
  // e4 resolves through bNew — the re-appended bOld did not become latest.
  assert.equal(tree.get(e4.uuid), `${e3.uuid}@${bNew.uuid}`);
  assert.equal(
    [...tree.keys()].filter((key) => key.startsWith(e1.uuid)).length,
    1, // exactly one raw occurrence — the copy emitted nothing
  );
});

// --- misc ---------------------------------------------------------------------

test("uuid-less entries get no occurrence", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const snapshot: SessionEntry = { type: "file-history-snapshot" };
  const tree = buildTree([snapshot, e1], failOnInvalid);
  assert.deepEqual([...tree], [[e1.uuid, null]]);
});

test("empty-uuids boundary (P10): no block, no decoration, stays anchored", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const wipe = boundaryEntry({
    sessionId: sid,
    uuids: [],
    anchor: "own",
    logicalParentUuid: e2.uuid,
  });
  const e3 = userEntry(e2.uuid, sid);
  const tree = buildTree([e1, e2, wipe, e3], failOnInvalid);
  assert.deepEqual(
    [...tree],
    [
      [e1.uuid, null],
      [e2.uuid, e1.uuid],
      [wipe.uuid, e2.uuid],
      [e3.uuid, e2.uuid],
    ],
  );
});
