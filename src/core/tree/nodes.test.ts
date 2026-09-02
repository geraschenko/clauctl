import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import { entriesByUuid, type SessionEntry } from "../session/file.ts";
import { treeChildren } from "./parent-map.ts";
import {
  formatTreeNodeRef,
  isFinalAssistantEntry,
  parseTreeNodeRef,
  pathToLeaf,
  resolveTreeNodeRef,
  treeNodeRefsEqual,
  type ParentMap,
  type TreeNodeRef,
} from "./nodes.ts";

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

test("resolveTreeNodeRef resolves prefixes per half, passes full uuids through", () => {
  const target = "aaaaaaaa-0000-4000-8000-000000000001" as UUID;
  const boundary = "bbbbbbbb-0000-4000-8000-000000000002" as UUID;
  const sessionUuids = new Set([target, boundary]);
  assert.deepEqual(resolveTreeNodeRef("aa", sessionUuids), { uuid: target });
  assert.deepEqual(resolveTreeNodeRef("aa@bb", sessionUuids), {
    uuid: target,
    viaBoundary: boundary,
  });
  assert.deepEqual(resolveTreeNodeRef(`${target}@bb`, sessionUuids), {
    uuid: target,
    viaBoundary: boundary,
  });
  // A full uuid is never checked against the session (the daemon keeps
  // membership validation).
  const absent = "cccccccc-0000-4000-8000-000000000003" as UUID;
  assert.deepEqual(resolveTreeNodeRef(absent, sessionUuids), { uuid: absent });
  assert.throws(
    () => resolveTreeNodeRef("dd", sessionUuids),
    /no session entry uuid matches 'dd'/,
  );
  for (const bad of ["", "aa@", "@bb", "aa@bb@cc", "zz"]) {
    assert.throws(
      () => resolveTreeNodeRef(bad, sessionUuids),
      /expected "<uuid>"/,
    );
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

/** A hand-built parent map from (ref, parent) pairs, keyed like buildTree. */
function treeOf(
  nodes: { ref: TreeNodeRef; parent: TreeNodeRef | null }[],
): ParentMap {
  return new Map(
    nodes.map(({ ref, parent }) => [
      formatTreeNodeRef(ref),
      parent === null ? null : formatTreeNodeRef(parent),
    ]),
  );
}

test("pathToLeaf: root-first path, null leaf, absent leaf", () => {
  const rootEntry: SessionEntry = { uuid: uuid(), type: "user" };
  const childEntry: SessionEntry = { uuid: uuid(), type: "assistant" };
  const otherEntry: SessionEntry = { uuid: uuid(), type: "assistant" };
  const root: TreeNodeRef = { uuid: rootEntry.uuid! };
  const child: TreeNodeRef = { uuid: childEntry.uuid! };
  const tree = treeOf([
    { ref: root, parent: null },
    { ref: { uuid: otherEntry.uuid! }, parent: root },
    { ref: child, parent: root },
  ]);
  const byUuid = entriesByUuid([rootEntry, childEntry, otherEntry]);
  assert.deepEqual(pathToLeaf(tree, byUuid, child), [root, child]);
  assert.deepEqual(pathToLeaf(tree, byUuid, null), []);
  assert.deepEqual(pathToLeaf(tree, byUuid, { uuid: uuid() }), []);
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
  const tree = treeOf([
    { ref: raw, parent: null },
    { ref: boundaryRef, parent: raw },
    { ref: relinked, parent: boundaryRef },
  ]);
  const byUuid = entriesByUuid([entry, boundary]);

  // A bare ref stops at the raw occurrence; the via ref walks into the
  // substructure.
  assert.deepEqual(pathToLeaf(tree, byUuid, raw), [raw]);
  assert.deepEqual(pathToLeaf(tree, byUuid, relinked), [
    raw,
    boundaryRef,
    relinked,
  ]);
});

test("pathToLeaf throws on a parent cycle and on a missing entry", () => {
  const a: TreeNodeRef = { uuid: uuid() };
  const b: TreeNodeRef = { uuid: uuid() };
  const cyclic = treeOf([
    { ref: a, parent: b },
    { ref: b, parent: a },
  ]);
  const byUuid = entriesByUuid([
    { uuid: a.uuid, type: "user" },
    { uuid: b.uuid, type: "user" },
  ]);
  assert.throws(() => pathToLeaf(cyclic, byUuid, a), /parent cycle/);

  const lone = treeOf([{ ref: a, parent: null }]);
  assert.throws(
    () => pathToLeaf(lone, entriesByUuid([]), a),
    /no entry for uuid/,
  );
});

test("treeChildren inverts the parent relation, roots under null", () => {
  const root: TreeNodeRef = { uuid: uuid() };
  const childA: TreeNodeRef = { uuid: uuid() };
  const childB: TreeNodeRef = { uuid: uuid() };
  const tree = treeOf([
    { ref: root, parent: null },
    { ref: childA, parent: root },
    { ref: childB, parent: root },
  ]);
  const children = treeChildren(tree);
  assert.deepEqual(children.get(null), [formatTreeNodeRef(root)]);
  assert.deepEqual(children.get(formatTreeNodeRef(root)), [
    formatTreeNodeRef(childA),
    formatTreeNodeRef(childB),
  ]);
  assert.equal(children.get(formatTreeNodeRef(childA)), undefined);
});

function assistantEntry(apiMessageId: string | undefined): SessionEntry {
  return {
    uuid: uuid(),
    type: "assistant",
    ...(apiMessageId !== undefined && { message: { id: apiMessageId } }),
  };
}

/** Occurrence ids + lookups for a single chain of entries (each parenting
 *  the previous), all occurrences raw unless viaBoundary is given. */
function chainFixture(
  entries: SessionEntry[],
  viaBoundary?: UUID,
): {
  ids: string[];
  children: Map<string | null, string[]>;
  byUuid: Map<UUID, SessionEntry>;
} {
  const refs = entries.map((entry): TreeNodeRef => ({
    uuid: entry.uuid!,
    ...(viaBoundary !== undefined && { viaBoundary }),
  }));
  const tree = treeOf(
    refs.map((ref, index) => ({
      ref,
      parent: index === 0 ? null : refs[index - 1]!,
    })),
  );
  return {
    ids: refs.map(formatTreeNodeRef),
    children: treeChildren(tree),
    byUuid: entriesByUuid(entries),
  };
}

test("isFinalAssistantEntry: same-message.id child means non-final", () => {
  const thinking = assistantEntry("msg_1");
  const text = assistantEntry("msg_1");
  const { ids, children, byUuid } = chainFixture([thinking, text]);
  assert.ok(!isFinalAssistantEntry(ids[0]!, children, byUuid));
  assert.ok(isFinalAssistantEntry(ids[1]!, children, byUuid));

  const followedUp = chainFixture([
    assistantEntry("msg_1"),
    assistantEntry("msg_2"),
  ]);
  assert.ok(
    isFinalAssistantEntry(
      followedUp.ids[0]!,
      followedUp.children,
      followedUp.byUuid,
    ),
  );
});

test("isFinalAssistantEntry: non-assistant false, missing message.id final", () => {
  const user = chainFixture([{ uuid: uuid(), type: "user" }]);
  assert.ok(!isFinalAssistantEntry(user.ids[0]!, user.children, user.byUuid));
  const bare = chainFixture([assistantEntry(undefined)]);
  assert.ok(isFinalAssistantEntry(bare.ids[0]!, bare.children, bare.byUuid));
});

test("isFinalAssistantEntry over via occurrences uses relink-chain children", () => {
  const thinking = assistantEntry("msg_1");
  const text = assistantEntry("msg_1");
  const { ids, children, byUuid } = chainFixture([thinking, text], uuid());
  assert.ok(!isFinalAssistantEntry(ids[0]!, children, byUuid));
  assert.ok(isFinalAssistantEntry(ids[1]!, children, byUuid));
});
