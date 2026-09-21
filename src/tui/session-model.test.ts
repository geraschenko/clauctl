import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { entriesByUuid, type SessionEntry } from "../core/session/file.ts";
import { buildTree } from "../core/tree/build-tree.ts";
import { toContextTree } from "../core/tree/context-tree.ts";
import { toDisplayTree } from "../core/tree/display-tree.ts";
import { SessionModel } from "./session-model.ts";

function uuid(n: number): UUID {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

const failOnInvalid = (message: string): never => {
  throw new Error(`unexpected onInvalid: ${message}`);
};

function userEntry(n: number, text: string, parent?: number): SessionEntry {
  return {
    type: "user",
    uuid: uuid(n),
    parentUuid: parent === undefined ? null : uuid(parent),
    message: { role: "user", content: text },
  };
}

function assistantEntry(
  n: number,
  text: string,
  parent?: number,
): SessionEntry {
  return {
    type: "assistant",
    uuid: uuid(n),
    parentUuid: parent === undefined ? null : uuid(parent),
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function boundaryEntry(
  n: number,
  params: { uuids: number[]; anchor: number; logicalParent: number },
): SessionEntry {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: uuid(n),
    parentUuid: null,
    logicalParentUuid: uuid(params.logicalParent),
    compactMetadata: {
      trigger: "manual",
      preTokens: 1000,
      preservedMessages: {
        anchorUuid: uuid(params.anchor),
        uuids: params.uuids.map(uuid),
      },
    },
  };
}

function summaryEntry(n: number, text: string, boundary: number): SessionEntry {
  return {
    type: "user",
    uuid: uuid(n),
    isCompactSummary: true,
    parentUuid: uuid(boundary),
    message: { role: "user", content: text },
  };
}

function steerAttachment(
  n: number,
  source: number,
  parent: number,
): SessionEntry {
  return {
    type: "attachment",
    uuid: uuid(n),
    parentUuid: uuid(parent),
    attachment: {
      type: "queued_command",
      prompt: "steer text",
      source_uuid: uuid(source),
    },
  };
}

/** Raw chain 1 → 2 → 3 → 4, then an up_to compaction preserving the first
 *  exchange: boundary(5) anchored at summary(6), relinking 2@5 → 3@5. */
const ENTRIES = [
  userEntry(1, "hello world"),
  assistantEntry(2, "hi there", 1),
  userEntry(3, "second question", 2),
  assistantEntry(4, "answer two", 3),
  boundaryEntry(5, { uuids: [2, 3], anchor: 6, logicalParent: 4 }),
  summaryEntry(6, "summary text", 5),
];

function oneShotTrees(entries: SessionEntry[]) {
  const byUuid = entriesByUuid(entries);
  const fullTree = buildTree(entries, failOnInvalid);
  const contextTree = toContextTree(fullTree, byUuid);
  return {
    byUuid,
    contextTree,
    displayTree: toDisplayTree(fullTree, contextTree, byUuid),
  };
}

/** Enqueue and resolve each entry in turn: the snapshot's path. */
function pushResolved(sessionModel: SessionModel, entry: SessionEntry): void {
  sessionModel.enqueueEntry(entry);
  sessionModel.resolve(entry.uuid!);
}

function sessionModelOver(entries: SessionEntry[]): SessionModel {
  const sessionModel = new SessionModel(failOnInvalid);
  for (const entry of entries) {
    pushResolved(sessionModel, entry);
  }
  return sessionModel;
}

test("SessionModel: the rolling trees after N pushes equal the one-shot trees over the same entries", () => {
  const sessionModel = sessionModelOver(ENTRIES);
  const expected = oneShotTrees(ENTRIES);
  assert.deepEqual(
    sessionModel.displayTree.parentMap,
    expected.displayTree.parentMap,
  );
  assert.deepEqual(
    sessionModel.contextTree.parentMap,
    expected.contextTree.parentMap,
  );
  assert.deepEqual(sessionModel.leaf, expected.contextTree.leaf);
  assert.deepEqual(sessionModel.byUuid, expected.byUuid);
});

test("SessionModel: pathToLeaf renders a hidden relinked leaf as the visible node carrying it", () => {
  const sessionModel = sessionModelOver(ENTRIES);
  // The context leaf is 3@5 (relinked, hidden); the display path ends at
  // the summary line that carries the preserved block.
  assert.deepEqual(sessionModel.leaf, { uuid: uuid(3), viaBoundary: uuid(5) });
  assert.deepEqual(
    sessionModel.pathToLeaf().map((ref) => ref.uuid),
    [uuid(1), uuid(2), uuid(3), uuid(5), uuid(6)],
  );
});

test("SessionModel: resetTrees restarts the trees over retained entries; pushes stay first-wins", () => {
  const sessionModel = sessionModelOver(ENTRIES);
  sessionModel.resetTrees();
  assert.deepEqual(sessionModel.displayTree.parentMap, new Map());
  assert.equal(sessionModel.leaf, null);
  assert.equal(sessionModel.byUuid.size, ENTRIES.length);
  // The forked file re-persists the entries; first-wins keeps the originals.
  pushResolved(sessionModel, ENTRIES[0]!);
  pushResolved(sessionModel, assistantEntry(2, "rewritten", 1));
  const expected = oneShotTrees(ENTRIES.slice(0, 2));
  assert.deepEqual(
    sessionModel.displayTree.parentMap,
    expected.displayTree.parentMap,
  );
  assert.deepEqual(sessionModel.byUuid.get(uuid(2)), ENTRIES[1]);
});

test("SessionModel: entryFor finds an entry by uuid, else the steer attachment recorded under its source uuid", () => {
  const attachment = steerAttachment(7, 9, 2);
  const sessionModel = sessionModelOver([...ENTRIES.slice(0, 2), attachment]);
  assert.deepEqual(sessionModel.entryFor(uuid(2)), ENTRIES[1]);
  assert.deepEqual(sessionModel.entryFor(uuid(9)), attachment);
  assert.deepEqual(sessionModel.entryFor(uuid(7)), attachment);
  assert.equal(sessionModel.entryFor(uuid(8)), undefined);
});

const frame = (n: number): SDKMessage =>
  ({
    type: "assistant",
    uuid: uuid(n),
    session_id: "s",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [] },
  }) as unknown as SDKMessage;

test("SessionModel: recordPending keeps query order; resolve retires the id and returns no entry for a query-only one", () => {
  const sessionModel = new SessionModel(failOnInvalid);
  sessionModel.recordPending(uuid(2), frame(2));
  sessionModel.recordPending(uuid(3), frame(3));
  assert.deepEqual([...sessionModel.queryMessages.keys()], [uuid(2), uuid(3)]);
  assert.equal(sessionModel.resolve(uuid(2)), undefined);
  assert.deepEqual([...sessionModel.queryMessages.keys()], [uuid(3)]);
});

test("SessionModel: an id recorded without a frame (pending at the seed) resolves as a known query-only id", () => {
  const sessionModel = new SessionModel(failOnInvalid);
  sessionModel.recordPending(uuid(2), undefined);
  assert.deepEqual([...sessionModel.queryMessages.keys()], [uuid(2)]);
  assert.equal(sessionModel.resolve(uuid(2)), undefined);
  assert.equal(sessionModel.queryMessages.size, 0);
});

test("SessionModel: an enqueued entry is retained but outside the trees until its id resolves; resolving the head pushes it and returns it", () => {
  const sessionModel = new SessionModel(failOnInvalid);
  sessionModel.enqueueEntry(ENTRIES[0]!);
  assert.deepEqual(sessionModel.byUuid.get(uuid(1)), ENTRIES[0]);
  assert.equal(sessionModel.leaf, null);
  assert.deepEqual(sessionModel.resolve(uuid(1)), ENTRIES[0]);
  assert.deepEqual(sessionModel.leaf, { uuid: uuid(1) });
});

test("SessionModel: resolving an id deeper in the queue pushes the prefix through it in file order and reports the anomaly", () => {
  const reports: string[] = [];
  const sessionModel = new SessionModel((message) => reports.push(message));
  for (const entry of ENTRIES.slice(0, 3)) {
    sessionModel.enqueueEntry(entry);
  }
  assert.deepEqual(sessionModel.resolve(uuid(2)), ENTRIES[1]);
  assert.deepEqual(sessionModel.leaf, { uuid: uuid(2) });
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /behind 1 queued/);
  // Entry 3 is still queued: resolving it now is the head case.
  assert.deepEqual(sessionModel.resolve(uuid(3)), ENTRIES[2]);
  assert.deepEqual(sessionModel.leaf, { uuid: uuid(3) });
  assert.equal(reports.length, 1);
});

