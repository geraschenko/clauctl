import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import { buildDisplayTree } from "./build-display-tree.ts";
import {
  treeChildren,
  formatTreeNodeRef,
  parseTreeNodeRef,
  type ParentMap,
  type TreeNodeRef,
} from "./tree.ts";
import type { SessionEntry } from "./session-file.ts";

const uuid = (): UUID => randomUUID();

/** onInvalid sink for well-formed files: any diagnostic is a test failure. */
const failOnInvalid = (message: string): never => {
  throw new Error(`unexpected onInvalid: ${message}`);
};

function chainEntry(
  parentUuid: UUID | null,
  type = "user",
): SessionEntry & { uuid: UUID } {
  return { uuid: uuid(), parentUuid, type };
}

function boundaryEntry(params: {
  uuids: UUID[];
  anchor: "own" | UUID;
  logicalParentUuid: UUID;
}): SessionEntry & { uuid: UUID } {
  const boundaryUuid = uuid();
  return {
    uuid: boundaryUuid,
    parentUuid: null,
    logicalParentUuid: params.logicalParentUuid,
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: {
      preservedMessages: {
        anchorUuid: params.anchor === "own" ? boundaryUuid : params.anchor,
        uuids: params.uuids,
      },
    },
  };
}

function summaryEntry(
  boundaryUuid: UUID,
  presetUuid?: UUID,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: presetUuid ?? uuid(),
    parentUuid: boundaryUuid,
    type: "user",
    isCompactSummary: true,
  };
}

/** Child refs of an occurrence, materialization order. */
function childrenOf(parentMap: ParentMap, ref: TreeNodeRef): TreeNodeRef[] {
  return (treeChildren(parentMap).get(formatTreeNodeRef(ref)) ?? []).map(
    parseTreeNodeRef,
  );
}

/** Flattens a branchless (sub)tree into its single root → leaf ref path,
 *  asserting every occurrence has at most one child. */
function pathOf(parentMap: ParentMap, from?: TreeNodeRef): TreeNodeRef[] {
  const children = treeChildren(parentMap);
  const path: TreeNodeRef[] = [];
  let level =
    from === undefined ? (children.get(null) ?? []) : [formatTreeNodeRef(from)];
  while (level.length === 1) {
    const id = level[0]!;
    path.push(parseTreeNodeRef(id));
    level = children.get(id) ?? [];
  }
  assert.equal(level.length, 0);
  return path;
}

/** representativeOf as a plain object keyed/valued by formatted ids, for
 *  exhaustive deepEqual assertions. */
function representativesOf(tree: {
  representativeOf: Map<string, string>;
}): Record<string, string> {
  return Object.fromEntries(tree.representativeOf);
}

// The spec's up_to example: raw 1→2→4→5, boundary preserving [4,5] with a
// summary, next turn 7 on raw parent 5. One straight line; the relinked
// occurrences are hidden behind the summary (block tail).
test("up_to compaction renders as a single linear chain", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const u4 = chainEntry(u2.uuid);
  const u5 = chainEntry(u4.uuid, "assistant");
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    uuids: [u4.uuid, u5.uuid],
    anchor: summaryUuid,
    logicalParentUuid: u2.uuid,
  });
  const summary = summaryEntry(boundary.uuid, summaryUuid);
  const u7 = chainEntry(u5.uuid);
  const tree = buildDisplayTree(
    [u1, u2, u4, u5, boundary, summary, u7],
    failOnInvalid,
  );
  assert.deepEqual(pathOf(tree.parentMap), [
    { uuid: u1.uuid },
    { uuid: u2.uuid },
    { uuid: u4.uuid },
    { uuid: u5.uuid },
    { uuid: boundary.uuid },
    { uuid: summaryUuid },
    { uuid: u7.uuid },
  ]);
  assert.deepEqual(representativesOf(tree), {
    [formatTreeNodeRef({ uuid: u4.uuid, viaBoundary: boundary.uuid })]:
      summaryUuid,
    [formatTreeNodeRef({ uuid: u5.uuid, viaBoundary: boundary.uuid })]:
      summaryUuid,
  });
});

// Two up_to compactions of a linear conversation: still one straight line,
// each occurrence exactly once (success criterion 1). The second boundary's
// anchor resolves through the first boundary's block (stacked composition).
test("stacked up_to compactions stay linear", () => {
  const a = chainEntry(null);
  const b = chainEntry(a.uuid, "assistant");
  const s1Uuid = uuid();
  const first = boundaryEntry({
    uuids: [b.uuid],
    anchor: s1Uuid,
    logicalParentUuid: a.uuid,
  });
  const s1 = summaryEntry(first.uuid, s1Uuid);
  const c = chainEntry(b.uuid);
  const d = chainEntry(c.uuid, "assistant");
  const s2Uuid = uuid();
  const second = boundaryEntry({
    uuids: [c.uuid, d.uuid],
    anchor: s2Uuid,
    logicalParentUuid: b.uuid,
  });
  const s2 = summaryEntry(second.uuid, s2Uuid);
  const e = chainEntry(d.uuid);
  const tree = buildDisplayTree(
    [a, b, first, s1, c, d, second, s2, e],
    failOnInvalid,
  );
  assert.deepEqual(pathOf(tree.parentMap), [
    { uuid: a.uuid },
    { uuid: b.uuid },
    { uuid: first.uuid },
    { uuid: s1Uuid },
    { uuid: c.uuid },
    { uuid: d.uuid },
    { uuid: second.uuid },
    { uuid: s2Uuid },
    { uuid: e.uuid },
  ]);
});

