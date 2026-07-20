import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import { buildTree } from "./build-tree.ts";
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

/** Root occurrences, materialization order. */
function rootsOf(parents: ParentMap): TreeNodeRef[] {
  return (treeChildren(parents).get(null) ?? []).map(parseTreeNodeRef);
}

/** Child refs of an occurrence, materialization order. */
function childrenOf(parents: ParentMap, ref: TreeNodeRef): TreeNodeRef[] {
  return (treeChildren(parents).get(formatTreeNodeRef(ref)) ?? []).map(
    parseTreeNodeRef,
  );
}

/** Flattens a branchless (sub)tree into its single root → leaf ref path,
 *  asserting every occurrence has at most one child. */
function pathOf(parents: ParentMap, from?: TreeNodeRef): TreeNodeRef[] {
  const children = treeChildren(parents);
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

// The spec's fixture (criterion 2): one branch point, one boundary. Both
// branches appear; the boundary hangs under the last pre-compaction message;
// the summary appears under the boundary (its raw parent).
test("branch point plus boundary: raw tree with boundary under logicalParentUuid", () => {
  const root = chainEntry(null);
  const branchA = chainEntry(root.uuid, "assistant");
  const branchB = chainEntry(root.uuid, "assistant");
  const leafB = chainEntry(branchB.uuid);
  const boundaryUuid = uuid();
  const summaryUuid = uuid();
  const boundary: SessionEntry = {
    uuid: boundaryUuid,
    parentUuid: null,
    logicalParentUuid: leafB.uuid,
    type: "system",
    subtype: "compact_boundary",
  };
  const summary: SessionEntry = {
    uuid: summaryUuid,
    parentUuid: boundaryUuid,
    type: "user",
    isCompactSummary: true,
  };
  const tree = buildTree(
    [root, branchA, branchB, leafB, boundary, summary],
    failOnInvalid,
  );

  assert.deepEqual(rootsOf(tree), [{ uuid: root.uuid }]);
  assert.deepEqual(childrenOf(tree, { uuid: root.uuid }), [
    { uuid: branchA.uuid },
    { uuid: branchB.uuid },
  ]);
  assert.deepEqual(childrenOf(tree, { uuid: leafB.uuid }), [
    { uuid: boundaryUuid },
  ]);
  assert.deepEqual(childrenOf(tree, { uuid: boundaryUuid }), [
    { uuid: summaryUuid },
  ]);
});

test("entries without a uuid get no occurrence but chain entries still resolve", () => {
  const root = chainEntry(null);
  const snapshot: SessionEntry = {
    type: "file-history-snapshot",
    messageId: "m1",
  };
  const child = chainEntry(root.uuid);
  const tree = buildTree([root, snapshot, child], failOnInvalid);
  assert.equal(tree.size, 2);
  assert.deepEqual(pathOf(tree), [{ uuid: root.uuid }, { uuid: child.uuid }]);
});

test("a boundary without logicalParentUuid becomes a root", () => {
  const boundary: SessionEntry = {
    uuid: uuid(),
    parentUuid: null,
    type: "system",
    subtype: "compact_boundary",
  };
  const tree = buildTree([boundary], failOnInvalid);
  assert.deepEqual(rootsOf(tree), [{ uuid: boundary.uuid }]);
});

test("a parentUuid pointing at a missing entry falls back to a root", () => {
  const orphan = chainEntry(uuid());
  const tree = buildTree([orphan], failOnInvalid);
  assert.deepEqual(rootsOf(tree), [{ uuid: orphan.uuid }]);
});

test("a duplicated raw uuid throws (corrupt session file)", () => {
  const root = chainEntry(null);
  const duplicate: SessionEntry = { ...root };
  assert.throws(
    () => buildTree([root, duplicate], failOnInvalid),
    /duplicate occurrence .* corrupt/,
  );
});

// --- boundary substructure -------------------------------------------------
// Examples A–D from docs/specs/boundary-substructure.md "Concrete examples".

test("up_to relink (example A): substructure under the raw summary, post entry on the relinked tip", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const u3 = chainEntry(u2.uuid);
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    uuids: [u2.uuid, u3.uuid],
    anchor: summaryUuid,
    logicalParentUuid: u3.uuid,
  });
  const summary = summaryEntry(boundary.uuid, summaryUuid);
  const u4 = chainEntry(u3.uuid);
  const tree = buildTree([u1, u2, u3, boundary, summary, u4], failOnInvalid);
  assert.deepEqual(pathOf(tree), [
    { uuid: u1.uuid },
    { uuid: u2.uuid },
    { uuid: u3.uuid },
    { uuid: boundary.uuid },
    { uuid: summaryUuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
    { uuid: u3.uuid, viaBoundary: boundary.uuid },
    { uuid: u4.uuid },
  ]);
});

