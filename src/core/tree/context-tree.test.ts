/**
 * Fixtures follow docs/specs/context-tree.md: the property test of
 * success criterion 1 (contextAt ≡ loadedContext at settled prefixes) and
 * the matching examples.
 */

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import { entriesByUuid, type SessionEntry } from "../session/file.ts";
import { buildTree } from "./build-tree.ts";
import { contextAtMismatches } from "./context-check.ts";
import { matchPreservedList, toContextTree } from "./context-tree.ts";
import { loadedContext } from "./loader.ts";
import { formatTreeNodeRef } from "./nodes.ts";

const uuid = (): UUID => randomUUID();

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
    message: {
      role: "assistant",
      id: `msg_${randomUUID().slice(0, 8)}`,
      content: [{ type: "text", text: "ok" }],
    },
  };
}

function systemEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "system",
    subtype: "turn_duration",
    sessionId,
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

// --- criterion 1: contextAt ≡ loadedContext at settled prefixes --------------

function assertContextAtMatchesLoader(entries: SessionEntry[]): void {
  const { checked, mismatches } = contextAtMismatches(entries);
  assert.ok(checked > 0);
  assert.deepEqual(mismatches, []);
}

/** Two turns, an up_to compaction of [3,4] with summary S, two more turns,
 *  a second compaction of [5,6] with S2, a final turn. */
function stackedCompactionsFixture(): SessionEntry[] {
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
  return [e1, e2, e3, e4, b1, s1, e5, e6, b2, s2, e7];
}

/** Four turns with a turn_duration entry, a no-summary rewind to 2 that
 *  keeps the system entry, a new turn on the rewound context, then a
 *  from-shape summary rewind to that turn. */
function rewindsFixture(): SessionEntry[] {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const d2 = systemEntry(e2.uuid, sid);
  const e3 = userEntry(d2.uuid, sid);
  const e4 = assistantEntry(e3.uuid, sid);
  const x = boundaryEntry({
    sessionId: sid,
    uuids: [e1.uuid, e2.uuid, d2.uuid],
    anchor: "own",
    logicalParentUuid: e4.uuid,
  });
  const e5 = userEntry(d2.uuid, sid);
  const e6 = assistantEntry(e5.uuid, sid);
  const y = boundaryEntry({
    sessionId: sid,
    uuids: [e1.uuid, e2.uuid, d2.uuid, e5.uuid, e6.uuid],
    anchor: "own",
    logicalParentUuid: e6.uuid,
  });
  const t = summaryEntry(y.uuid, sid);
  const e7 = userEntry(t.uuid, sid);
  return [e1, e2, d2, e3, e4, x, e5, e6, y, t, e7];
}

/** The readonly-fold parallel turn (docs/specs/session-tree.md): thinking
 *  → callA; callB chains off callA; resultB is written first, resultA
 *  last; the continuation parents on resultA. Then a killed turn (a call
 *  with no result, the next prompt parented on it) and a thinking-only
 *  turn the next prompt parents on. */
function toolTurnsFixture(): SessionEntry[] {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const thinking = thinkingEntry(u1.uuid, sid, "msg_parallel");
  const callA = callEntry(thinking.uuid, sid, "msg_parallel", "toolu_A", "T2");
  const callB = callEntry(callA.uuid, sid, "msg_parallel", "toolu_B", "T3");
  const resultB = resultEntry(callB, sid, "T4");
  const resultA = resultEntry(callA, sid, "T5");
  const u2 = userEntry(resultA.uuid, sid);
  const killed = callEntry(u2.uuid, sid, "msg_killed", "toolu_K", "T6");
  const u3 = userEntry(killed.uuid, sid);
  const thinkingOnly = thinkingEntry(u3.uuid, sid, "msg_thinking");
  const u4 = userEntry(thinkingOnly.uuid, sid);
  const a4 = assistantEntry(u4.uuid, sid);
  return [
    u1,
    thinking,
    callA,
    callB,
    resultB,
    resultA,
    u2,
    killed,
    u3,
    thinkingOnly,
    u4,
    a4,
  ];
}

test("criterion 1: contextAt reproduces loadedContext at every settled prefix", () => {
  assertContextAtMatchesLoader(stackedCompactionsFixture());
  assertContextAtMatchesLoader(rewindsFixture());
  assertContextAtMatchesLoader(toolTurnsFixture());
});

