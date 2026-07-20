import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import { entriesByUuid, type SessionEntry } from "./session-file.ts";
import {
  forestChildren,
  formatTreeNodeRef,
  isFinalAssistantEntry,
  parseTreeNodeRef,
  pathToLeaf,
  treeNodeRefsEqual,
  type Forest,
  type ForestNode,
  type TreeNodeRef,
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

/** A hand-built forest from (ref, parent) pairs, keyed like buildForest. */
function forestOf(nodes: ForestNode[]): Forest {
  return new Map(nodes.map((node) => [formatTreeNodeRef(node.ref), node]));
}

test("pathToLeaf: root-first path, null leaf, absent leaf", () => {
  const rootEntry: SessionEntry = { uuid: uuid(), type: "user" };
  const childEntry: SessionEntry = { uuid: uuid(), type: "assistant" };
  const otherEntry: SessionEntry = { uuid: uuid(), type: "assistant" };
  const root: TreeNodeRef = { uuid: rootEntry.uuid! };
  const child: TreeNodeRef = { uuid: childEntry.uuid! };
  const forest = forestOf([
    { ref: root, parent: null },
    { ref: { uuid: otherEntry.uuid! }, parent: root },
    { ref: child, parent: root },
  ]);
  const entryOf = entriesByUuid([rootEntry, childEntry, otherEntry]);
  assert.deepEqual(pathToLeaf(forest, entryOf, child), [
    { ref: root, entry: rootEntry },
    { ref: child, entry: childEntry },
  ]);
  assert.deepEqual(pathToLeaf(forest, entryOf, null), []);
  assert.deepEqual(pathToLeaf(forest, entryOf, { uuid: uuid() }), []);
});

test("pathToLeaf distinguishes occurrences by viaBoundary", () => {
  const entry: SessionEntry = { uuid: uuid(), type: "user" };
  const boundary: SessionEntry = {
    uuid: uuid(),
    type: "system",
    subtype: "compact_boundary",
  };
  const raw: TreeNodeRef = { uuid: entry.uuid! };
  const boundaryRef: TreeNodeRef = { uuid: boundary.uuid! };
  const relinked: TreeNodeRef = {
    uuid: entry.uuid!,
    viaBoundary: boundary.uuid!,
  };
  const forest = forestOf([
    { ref: raw, parent: null },
    { ref: boundaryRef, parent: raw },
    { ref: relinked, parent: boundaryRef },
  ]);
  const entryOf = entriesByUuid([entry, boundary]);

  // A bare ref stops at the raw occurrence; the via ref walks into the
  // substructure.
  assert.deepEqual(pathToLeaf(forest, entryOf, raw), [{ ref: raw, entry }]);
  assert.deepEqual(pathToLeaf(forest, entryOf, relinked), [
    { ref: raw, entry },
    { ref: boundaryRef, entry: boundary },
    { ref: relinked, entry },
  ]);
});

test("pathToLeaf throws on a parent cycle and on a missing entry", () => {
  const a: TreeNodeRef = { uuid: uuid() };
  const b: TreeNodeRef = { uuid: uuid() };
  const cyclic = forestOf([
    { ref: a, parent: b },
    { ref: b, parent: a },
  ]);
  const entryOf = entriesByUuid([
    { uuid: a.uuid, type: "user" },
    { uuid: b.uuid, type: "user" },
  ]);
  assert.throws(() => pathToLeaf(cyclic, entryOf, a), /parent cycle/);

  const lone = forestOf([{ ref: a, parent: null }]);
  assert.throws(
    () => pathToLeaf(lone, entriesByUuid([]), a),
    /no entry for uuid/,
  );
});

test("forestChildren inverts the parent relation, roots under null", () => {
  const root: TreeNodeRef = { uuid: uuid() };
  const childA: TreeNodeRef = { uuid: uuid() };
  const childB: TreeNodeRef = { uuid: uuid() };
  const forest = forestOf([
    { ref: root, parent: null },
    { ref: childA, parent: root },
    { ref: childB, parent: root },
  ]);
  const children = forestChildren(forest);
  assert.deepEqual(children.get(null), [root]);
  assert.deepEqual(children.get(formatTreeNodeRef(root)), [childA, childB]);
  assert.equal(children.get(formatTreeNodeRef(childA)), undefined);
});

function assistantEntry(apiMessageId: string | undefined): SessionEntry {
  return {
    uuid: uuid(),
    type: "assistant",
    ...(apiMessageId !== undefined && { message: { id: apiMessageId } }),
  };
}

/** Forest + lookups for a single chain of entries (each parenting the
 *  previous), all occurrences raw unless viaBoundary is given. */
function chainFixture(
  entries: SessionEntry[],
  viaBoundary?: UUID,
): {
  refs: TreeNodeRef[];
  children: Map<string | null, TreeNodeRef[]>;
  entryOf: Map<UUID, SessionEntry>;
} {
  const refs = entries.map((entry): TreeNodeRef => ({
    uuid: entry.uuid!,
    ...(viaBoundary !== undefined && { viaBoundary }),
  }));
  const forest = forestOf(
    refs.map((ref, index) => ({
      ref,
      parent: index === 0 ? null : refs[index - 1]!,
    })),
  );
  return {
    refs,
    children: forestChildren(forest),
    entryOf: entriesByUuid(entries),
  };
}

test("isFinalAssistantEntry: same-message.id child means non-final", () => {
  const thinking = assistantEntry("msg_1");
  const text = assistantEntry("msg_1");
  const { refs, children, entryOf } = chainFixture([thinking, text]);
  assert.ok(!isFinalAssistantEntry(refs[0]!, children, entryOf));
  assert.ok(isFinalAssistantEntry(refs[1]!, children, entryOf));

  const followedUp = chainFixture([
    assistantEntry("msg_1"),
    assistantEntry("msg_2"),
  ]);
  assert.ok(
    isFinalAssistantEntry(
      followedUp.refs[0]!,
      followedUp.children,
      followedUp.entryOf,
    ),
  );
});

test("isFinalAssistantEntry: non-assistant false, missing message.id final", () => {
  const user = chainFixture([{ uuid: uuid(), type: "user" }]);
  assert.ok(!isFinalAssistantEntry(user.refs[0]!, user.children, user.entryOf));
  const bare = chainFixture([assistantEntry(undefined)]);
  assert.ok(isFinalAssistantEntry(bare.refs[0]!, bare.children, bare.entryOf));
});

test("isFinalAssistantEntry over via occurrences uses relink-chain children", () => {
  const thinking = assistantEntry("msg_1");
  const text = assistantEntry("msg_1");
  const { refs, children, entryOf } = chainFixture([thinking, text], uuid());
  assert.ok(!isFinalAssistantEntry(refs[0]!, children, entryOf));
  assert.ok(isFinalAssistantEntry(refs[1]!, children, entryOf));
});