// The spec's from-shape example: boundary rewind to 2 (preserving [1,2])
// with a summary, then one new turn. The display forks exactly at the
// rewind target; the summary's only row is its relinked occurrence.
test("from-shape boundary with summary forks at the rewind target", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const u4 = chainEntry(u2.uuid);
  const u5 = chainEntry(u4.uuid, "assistant");
  const boundary = boundaryEntry({
    uuids: [u1.uuid, u2.uuid],
    anchor: "own",
    logicalParentUuid: u5.uuid,
  });
  const summary = summaryEntry(boundary.uuid);
  const u7 = chainEntry(summary.uuid);
  const tree = buildDisplayTree(
    [u1, u2, u4, u5, boundary, summary, u7],
    failOnInvalid,
  );
  const summaryRef: TreeNodeRef = {
    uuid: summary.uuid,
    viaBoundary: boundary.uuid,
  };
  assert.deepEqual(childrenOf(tree.parentMap, { uuid: u2.uuid }), [
    { uuid: u4.uuid },
    { uuid: boundary.uuid },
  ]);
  // The raw summary occurrence is omitted; the relinked one is the block
  // tail, parented on the boundary row.
  assert.ok(!tree.parentMap.has(summary.uuid));
  assert.deepEqual(pathOf(tree.parentMap, { uuid: boundary.uuid }), [
    { uuid: boundary.uuid },
    summaryRef,
    { uuid: u7.uuid },
  ]);
  const summaryKey = formatTreeNodeRef(summaryRef);
  assert.deepEqual(representativesOf(tree), {
    [formatTreeNodeRef({ uuid: u1.uuid, viaBoundary: boundary.uuid })]:
      summaryKey,
    [formatTreeNodeRef({ uuid: u2.uuid, viaBoundary: boundary.uuid })]:
      summaryKey,
  });
});

// Summary-less navigation boundary with a follow-up turn: visible, forking
// at the true divergence point, with the new turn under the boundary row.
test("summary-less boundary with a descendant stays visible", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const u4 = chainEntry(u2.uuid);
  const u5 = chainEntry(u4.uuid, "assistant");
  const boundary = boundaryEntry({
    uuids: [u1.uuid, u2.uuid],
    anchor: "own",
    logicalParentUuid: u5.uuid,
  });
  const u7 = chainEntry(u2.uuid);
  const tree = buildDisplayTree([u1, u2, u4, u5, boundary, u7], failOnInvalid);
  assert.deepEqual(childrenOf(tree.parentMap, { uuid: u2.uuid }), [
    { uuid: u4.uuid },
    { uuid: boundary.uuid },
  ]);
  assert.deepEqual(pathOf(tree.parentMap, { uuid: boundary.uuid }), [
    { uuid: boundary.uuid },
    { uuid: u7.uuid },
  ]);
});

// Same navigation with NO new turn: the boundary is hidden and the tree is
// indistinguishable from a plain tail rewind; the relinked leaf's
// representative is the rewind target's raw row.
test("summary-less childless boundary is hidden", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const u4 = chainEntry(u2.uuid);
  const u5 = chainEntry(u4.uuid, "assistant");
  const boundary = boundaryEntry({
    uuids: [u1.uuid, u2.uuid],
    anchor: "own",
    logicalParentUuid: u5.uuid,
  });
  const tree = buildDisplayTree([u1, u2, u4, u5, boundary], failOnInvalid);
  assert.deepEqual(pathOf(tree.parentMap), [
    { uuid: u1.uuid },
    { uuid: u2.uuid },
    { uuid: u4.uuid },
    { uuid: u5.uuid },
  ]);
  assert.deepEqual(representativesOf(tree), {
    [boundary.uuid]: u2.uuid,
    [formatTreeNodeRef({ uuid: u1.uuid, viaBoundary: boundary.uuid })]: u2.uuid,
    [formatTreeNodeRef({ uuid: u2.uuid, viaBoundary: boundary.uuid })]: u2.uuid,
  });
});

