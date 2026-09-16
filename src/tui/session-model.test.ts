import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "../core/protocol.ts";
import { entriesByUuid, type SessionEntry } from "../core/session/file.ts";
import { structuralEntry } from "../core/session/structural.ts";
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

/** The wire's `sessionEntry` for `entry`: structural for the shared classes
 *  (user/assistant), intact otherwise. */
function entryEvent(entry: SessionEntry): AgentEvent {
  const shared = entry.type === "user" || entry.type === "assistant";
  return {
    kind: "sessionEntry",
    entry: shared ? structuralEntry(entry) : entry,
    expectsSdkMessage: shared,
    leaf: null,
    awaitingAnchors: [],
  };
}

function twinEvent(entry: SessionEntry): AgentEvent {
  return {
    kind: "sdkMessage",
    message: {
      type: entry.type,
      uuid: entry.uuid,
      session_id: "s1",
      parent_tool_use_id: null,
      message: entry.message,
    } as SDKMessage,
  };
}

function fileChangedEvent(): AgentEvent {
  return { kind: "sessionFileChanged", sessionId: uuid(99) };
}

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

test("SessionModel: the live trees after N events equal the one-shot trees over the same entries", () => {
  const sessionModel = new SessionModel(failOnInvalid);
  sessionModel.applySnapshot([], 0);
  for (const entry of ENTRIES) {
    sessionModel.observe(entryEvent(entry));
    if (entry.type === "user" || entry.type === "assistant") {
      sessionModel.observe(twinEvent(entry));
    }
  }
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

test("SessionModel: a twin arriving before its entry completes it; a twin after it grafts in place", () => {
  const sessionModel = new SessionModel(failOnInvalid);
  sessionModel.applySnapshot([], 0);
  sessionModel.observe(twinEvent(ENTRIES[0]!));
  sessionModel.observe(entryEvent(ENTRIES[0]!));
  sessionModel.observe(entryEvent(ENTRIES[1]!));
  assert.deepEqual(
    sessionModel.byUuid.get(uuid(2)),
    structuralEntry(ENTRIES[1]!),
  );
  sessionModel.observe(twinEvent(ENTRIES[1]!));
  assert.deepEqual(sessionModel.byUuid.get(uuid(1)), ENTRIES[0]);
  assert.deepEqual(sessionModel.byUuid.get(uuid(2)), ENTRIES[1]);
});

test("SessionModel: session-stream events before the snapshot cut are in the snapshot; those after extend it", () => {
  const sessionModel = new SessionModel(failOnInvalid);
  // Positions 1–3 precede the response line: a switch (position 1) and the
  // scan's first two entries, which the snapshot contains; position 4 is
  // live and extends it. The twin at position 5 is live too.
  sessionModel.observe(fileChangedEvent());
  sessionModel.observe(entryEvent(ENTRIES[0]!));
  sessionModel.observe(entryEvent(ENTRIES[1]!));
  sessionModel.observe(entryEvent(ENTRIES[2]!));
  sessionModel.observe(twinEvent(ENTRIES[2]!));
  sessionModel.applySnapshot(ENTRIES.slice(0, 2), 3);
  const expected = oneShotTrees(ENTRIES.slice(0, 3));
  assert.deepEqual(
    sessionModel.displayTree.parentMap,
    expected.displayTree.parentMap,
  );
  assert.deepEqual(sessionModel.leaf, expected.contextTree.leaf);
  assert.deepEqual(sessionModel.byUuid, expected.byUuid);
});

test("SessionModel: sessionFileChanged after the snapshot rebuilds the trees over the retained entries", () => {
  const sessionModel = new SessionModel(failOnInvalid);
  sessionModel.applySnapshot(ENTRIES, 0);
  sessionModel.observe(fileChangedEvent());
  assert.deepEqual(sessionModel.displayTree.parentMap, new Map());
  assert.equal(sessionModel.leaf, null);
  assert.equal(sessionModel.byUuid.size, ENTRIES.length);
  // The forked file re-persists the entries structurally; payloads survive.
  for (const entry of ENTRIES.slice(0, 2)) {
    sessionModel.observe(entryEvent(entry));
  }
  const expected = oneShotTrees(ENTRIES.slice(0, 2));
  assert.deepEqual(
    sessionModel.displayTree.parentMap,
    expected.displayTree.parentMap,
  );
  assert.deepEqual(sessionModel.byUuid.get(uuid(2)), ENTRIES[1]);
});