test("criterion 1 divergences on corrupt files, enumerated", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const e3 = userEntry(e2.uuid, sid);

  // A re-persisted copy of 2 with a different parent: buildTree is
  // first-wins, the loader last-wins (docs/specs/session-tree.md, Edge
  // cases).
  const rewrittenCopy: SessionEntry = { ...e2, parentUuid: null };
  const duplicated = [e1, e2, rewrittenCopy, e3];
  assert.deepEqual(
    toContextTree(
      buildTree(duplicated, () => {}),
      entriesByUuid(duplicated),
    )
      .contextAt({ uuid: e3.uuid })
      .map((ref) => ref.uuid),
    [e1.uuid, e2.uuid, e3.uuid],
  );
  assert.deepEqual(
    loadedContext(duplicated, () => {}).map((ref) => ref.uuid),
    [e2.uuid, e3.uuid],
  );

  // An invalid boundary (unknown preserved uuid): buildTree skips the
  // relink, the loader degrades it to a wipe.
  const invalid = boundaryEntry({
    sessionId: sid,
    uuids: [uuid()],
    anchor: "own",
    logicalParentUuid: e2.uuid,
  });
  const wiped = [e1, e2, invalid, e3];
  assert.deepEqual(
    toContextTree(
      buildTree(wiped, () => {}),
      entriesByUuid(wiped),
    )
      .contextAt({ uuid: e3.uuid })
      .map((ref) => ref.uuid),
    [e1.uuid, e2.uuid, e3.uuid],
  );
  assert.deepEqual(
    loadedContext(wiped, () => {}).map((ref) => ref.uuid),
    [e3.uuid],
  );
});

test("contextAt throws on an unknown ref", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const contextTree = toContextTree(
    buildTree([e1], () => {}),
    entriesByUuid([e1]),
  );
  assert.throws(
    () => contextTree.contextAt({ uuid: uuid() }),
    /not a context-tree occurrence/,
  );
});

// --- matching: the spec's examples -------------------------------------------

/** The context tree of `entries` and the materialized set at the moment
 *  the display pass reaches `boundary` (every full-tree occurrence before
 *  its row). */
function matchingInputs(
  entries: SessionEntry[],
  boundary: SessionEntry & { uuid: UUID },
): {
  contextTree: ReturnType<typeof toContextTree>;
  materialized: Set<string>;
} {
  const fullTree = buildTree(entries, () => {});
  const materialized = new Set<string>();
  for (const id of fullTree.keys()) {
    if (id === boundary.uuid) {
      break;
    }
    materialized.add(id);
  }
  return {
    contextTree: toContextTree(fullTree, entriesByUuid(entries)),
    materialized,
  };
}

test("native compact: the relaxed start rule steps 3 → 4; pure rewind onto raw 4", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  const e3 = userEntry(e2.uuid, sid);
  const e4 = assistantEntry(e3.uuid, sid);
  const sUuid = uuid();
  const b = boundaryEntry({
    sessionId: sid,
    uuids: [e3.uuid, e4.uuid],
    anchor: sUuid,
    logicalParentUuid: e4.uuid,
  });
  const entries = [e1, e2, e3, e4, b, summaryEntry(b.uuid, sid, sUuid)];
  const { contextTree, materialized } = matchingInputs(entries, b);
  assert.deepEqual(
    matchPreservedList(
      contextTree,
      [e3.uuid, e4.uuid],
      true,
      materialized,
      new Set(),
    ),
    { branchPoint: e4.uuid, remainderFrom: 2 },
  );
  // Without a summary the strict start rule applies: 3 is not a context
  // root, so the same list matches nothing.
  assert.equal(
    matchPreservedList(
      contextTree,
      [e3.uuid, e4.uuid],
      false,
      materialized,
      new Set(),
    ),
    undefined,
  );
});

test("rewind-and-append: the match ends where the list leaves the chain", () => {
  const sid = uuid();
  const chain = [userEntry(null, sid)];
  for (let index = 1; index < 8; index++) {
    const parent = chain[index - 1]!.uuid;
    chain.push(
      index % 2 === 0 ? userEntry(parent, sid) : assistantEntry(parent, sid),
    );
  }
  const [e1, e2, e3, e4, , , e7, e8] = chain as (SessionEntry & {
    uuid: UUID;
  })[];
  const preserved = [
    e1!.uuid,
    e2!.uuid,
    e3!.uuid,
    e4!.uuid,
    e7!.uuid,
    e8!.uuid,
  ];
  const b = boundaryEntry({
    sessionId: sid,
    uuids: preserved,
    anchor: "own",
    logicalParentUuid: e4!.uuid,
  });
  const entries = [...chain, b];
  const { contextTree, materialized } = matchingInputs(entries, b);
  assert.deepEqual(
    matchPreservedList(contextTree, preserved, false, materialized, new Set()),
    { branchPoint: e4!.uuid, remainderFrom: 4 },
  );
});

