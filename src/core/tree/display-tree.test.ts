/**
 * Fixtures follow the concrete examples in docs/specs/session-tree.md
 * (success criteria 2 and 3, and the worked examples).
 */

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry } from "../session-file.ts";
import { buildTree } from "./build-tree.ts";
import { toDisplayTree } from "./display-tree.ts";

const uuid = (): UUID => randomUUID();

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

// --- the spec's concrete examples --------------------------------------------

test("up_to compaction of a linear conversation renders linearly (criterion 2)", () => {
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
  const entries = [e1, e2, e3, e4, b, s, e5];
  const display = toDisplayTree(buildTree(entries, failOnInvalid), entries);
  // One straight line: 1→2→3→4→B→S→5; the relinked rows are hidden.
  assert.deepEqual(
    [...display.parentMap],
    [
      [e1.uuid, null],
      [e2.uuid, e1.uuid],
      [e3.uuid, e2.uuid],
      [e4.uuid, e3.uuid],
      [b.uuid, e4.uuid],
      [summaryUuid, b.uuid],
      [e5.uuid, summaryUuid],
    ],
  );
  // The hidden relinked rows display as the summary row.
  for (const hiddenUuid of [e3.uuid, e4.uuid]) {
    assert.deepEqual(
      display.nearestVisibleRow({ uuid: hiddenUuid, viaBoundary: b.uuid }),
      { uuid: summaryUuid },
    );
  }
  // A visible ref displays as itself.
  assert.deepEqual(display.nearestVisibleRow({ uuid: e5.uuid }), {
    uuid: e5.uuid,
  });
});

test("stacked compactions render as one straight line (criterion 2)", () => {
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
  const entries = [e1, e2, e3, e4, b1, s1, e5, e6, b2, s2, e7];
  const display = toDisplayTree(buildTree(entries, failOnInvalid), entries);
  assert.deepEqual(
    [...display.parentMap],
    [
      [e1.uuid, null],
      [e2.uuid, e1.uuid],
      [e3.uuid, e2.uuid],
      [e4.uuid, e3.uuid],
      [b1.uuid, e4.uuid],
      [s1Uuid, b1.uuid],
      [e5.uuid, s1Uuid],
      [e6.uuid, e5.uuid],
      [b2.uuid, e6.uuid],
      [s2Uuid, b2.uuid],
      [e7.uuid, s2Uuid],
    ],
  );
  // Each boundary's hidden block displays as its own summary row.
  for (const [hiddenUuid, boundaryUuid, rowUuid] of [
    [e3.uuid, b1.uuid, s1Uuid],
    [e4.uuid, b1.uuid, s1Uuid],
    [e5.uuid, b2.uuid, s2Uuid],
    [e6.uuid, b2.uuid, s2Uuid],
  ] as const) {
    assert.deepEqual(
      display.nearestVisibleRow({
        uuid: hiddenUuid,
        viaBoundary: boundaryUuid,
      }),
      { uuid: rowUuid },
    );
  }
});

test("from-shape rewind with summary and a new turn: boundary forks off the rewind target", () => {
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
  const entries = [e1, e2, e3, e4, x, t, e5];
  const { parentMap } = toDisplayTree(
    buildTree(entries, failOnInvalid),
    entries,
  );
  // X forks off raw 2 (rule 1); T resolves to X through the hidden block.
  assert.equal(parentMap.get(x.uuid), e2.uuid);
  assert.equal(parentMap.get(t.uuid), x.uuid);
  assert.equal(parentMap.get(e5.uuid), t.uuid);
  // The abandoned branch stays visible.
  assert.equal(parentMap.get(e3.uuid), e2.uuid);
  assert.equal(parentMap.get(e4.uuid), e3.uuid);
});

test("boundary rewind with no summary and no new turn is invisible (criterion 3)", () => {
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
  const entries = [e1, e2, e3, e4, x];
  const display = toDisplayTree(buildTree(entries, failOnInvalid), entries);
  // Indistinguishable from a plain tail rewind: 1 → 2 → 3 → 4, no X row.
  assert.deepEqual(
    [...display.parentMap],
    [
      [e1.uuid, null],
      [e2.uuid, e1.uuid],
      [e3.uuid, e2.uuid],
      [e4.uuid, e3.uuid],
    ],
  );
  // The leaf ref 2@X displays as visible row 2 for the marker.
  assert.deepEqual(
    display.nearestVisibleRow({ uuid: e2.uuid, viaBoundary: x.uuid }),
    { uuid: e2.uuid },
  );
  assert.deepEqual(
    display.nearestVisibleRow({ uuid: e1.uuid, viaBoundary: x.uuid }),
    { uuid: e2.uuid },
  );
  assert.deepEqual(display.nearestVisibleRow({ uuid: x.uuid }), {
    uuid: e2.uuid,
  });
});

