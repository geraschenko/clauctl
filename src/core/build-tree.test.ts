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

function find(roots: TreeNode[], entryUuid: UUID): TreeNode | undefined {
  for (const root of roots) {
    if (root.entryUuid === entryUuid) {
      return root;
    }
    const inChildren = find(root.children, entryUuid);
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

  assert.equal(tree.roots.length, 1);
  const rootNode = tree.roots[0]!;
  assert.equal(rootNode.entryUuid, root.uuid);
  assert.deepEqual(
    rootNode.children.map((child) => child.entryUuid),
    [branchA.uuid, branchB.uuid],
  );
  const boundaryNode = find(tree.roots, boundaryUuid);
  assert.equal(find(tree.roots, leafB.uuid)!.children[0], boundaryNode);
  assert.equal(boundaryNode!.children[0]!.entryUuid, summaryUuid);
  assert.equal(boundaryNode!.viaBoundary, undefined);
  assert.equal(tree.entries[summaryUuid], summary);
});

test("entries without a uuid get no node but chain entries still resolve", () => {
  const root = chainEntry(null);
  const snapshot: SessionEntry = {
    type: "file-history-snapshot",
    messageId: "m1",
  };
  const child = chainEntry(root.uuid);
  const tree = buildTree([root, snapshot, child]);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0]!.children[0]!.entryUuid, child.uuid);
  assert.equal(Object.keys(tree.entries).length, 2);
});

test("a boundary without logicalParentUuid becomes a root", () => {
  const boundary: SessionEntry = {
    uuid: uuid(),
    parentUuid: null,
    type: "system",
    subtype: "compact_boundary",
  };
  const tree = buildTree([boundary]);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0]!.entryUuid, boundary.uuid);
});

test("a parentUuid pointing at a missing entry falls back to a root", () => {
  const orphan = chainEntry(uuid());
  const tree = buildTree([orphan]);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0]!.entryUuid, orphan.uuid);
});
