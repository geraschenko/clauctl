import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry } from "./session-file.ts";
import {
  formatTreeNodeRef,
  isFinalAssistantEntry,
  parseTreeNodeRef,
  pathToLeaf,
  treeNodeRefsEqual,
  type TreeNode,
} from "./tree.ts";

const uuid = (): UUID => randomUUID();

test("formatTreeNodeRef/parseTreeNodeRef round-trip", () => {
  const raw = { uuid: uuid() };
  const via = { uuid: uuid(), viaBoundary: uuid() };
  assert.deepEqual(parseTreeNodeRef(formatTreeNodeRef(raw)), raw);
  assert.deepEqual(parseTreeNodeRef(formatTreeNodeRef(via)), via);
  assert.equal(formatTreeNodeRef(raw), raw.uuid);
  assert.equal(formatTreeNodeRef(via), `${via.uuid}@${via.viaBoundary}`);
});

test("parseTreeNodeRef rejects malformed input", () => {
  const good = uuid();
  for (const bad of [
    "",
    "not-a-uuid",
    `${good}@`,
    `@${good}`,
    `${good}@not-a-uuid`,
    `${good}@${good}@${good}`,
    `${good} `,
  ]) {
    assert.throws(() => parseTreeNodeRef(bad), /expected "<uuid>"/);
  }
});

test("treeNodeRefsEqual is structural", () => {
  const a = uuid();
  const b = uuid();
  assert.ok(treeNodeRefsEqual({ uuid: a }, { uuid: a }));
  assert.ok(
    treeNodeRefsEqual({ uuid: a, viaBoundary: b }, { uuid: a, viaBoundary: b }),
  );
  assert.ok(!treeNodeRefsEqual({ uuid: a }, { uuid: a, viaBoundary: b }));
  assert.ok(!treeNodeRefsEqual({ uuid: a }, { uuid: b }));
  assert.ok(treeNodeRefsEqual(undefined, undefined));
  assert.ok(!treeNodeRefsEqual({ uuid: a }, undefined));
});

function node(
  entry: SessionEntry,
  children: TreeNode[] = [],
  viaBoundary?: UUID,
): TreeNode {
  return {
    entry,
    children,
    ...(viaBoundary !== undefined && { viaBoundary }),
  };
}

test("pathToLeaf: root-first path, null leaf, missing leaf", () => {
  const rootEntry: SessionEntry = { uuid: uuid(), type: "user" };
  const childEntry: SessionEntry = { uuid: uuid(), type: "assistant" };
  const otherEntry: SessionEntry = { uuid: uuid(), type: "assistant" };
  const child = node(childEntry);
  const tree = [node(rootEntry, [node(otherEntry), child])];
  assert.deepEqual(pathToLeaf(tree, { uuid: childEntry.uuid! }), [
    tree[0]!,
    child,
  ]);
  assert.deepEqual(pathToLeaf(tree, null), []);
  assert.deepEqual(pathToLeaf(tree, { uuid: uuid() }), []);
});

test("pathToLeaf distinguishes occurrences by viaBoundary", () => {
  const entryUuid = uuid();
  const boundaryUuid = uuid();
  const entry: SessionEntry = { uuid: entryUuid, type: "user" };
  const boundary: SessionEntry = {
    uuid: boundaryUuid,
    type: "system",
    subtype: "compact_boundary",
  };
  const relinked = node(entry, [], boundaryUuid);
  const boundaryNode = node(boundary, [relinked]);
  const raw = node(entry, [boundaryNode]);
  const tree = [raw];

  // A bare ref stops at the raw occurrence; the via ref walks into the
  // substructure.
  assert.deepEqual(pathToLeaf(tree, { uuid: entryUuid }), [raw]);
  assert.deepEqual(
    pathToLeaf(tree, { uuid: entryUuid, viaBoundary: boundaryUuid }),
    [raw, boundaryNode, relinked],
  );
});

function assistantEntry(apiMessageId: string | undefined): SessionEntry {
  return {
    uuid: uuid(),
    type: "assistant",
    ...(apiMessageId !== undefined && { message: { id: apiMessageId } }),
  };
}

test("isFinalAssistantEntry: same-message.id child means non-final", () => {
  const thinking = assistantEntry("msg_1");
  const text = assistantEntry("msg_1");
  const textNode = node(text);
  const thinkingNode = node(thinking, [textNode]);
  assert.ok(!isFinalAssistantEntry(thinkingNode));
  assert.ok(isFinalAssistantEntry(textNode));

  const followUp = node(assistantEntry("msg_2"));
  assert.ok(isFinalAssistantEntry(node(assistantEntry("msg_1"), [followUp])));
});

test("isFinalAssistantEntry: non-assistant false, missing message.id final", () => {
  assert.ok(!isFinalAssistantEntry(node({ uuid: uuid(), type: "user" })));
  assert.ok(isFinalAssistantEntry(node(assistantEntry(undefined))));
});

test("isFinalAssistantEntry over via occurrences uses relink-chain children", () => {
  const thinking = assistantEntry("msg_1");
  const text = assistantEntry("msg_1");
  const boundaryUuid = uuid();
  const relinkedText = node(text, [], boundaryUuid);
  const relinkedThinking = node(thinking, [relinkedText], boundaryUuid);
  assert.ok(!isFinalAssistantEntry(relinkedThinking));
  assert.ok(isFinalAssistantEntry(relinkedText));
});
