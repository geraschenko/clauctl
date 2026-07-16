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
