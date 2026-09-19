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

function sessionModelOver(entries: SessionEntry[]): SessionModel {
  const sessionModel = new SessionModel(failOnInvalid);
  for (const entry of entries) {
    sessionModel.pushEntry(entry);
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
  sessionModel.pushEntry(ENTRIES[0]!);
  sessionModel.pushEntry(assistantEntry(2, "rewritten", 1));
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

test("SessionModel: recordPending and retire maintain the pending list in query order", () => {
  const sessionModel = new SessionModel(failOnInvalid);
  const frame = (n: number): SDKMessage =>
    ({
      type: "assistant",
      uuid: uuid(n),
      session_id: "s",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [] },
    }) as unknown as SDKMessage;
  sessionModel.recordPending(uuid(2), frame(2));
  sessionModel.recordPending(uuid(3), frame(3));
  assert.deepEqual([...sessionModel.queryMessages.keys()], [uuid(2), uuid(3)]);
  sessionModel.retire(uuid(2));
  assert.deepEqual([...sessionModel.queryMessages.keys()], [uuid(3)]);
});