test("SessionModel: resolving a retained, unqueued id (a snapshot entry resolving after the cut) returns it and pushes nothing", () => {
  const sessionModel = sessionModelOver(ENTRIES.slice(0, 2));
  assert.deepEqual(sessionModel.resolve(uuid(1)), ENTRIES[0]);
  assert.deepEqual(sessionModel.leaf, { uuid: uuid(2) });
});

test("SessionModel: resolving an id never observed is reported", () => {
  const reports: string[] = [];
  const sessionModel = new SessionModel((message) => reports.push(message));
  assert.equal(sessionModel.resolve(uuid(9)), undefined);
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /never observed/);
});

test("SessionModel: resetTrees drops the queue; a uuid-less entry is never queued", () => {
  const sessionModel = new SessionModel(failOnInvalid);
  sessionModel.enqueueEntry(ENTRIES[0]!);
  sessionModel.resetTrees();
  sessionModel.enqueueEntry({ type: "summary", summary: "s" } as SessionEntry);
  sessionModel.enqueueEntry(ENTRIES[1]!);
  assert.deepEqual(sessionModel.resolve(uuid(2)), ENTRIES[1]);
  // Only entry 2 was pushed: entry 1 left the queue with the reset.
  assert.deepEqual(sessionModel.displayTree.parentMap.size, 1);
});
