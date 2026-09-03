/**
 * Fixtures follow the concrete examples in docs/specs/session-tree.md
 * (success criteria 2 and 3, and the worked examples).
 */

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import { entriesByUuid, type SessionEntry } from "../session/file.ts";
import { buildTree } from "./build-tree.ts";
import { toContextTree } from "./context-tree.ts";
import { toDisplayTree, type DisplayTree } from "./display-tree.ts";
import type { OnInvalid } from "./loader.ts";

const uuid = (): UUID => randomUUID();

const failOnInvalid = (message: string): never => {
  throw new Error(`unexpected onInvalid: ${message}`);
};

function displayTreeOf(
  entries: SessionEntry[],
  onInvalid: OnInvalid = failOnInvalid,
): DisplayTree {
  const fullTree = buildTree(entries, onInvalid);
  const byUuid = entriesByUuid(entries);
  return toDisplayTree(fullTree, toContextTree(fullTree, byUuid), byUuid);
}

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
    // A unique API message id per entry: distinct turns never share one in
    // real files, and a shared id means parallel-group linearization.
    message: {
      role: "assistant",
      id: `msg_${randomUUID().slice(0, 8)}`,
      content: [],
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
  const display = displayTreeOf(entries);
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
  const display = displayTreeOf(entries);
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

test("from-shape rewind with summary and a new turn: the summary forks off the rewind target, no boundary row", () => {
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
  const display = displayTreeOf(entries);
  const { parentMap } = display;
  // [1,2] reproduces raw 2's context: X has no row (its anchor is itself,
  // so it is not an up_to summary boundary); T, under the hidden block in
  // the full tree, displays under the branch point.
  assert.equal(parentMap.has(x.uuid), false);
  assert.deepEqual(display.nearestVisibleRow({ uuid: x.uuid }), {
    uuid: e2.uuid,
  });
  assert.equal(parentMap.get(t.uuid), e2.uuid);
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
  const display = displayTreeOf(entries);
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

test("stacked pure rewinds have no rows", () => {
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
  const display = displayTreeOf(entries);
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
  const { parentMap } = displayTreeOf(entries);
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
  const display = displayTreeOf(corruptEntries, () => {});
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
  const display = displayTreeOf(entries);
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

// --- parallel-group linearization (via the context tree) ---------------------

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

test("a parallel turn linearizes in file order; later forks off its rows stay forks", () => {
  // The readonly-fold shape: callB chains off callA, resultB is written
  // first, the continuation parents on resultA (the last-written result).
  const sid = uuid();
  const messageId = "msg_par";
  const u1 = userEntry(null, sid);
  const thinking: SessionEntry & { uuid: UUID } = {
    uuid: uuid(),
    parentUuid: u1.uuid,
    type: "assistant",
    sessionId: sid,
    message: {
      role: "assistant",
      id: messageId,
      content: [{ type: "thinking", thinking: "hm", signature: "sig" }],
    },
  };
  const callA = callEntry(thinking.uuid, sid, messageId, "toolu_A");
  const callB = callEntry(callA.uuid, sid, messageId, "toolu_B");
  const resultB = resultEntry(callB, sid);
  const resultA = resultEntry(callA, sid);
  const u2 = userEntry(resultA.uuid, sid);
  // Forks written after the group ended keep their raw parents; the
  // loader would splice resultA back in for forkOffResult (enumerated
  // divergence in docs/specs/context-tree.md, Edge cases).
  const forkOffResult = userEntry(resultB.uuid, sid);
  const forkOffCall = userEntry(callA.uuid, sid);
  const entries = [
    u1,
    thinking,
    callA,
    callB,
    resultB,
    resultA,
    u2,
    forkOffResult,
    forkOffCall,
  ];
  const display = displayTreeOf(entries);
  assert.deepEqual(
    [...display.parentMap],
    [
      [u1.uuid, null],
      [thinking.uuid, u1.uuid],
      [callA.uuid, thinking.uuid],
      [callB.uuid, callA.uuid],
      [resultB.uuid, callB.uuid],
      [resultA.uuid, resultB.uuid],
      [u2.uuid, resultA.uuid],
      [forkOffResult.uuid, resultB.uuid],
      [forkOffCall.uuid, callA.uuid],
    ],
  );
});

test("an interleaved same-id turn comes out identity", () => {
  // call → result → call → result, one message.id: later calls parent onto
  // already-arrived results (observed in real sessions, e.g. group gzs8Qh
  // in session 4d92f439). Chronological linearization restates the raw
  // chain.
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const callA = callEntry(u1.uuid, sid, "msg_inter", "toolu_A");
  const resultA = resultEntry(callA, sid);
  const callB = callEntry(resultA.uuid, sid, "msg_inter", "toolu_B");
  const resultB = resultEntry(callB, sid);
  const u2 = userEntry(resultB.uuid, sid);
  const entries = [u1, callA, resultA, callB, resultB, u2];
  const display = displayTreeOf(entries);
  assert.deepEqual(
    [...display.parentMap],
    [
      [u1.uuid, null],
      [callA.uuid, u1.uuid],
      [resultA.uuid, callA.uuid],
      [callB.uuid, resultA.uuid],
      [resultB.uuid, callB.uuid],
      [u2.uuid, resultB.uuid],
    ],
  );
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
  const display = displayTreeOf(entries, () => {});
  assert.equal(
    display.nearestVisibleRow({ uuid: e1.uuid, viaBoundary: b.uuid }),
    undefined,
  );
});

// --- context-tree placement (docs/specs/context-tree.md) ---------------------

/** A linear chain of `length` turns, user/assistant alternating. */
function linearChain(
  sessionId: UUID,
  length: number,
): (SessionEntry & { uuid: UUID })[] {
  const chain = [userEntry(null, sessionId)];
  for (let index = 1; index < length; index++) {
    const parent = chain[index - 1]!.uuid;
    chain.push(
      index % 2 === 0
        ? userEntry(parent, sessionId)
        : assistantEntry(parent, sessionId),
    );
  }
  return chain;
}

test("rewind-and-append shows the extension as relinked rows under the branch point, no boundary row (criterion 3)", () => {
  const sid = uuid();
  const chain = linearChain(sid, 8);
  const [e1, e2, e3, e4, e5, e6, e7, e8] = chain as (SessionEntry & {
    uuid: UUID;
  })[];
  const b = boundaryEntry({
    sessionId: sid,
    uuids: [e1!.uuid, e2!.uuid, e3!.uuid, e4!.uuid, e7!.uuid, e8!.uuid],
    anchor: "own",
    logicalParentUuid: e4!.uuid,
  });
  const e9 = userEntry(e8!.uuid, sid);
  const entries = [...chain, b, e9];
  const display = displayTreeOf(entries);
  const relinked = (entry: SessionEntry & { uuid: UUID }): string =>
    `${entry.uuid}@${b.uuid}`;
  assert.deepEqual(
    [...display.parentMap],
    [
      [e1!.uuid, null],
      [e2!.uuid, e1!.uuid],
      [e3!.uuid, e2!.uuid],
      [e4!.uuid, e3!.uuid],
      [e5!.uuid, e4!.uuid],
      [e6!.uuid, e5!.uuid],
      [e7!.uuid, e6!.uuid],
      [e8!.uuid, e7!.uuid],
      [relinked(e7!), e4!.uuid],
      [relinked(e8!), relinked(e7!)],
      [e9.uuid, relinked(e8!)],
    ],
  );
  // The hidden matched prefix and the boundary itself display as the
  // branch point.
  for (const entry of [e1!, e2!, e3!, e4!]) {
    assert.deepEqual(
      display.nearestVisibleRow({ uuid: entry.uuid, viaBoundary: b.uuid }),
      { uuid: e4!.uuid },
    );
  }
  assert.deepEqual(display.nearestVisibleRow({ uuid: b.uuid }), {
    uuid: e4!.uuid,
  });
});

test("an explicit list that reproduces no context is a new root with its block visible (criterion 4)", () => {
  const sid = uuid();
  const chain = linearChain(sid, 5);
  const [e1, e2, e3, e4, e5] = chain as (SessionEntry & { uuid: UUID })[];
  const b = boundaryEntry({
    sessionId: sid,
    uuids: [e3!.uuid, e4!.uuid, e5!.uuid],
    anchor: "own",
    logicalParentUuid: e5!.uuid,
  });
  const entries = [...chain, b];
  const { parentMap } = displayTreeOf(entries);
  const relinked = (entry: SessionEntry & { uuid: UUID }): string =>
    `${entry.uuid}@${b.uuid}`;
  assert.deepEqual(
    [...parentMap],
    [
      [e1!.uuid, null],
      [e2!.uuid, e1!.uuid],
      [e3!.uuid, e2!.uuid],
      [e4!.uuid, e3!.uuid],
      [e5!.uuid, e4!.uuid],
      [b.uuid, null],
      [relinked(e3!), b.uuid],
      [relinked(e4!), relinked(e3!)],
      [relinked(e5!), relinked(e4!)],
    ],
  );
});

test("a summary boundary reproducing a prefix of a hidden block is a new root (criterion 5)", () => {
  const sid = uuid();
  const [e1, e2, e3, e4] = linearChain(sid, 4) as (SessionEntry & {
    uuid: UUID;
  })[];
  const s1Uuid = uuid();
  const b1 = boundaryEntry({
    sessionId: sid,
    uuids: [e3!.uuid, e4!.uuid],
    anchor: s1Uuid,
    logicalParentUuid: e4!.uuid,
  });
  const s1 = summaryEntry(b1.uuid, sid, s1Uuid);
  const s2Uuid = uuid();
  const b2 = boundaryEntry({
    sessionId: sid,
    uuids: [s1Uuid, e3!.uuid],
    anchor: s2Uuid,
    logicalParentUuid: e4!.uuid,
  });
  const s2 = summaryEntry(b2.uuid, sid, s2Uuid);
  const entries = [e1!, e2!, e3!, e4!, b1, s1, b2, s2];
  const { parentMap } = displayTreeOf(entries);
  assert.equal(parentMap.get(b1.uuid), e4!.uuid);
  assert.equal(parentMap.get(b2.uuid), null);
  assert.equal(parentMap.get(s2Uuid), b2.uuid);
  // B2's block is visible under its summary.
  assert.equal(parentMap.get(`${s1Uuid}@${b2.uuid}`), s2Uuid);
  assert.equal(parentMap.get(`${e3!.uuid}@${b2.uuid}`), `${s1Uuid}@${b2.uuid}`);
});

test("a boundary can branch off a visible relinked row (criterion 6)", () => {
  const sid = uuid();
  const chain = linearChain(sid, 8);
  const [e1, e2, e3, e4, , , e7, e8] = chain as (SessionEntry & {
    uuid: UUID;
  })[];
  const b = boundaryEntry({
    sessionId: sid,
    uuids: [e1!.uuid, e2!.uuid, e3!.uuid, e4!.uuid, e7!.uuid, e8!.uuid],
    anchor: "own",
    logicalParentUuid: e4!.uuid,
  });
  const e9 = userEntry(e8!.uuid, sid);
  const e10 = assistantEntry(e9.uuid, sid);
  const b2 = boundaryEntry({
    sessionId: sid,
    uuids: [e1!.uuid, e2!.uuid, e3!.uuid, e4!.uuid, e7!.uuid, e10.uuid],
    anchor: "own",
    logicalParentUuid: e10.uuid,
  });
  const entries = [...chain, b, e9, e10, b2];
  const display = displayTreeOf(entries);
  assert.equal(
    display.parentMap.get(`${e10.uuid}@${b2.uuid}`),
    `${e7!.uuid}@${b.uuid}`,
  );
  assert.equal(display.parentMap.has(b2.uuid), false);
  assert.deepEqual(
    display.nearestVisibleRow({ uuid: e7!.uuid, viaBoundary: b2.uuid }),
    {
      uuid: e7!.uuid,
      viaBoundary: b.uuid,
    },
  );
});
