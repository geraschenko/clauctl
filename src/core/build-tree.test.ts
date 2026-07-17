import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import { buildTree, type TreeNode } from "./build-tree.ts";
import type { SessionEntry } from "./session-file.ts";

const uuid = (): UUID => randomUUID();

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

/** Flattens a branchless forest into its single root → leaf path, asserting
 *  every node has at most one child. */
function pathOf(tree: TreeNode[]): TreeNode[] {
  const path: TreeNode[] = [];
  let level = tree;
  while (level.length === 1) {
    path.push(level[0]!);
    level = level[0]!.children;
  }
  assert.equal(level.length, 0);
  return path;
}

function refsOf(path: TreeNode[]): Array<{ uuid?: UUID; viaBoundary?: UUID }> {
  return path.map((node) => ({
    uuid: node.entry.uuid,
    ...(node.viaBoundary !== undefined && { viaBoundary: node.viaBoundary }),
  }));
}

function find(tree: TreeNode[], entryUuid: UUID): TreeNode | undefined {
  for (const node of tree) {
    if (node.entry.uuid === entryUuid) {
      return node;
    }
    const inChildren = find(node.children, entryUuid);
    if (inChildren !== undefined) {
      return inChildren;
    }
  }
  return undefined;
}

// The spec's fixture (criterion 2): one branch point, one boundary. Both
// branches appear; the boundary hangs under the last pre-compaction message;
// the summary appears under the boundary (its raw parent).
test("branch point plus boundary: raw forest with boundary under logicalParentUuid", () => {
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
  const tree = buildTree([root, branchA, branchB, leafB, boundary, summary]);

  assert.equal(tree.length, 1);
  const rootNode = tree[0]!;
  assert.equal(rootNode.entry, root);
  assert.deepEqual(
    rootNode.children.map((child) => child.entry.uuid),
    [branchA.uuid, branchB.uuid],
  );
  const boundaryNode = find(tree, boundaryUuid);
  assert.equal(find(tree, leafB.uuid)!.children[0], boundaryNode);
  assert.equal(boundaryNode!.children[0]!.entry, summary);
  assert.equal(boundaryNode!.viaBoundary, undefined);
});

test("entries without a uuid get no node but chain entries still resolve", () => {
  const root = chainEntry(null);
  const snapshot: SessionEntry = {
    type: "file-history-snapshot",
    messageId: "m1",
  };
  const child = chainEntry(root.uuid);
  const tree = buildTree([root, snapshot, child]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.children[0]!.entry, child);
  assert.equal(find(tree, root.uuid)!.children.length, 1);
});

test("a boundary without logicalParentUuid becomes a root", () => {
  const boundary: SessionEntry = {
    uuid: uuid(),
    parentUuid: null,
    type: "system",
    subtype: "compact_boundary",
  };
  const tree = buildTree([boundary]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.entry, boundary);
});

test("a parentUuid pointing at a missing entry falls back to a root", () => {
  const orphan = chainEntry(uuid());
  const tree = buildTree([orphan]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.entry, orphan);
});

// --- boundary substructure -------------------------------------------------
// Forests A–D from docs/specs/boundary-substructure.md "Concrete examples".

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
  const tree = buildTree([u1, u2, u3, boundary, summary, u4]);
  const path = pathOf(tree);
  assert.deepEqual(refsOf(path), [
    { uuid: u1.uuid },
    { uuid: u2.uuid },
    { uuid: u3.uuid },
    { uuid: boundary.uuid },
    { uuid: summaryUuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
    { uuid: u3.uuid, viaBoundary: boundary.uuid },
    { uuid: u4.uuid },
  ]);
  // Raw and relinked nodes embed the same entry object.
  assert.equal(path[5]!.entry, u2);
  assert.equal(path[6]!.entry, u3);
});

test("from-shape relink (example B): substructure under the boundary, raw summary node omitted", () => {
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
  const tree = buildTree([u1, u2, u3, boundary, summary, u4]);
  assert.equal(tree.length, 1);
  const u2Node = find(tree, u2.uuid)!;
  assert.deepEqual(
    u2Node.children.map((child) => child.entry.uuid),
    [u3.uuid, boundary.uuid],
  );
  // The boundary's subtree is branchless — a raw summary node (whose parent
  // would be the boundary) would fork it, so this also pins the omission.
  const boundaryPath = pathOf([u2Node.children[1]!]);
  assert.deepEqual(refsOf(boundaryPath), [
    { uuid: boundary.uuid },
    { uuid: u1.uuid, viaBoundary: boundary.uuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
    { uuid: summary.uuid, viaBoundary: boundary.uuid },
    { uuid: u4.uuid },
  ]);
  assert.equal(boundaryPath[3]!.entry, summary);
});

test("stacked boundaries (example C): post entries and later boundaries attach to relinked nodes", () => {
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
  const tree = buildTree([a, b, c, first, s1, d, second, s2, e]);
  assert.deepEqual(refsOf(pathOf(tree)), [
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
  const tree = buildTree([u1, u2, u3, boundary, summary]);
  assert.deepEqual(refsOf(pathOf(tree)), [
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
  const tree = buildTree([u1, u2, boundary]);
  assert.deepEqual(refsOf(pathOf(tree)), [
    { uuid: u1.uuid },
    { uuid: u2.uuid },
    { uuid: boundary.uuid },
    { uuid: u2.uuid, viaBoundary: boundary.uuid },
  ]);
});