test("from-shape relink (example B): substructure under the boundary, raw summary occurrence omitted", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const u3 = chainEntry(u2.uuid);
  const boundary = boundaryEntry({
    uuids: [u1.uuid, u2.uuid],
    anchor: "own",
    logicalParentUuid: u2.uuid,
  });
  const summary = summaryEntry(boundary.uuid);
  const u4 = chainEntry(summary.uuid);
  const tree = buildTree([u1, u2, u3, boundary, summary, u4], failOnInvalid);
  assert.deepEqual(rootsOf(tree), [{ uuid: u1.uuid }]);
  assert.deepEqual(childrenOf(tree, { uuid: u2.uuid }), [
    { uuid: u3.uuid },
    { uuid: boundary.uuid },
  ]);
  // The raw summary occurrence (whose parent would be the boundary) is
  // omitted — the boundary's subtree is the branchless relinked chain.
  assert.ok(!tree.has(summary.uuid));
  assert.deepEqual(pathOf(tree, { uuid: boundary.uuid }), [
    { uuid: boundary.uuid },
    { uuid: u1.uuid, viaBoundary: boundary.uuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
    { uuid: summary.uuid, viaBoundary: boundary.uuid },
    { uuid: u4.uuid },
  ]);
});

test("stacked boundaries (example C): post entries and later boundaries attach to relinked occurrences", () => {
  const a = chainEntry(null);
  const b = chainEntry(a.uuid, "assistant");
  const c = chainEntry(b.uuid);
  const s1Uuid = uuid();
  const first = boundaryEntry({
    uuids: [c.uuid],
    anchor: s1Uuid,
    logicalParentUuid: c.uuid,
  });
  const s1 = summaryEntry(first.uuid, s1Uuid);
  const d = chainEntry(c.uuid, "assistant");
  const s2Uuid = uuid();
  const second = boundaryEntry({
    uuids: [d.uuid],
    anchor: s2Uuid,
    logicalParentUuid: d.uuid,
  });
  const s2 = summaryEntry(second.uuid, s2Uuid);
  const e = chainEntry(d.uuid);
  const tree = buildTree([a, b, c, first, s1, d, second, s2, e], failOnInvalid);
  assert.deepEqual(pathOf(tree), [
    { uuid: a.uuid },
    { uuid: b.uuid },
    { uuid: c.uuid },
    { uuid: first.uuid },
    { uuid: s1Uuid },
    { uuid: c.uuid, viaBoundary: first.uuid },
    { uuid: d.uuid },
    { uuid: second.uuid },
    { uuid: s2Uuid },
    { uuid: d.uuid, viaBoundary: second.uuid },
    { uuid: e.uuid },
  ]);
});

test("invalid relink (example D): no substructure, raw summary kept", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const u3 = chainEntry(u2.uuid);
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    uuids: [u2.uuid, u2.uuid],
    anchor: summaryUuid,
    logicalParentUuid: u3.uuid,
  });
  const summary = summaryEntry(boundary.uuid, summaryUuid);
  const invalidMessages: string[] = [];
  const tree = buildTree([u1, u2, u3, boundary, summary], (message) =>
    invalidMessages.push(message),
  );
  assert.equal(invalidMessages.length, 1);
  assert.match(invalidMessages[0]!, /duplicated uuid/);
  assert.deepEqual(pathOf(tree), [
    { uuid: u1.uuid },
    { uuid: u2.uuid },
    { uuid: u3.uuid },
    { uuid: boundary.uuid },
    { uuid: summaryUuid },
  ]);
});

test("a valid relink with no summary emits its substructure at the boundary", () => {
  const u1 = chainEntry(null);
  const u2 = chainEntry(u1.uuid, "assistant");
  const boundary = boundaryEntry({
    uuids: [u2.uuid],
    anchor: "own",
    logicalParentUuid: u2.uuid,
  });
  const tree = buildTree([u1, u2, boundary], failOnInvalid);
  assert.deepEqual(pathOf(tree), [
    { uuid: u1.uuid },
    { uuid: u2.uuid },
    { uuid: boundary.uuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
  ]);
});