test("branching off a relinked row: the deepest set is the earlier boundary's visible block row", () => {
  const sid = uuid();
  const chain = [userEntry(null, sid)];
  for (let index = 1; index < 8; index++) {
    const parent = chain[index - 1]!.uuid;
    chain.push(
      index % 2 === 0 ? userEntry(parent, sid) : assistantEntry(parent, sid),
    );
  }
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
  const { contextTree, materialized } = matchingInputs(entries, b2);
  const relinked = (entry: SessionEntry & { uuid: UUID }): string =>
    formatTreeNodeRef({ uuid: entry.uuid, viaBoundary: b.uuid });
  // B's matched prefix [1..4] is hidden by the time B2 is matched; 7 steps
  // to 7@B only (raw 7's predecessor is 6), and 10 steps nowhere.
  const hidden = new Set([e1!, e2!, e3!, e4!].map(relinked));
  assert.deepEqual(
    matchPreservedList(
      contextTree,
      [e1!.uuid, e2!.uuid, e3!.uuid, e4!.uuid, e7!.uuid, e10.uuid],
      false,
      materialized,
      hidden,
    ),
    { branchPoint: relinked(e7!), remainderFrom: 5 },
  );
});

test("a prefix of a hidden block matches nothing (criterion 5)", () => {
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
  const s2Uuid = uuid();
  const b2 = boundaryEntry({
    sessionId: sid,
    uuids: [s1Uuid, e3.uuid],
    anchor: s2Uuid,
    logicalParentUuid: e4.uuid,
  });
  const entries = [
    e1,
    e2,
    e3,
    e4,
    b1,
    s1,
    b2,
    summaryEntry(b2.uuid, sid, s2Uuid),
  ];
  const { contextTree, materialized } = matchingInputs(entries, b2);
  const hidden = new Set(
    [e3, e4].map((entry) =>
      formatTreeNodeRef({ uuid: entry.uuid, viaBoundary: b1.uuid }),
    ),
  );
  // S1 → 3@B1 is the only path, and 3@B1 is hidden: displaying B2 under S1
  // would claim the context [S1, 3, 4].
  assert.equal(
    matchPreservedList(
      contextTree,
      [s1Uuid, e3.uuid],
      true,
      materialized,
      hidden,
    ),
    undefined,
  );
});

test("an id-less assistant is its own group and settles its exclusion", () => {
  const sid = uuid();
  const idLessAssistant = (
    parentUuid: UUID,
    content: Record<string, unknown>,
  ): SessionEntry & { uuid: UUID } => ({
    uuid: uuid(),
    parentUuid,
    type: "assistant",
    sessionId: sid,
    message: { role: "assistant", content: [content] },
  });
  const e1 = userEntry(null, sid);
  const t = idLessAssistant(e1.uuid, {
    type: "thinking",
    thinking: "hm",
    signature: "sig",
  });
  const c = idLessAssistant(t.uuid, {
    type: "tool_use",
    id: "call_1",
    name: "Bash",
    input: {},
  });
  const e2 = userEntry(c.uuid, sid);
  const entries = [e1, t, c, e2];
  const { excluded } = toContextTree(
    buildTree(entries, () => {
      throw new Error("unexpected onInvalid");
    }),
    entriesByUuid(entries),
  );
  assert.deepEqual([...excluded].sort(), [t.uuid, c.uuid].sort());
});

test("excluded entries are skipped on both sides", () => {
  const sid = uuid();
  const e1 = userEntry(null, sid);
  const e2 = assistantEntry(e1.uuid, sid);
  // A thinking-only turn between 2 and 3: no accepted list can contain it.
  const t = thinkingEntry(e2.uuid, sid, "msg_t");
  const e3 = userEntry(t.uuid, sid);
  const e4 = assistantEntry(e3.uuid, sid);
  const sUuid = uuid();
  const b = boundaryEntry({
    sessionId: sid,
    uuids: [t.uuid, e3.uuid, e4.uuid],
    anchor: sUuid,
    logicalParentUuid: e4.uuid,
  });
  const entries = [e1, e2, t, e3, e4, b, summaryEntry(b.uuid, sid, sUuid)];
  const { contextTree, materialized } = matchingInputs(entries, b);
  assert.ok(contextTree.excluded.has(t.uuid));
  // The native list names t: skipped, the match is 3 → 4.
  assert.deepEqual(
    matchPreservedList(
      contextTree,
      [t.uuid, e3.uuid, e4.uuid],
      true,
      materialized,
      new Set(),
    ),
    { branchPoint: e4.uuid, remainderFrom: 3 },
  );
  // A normalized list omits t: 3's predecessor skips t on the tree side,
  // so [1, 2, 3, 4] is a pure rewind under the strict rule too.
  assert.deepEqual(
    matchPreservedList(
      contextTree,
      [e1.uuid, e2.uuid, e3.uuid, e4.uuid],
      false,
      materialized,
      new Set(),
    ),
    { branchPoint: e4.uuid, remainderFrom: 4 },
  );
});