test("stacked no-descendant boundaries cascade away (rule 3 fixpoint)", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  // Two navigation rewinds in a row, neither followed by a turn.
  const x1 = boundaryEntry({
    sessionId: sid,
    uuids: [e1.uuid, e2.uuid],
    anchor: "own",
    logicalParentUuid: e2.uuid,
  });
  const x2 = boundaryEntry({
    sessionId: sid,
    uuids: [e1.uuid],
    anchor: "own",
    logicalParentUuid: e2.uuid,
  });
  const entries = [e1, e2, x1, x2];
  const display = toDisplayTree(buildTree(entries, failOnInvalid), entries);
  assert.deepEqual(
    [...display.parentMap],
    [
      [e1.uuid, null],
      [e2.uuid, e1.uuid],
    ],
  );
  assert.deepEqual(display.nearestVisibleRow({ uuid: x1.uuid }), {
    uuid: e2.uuid,
  });
  assert.deepEqual(display.nearestVisibleRow({ uuid: x2.uuid }), {
    uuid: e1.uuid,
  });
});

test("boundaries with no applicable relink stay visible in place", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  // A context wipe is a real event: empty preserved list, visible.
  const wipe = boundaryEntry({
    sessionId: sid,
    uuids: [],
    anchor: "own",
    logicalParentUuid: e2.uuid,
  });
  const entries = [e1, e2, wipe];
  const { parentMap } = toDisplayTree(
    buildTree(entries, failOnInvalid),
    entries,
  );
  assert.equal(parentMap.get(wipe.uuid), e2.uuid);
  assert.equal(parentMap.size, 3);

  // An invalid relink keeps its boundary visible too.
  const invalid = boundaryEntry({
    sessionId: sid,
    uuids: [uuid()],
    anchor: "own",
    logicalParentUuid: e2.uuid,
  });
  const corruptEntries = [e1, e2, invalid];
  const display = toDisplayTree(
    buildTree(corruptEntries, () => {}),
    corruptEntries,
  );
  assert.equal(display.parentMap.get(invalid.uuid), e2.uuid);
});

test("a duplicated boundary uuid is first-wins even when the first copy is metadata-less", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const bUuid = uuid();
  const metadataless: SessionEntry & { uuid: UUID } = {
    uuid: bUuid,
    parentUuid: null,
    logicalParentUuid: e2.uuid,
    type: "system",
    subtype: "compact_boundary",
    sessionId: sid,
    compactMetadata: { trigger: "auto" },
  };
  // A divergent later copy (valid non-empty relink) — buildTree skips it
  // entirely, so the display transform must not treat B as a candidate.
  const validCopy: SessionEntry = {
    ...metadataless,
    compactMetadata: {
      trigger: "manual",
      preservedMessages: {
        anchorUuid: bUuid,
        uuids: [e1.uuid, e2.uuid],
        allUuids: [e1.uuid, e2.uuid],
      },
    },
  };
  const entries = [e1, e2, metadataless, validCopy];
  const display = toDisplayTree(buildTree(entries, failOnInvalid), entries);
  // The metadata-less first occurrence governs: B stays visible in place.
  assert.deepEqual(
    [...display.parentMap],
    [
      [e1.uuid, null],
      [e2.uuid, e1.uuid],
      [bUuid, e2.uuid],
    ],
  );
  assert.deepEqual(display.nearestVisibleRow({ uuid: bUuid }), { uuid: bUuid });
});

test("a rootless hidden chain displays no row", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  // Dangling anchor: the block roots in the full tree; its rows have no
  // visible ancestor.
  const b = boundaryEntry({
    sessionId: sid,
    uuids: [e1.uuid],
    anchor: uuid(),
    logicalParentUuid: e1.uuid,
  });
  const entries = [e1, b];
  const display = toDisplayTree(
    buildTree(entries, () => {}),
    entries,
  );
  assert.equal(
    display.nearestVisibleRow({ uuid: e1.uuid, viaBoundary: b.uuid }),
    undefined,
  );
});