// Two stacked message-less navigation boundaries (the second anchored on
// the first) both disappear via the fixpoint; every hidden id resolves to
// the final rewind target.
test("stacked hidden navigation boundaries cascade away", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const u4 = chainEntry(u2.uuid);
  const first = boundaryEntry({
    uuids: [u1.uuid, u2.uuid],
    anchor: "own",
    logicalParentUuid: u4.uuid,
  });
  const second = boundaryEntry({
    uuids: [u1.uuid, u2.uuid],
    anchor: "own",
    logicalParentUuid: u2.uuid,
  });
  const tree = buildDisplayTree([u1, u2, u4, first, second], failOnInvalid);
  assert.deepEqual(pathOf(tree.parentMap), [
    { uuid: u1.uuid },
    { uuid: u2.uuid },
    { uuid: u4.uuid },
  ]);
  const expected: Record<string, string> = {
    [first.uuid]: u2.uuid,
    [second.uuid]: u2.uuid,
  };
  for (const boundary of [first, second]) {
    for (const preserved of [u1, u2]) {
      expected[
        formatTreeNodeRef({ uuid: preserved.uuid, viaBoundary: boundary.uuid })
      ] = u2.uuid;
    }
  }
  assert.deepEqual(representativesOf(tree), expected);
});

// Rule 6: a boundary without a valid relink keeps its logicalParentUuid
// anchor and is never hidden, even summary-less and childless.
test("invalid-relink boundary keeps its placement and stays visible", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const boundary = boundaryEntry({
    uuids: [u2.uuid, u2.uuid],
    anchor: "own",
    logicalParentUuid: u2.uuid,
  });
  const invalidMessages: string[] = [];
  const tree = buildDisplayTree([u1, u2, boundary], (message) =>
    invalidMessages.push(message),
  );
  assert.equal(invalidMessages.length, 1);
  assert.match(invalidMessages[0]!, /duplicated uuid/);
  assert.deepEqual(pathOf(tree.parentMap), [
    { uuid: u1.uuid },
    { uuid: u2.uuid },
    { uuid: boundary.uuid },
  ]);
  assert.deepEqual(representativesOf(tree), {});
});

// Corrupt interleaving: an entry between a boundary and its summary sees
// the pre-relink display rows (the relink defers to the summary position,
// mirroring buildTree).
test("relink application defers to the summary position", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    uuids: [u2.uuid],
    anchor: summaryUuid,
    logicalParentUuid: u1.uuid,
  });
  const interloper = chainEntry(u2.uuid);
  const summary = summaryEntry(boundary.uuid, summaryUuid);
  const post = chainEntry(u2.uuid);
  const tree = buildDisplayTree(
    [u1, u2, boundary, interloper, summary, post],
    failOnInvalid,
  );
  // The interloper attached to raw u2 before the relink overwrote it; the
  // post-summary entry lands on the block tail.
  assert.deepEqual(childrenOf(tree.parentMap, { uuid: u2.uuid }), [
    { uuid: boundary.uuid },
    { uuid: interloper.uuid },
  ]);
  assert.deepEqual(childrenOf(tree.parentMap, { uuid: summaryUuid }), [
    { uuid: post.uuid },
  ]);
});

// Corrupt interleaving: a second boundary arrives while the first's relink
// is still pending (its summary not yet reached). Mirroring buildTree, the
// later boundary displaces the pending relink: the first boundary's relink
// is never applied (no representatives, no re-anchoring through it), its
// summary attaches as an ordinary raw row, and the second boundary's block
// works normally.
test("a later boundary displaces an earlier pending relink", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const s1Uuid = uuid();
  const s2Uuid = uuid();
  const first = boundaryEntry({
    uuids: [u2.uuid],
    anchor: s1Uuid,
    logicalParentUuid: u2.uuid,
  });
  const second = boundaryEntry({
    uuids: [u2.uuid],
    anchor: s2Uuid,
    logicalParentUuid: u2.uuid,
  });
  const s1 = summaryEntry(first.uuid, s1Uuid);
  const s2 = summaryEntry(second.uuid, s2Uuid);
  const tree = buildDisplayTree([u1, u2, first, second, s1, s2], failOnInvalid);
  // Both boundaries anchored at raw u2 (the first's relink never rewrote
  // the display row); the first's summary is a plain raw child of it.
  assert.deepEqual(childrenOf(tree.parentMap, { uuid: u2.uuid }), [
    { uuid: first.uuid },
    { uuid: second.uuid },
  ]);
  assert.deepEqual(childrenOf(tree.parentMap, { uuid: first.uuid }), [
    { uuid: s1Uuid },
  ]);
  assert.deepEqual(childrenOf(tree.parentMap, { uuid: second.uuid }), [
    { uuid: s2Uuid },
  ]);
  assert.deepEqual(representativesOf(tree), {
    [formatTreeNodeRef({ uuid: u2.uuid, viaBoundary: second.uuid })]: s2Uuid,
  });
});

test("a duplicated raw uuid throws (corrupt session file)", () => {
  const root = chainEntry(null);
  const duplicate: SessionEntry = { ...root };
  assert.throws(
    () => buildDisplayTree([root, duplicate], failOnInvalid),
    /duplicate occurrence .* corrupt/,
  );
});
