/**
 * Drives `SessionModels` the way interactive mode does: every event folded
 * through the real `nextAgentState`, then observed with its state. Ids are
 * `uuidN(n)`; SESSION_A/B/C are session ids.
 */

import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentState,
  initialAgentState,
  nextAgentState,
} from "../core/agent-state/agent-state.ts";
import type { AgentEvent } from "../core/protocol.ts";
import type { SessionEntry } from "../core/session/file.ts";
import { SessionModels } from "./session-models.ts";

const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001" as const;
const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002" as const;
const SESSION_C = "cccccccc-0000-0000-0000-000000000003" as const;
const uuidN = (n: number): UUID =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const failOnInvalid = (message: string): never => {
  throw new Error(`unexpected onInvalid: ${message}`);
};

function queryMessage(
  type: "assistant" | "system" | "stream_event" | "user",
  fields: Record<string, unknown> = {},
): SDKMessage {
  return {
    type,
    session_id: SESSION_A,
    ...(type === "assistant" && {
      parent_tool_use_id: null,
      message: { usage: { input_tokens: 5, output_tokens: 7 } },
    }),
    ...fields,
  } as unknown as SDKMessage;
}

function sdkMessage(
  type: Parameters<typeof queryMessage>[0],
  fields: Record<string, unknown> = {},
): AgentEvent {
  return { kind: "sdkMessage", message: queryMessage(type, fields) };
}

const assistantQuery = (n: number, sessionId: UUID = SESSION_A): AgentEvent =>
  sdkMessage("assistant", { uuid: uuidN(n), session_id: sessionId });

const boundaryMessage = (n: number): SDKMessage =>
  queryMessage("system", {
    subtype: "compact_boundary",
    uuid: uuidN(n),
    compact_metadata: { trigger: "manual", pre_tokens: 100 },
  });

function assistantEntry(n: number, parent?: number): SessionEntry {
  return {
    type: "assistant",
    uuid: uuidN(n),
    parentUuid: parent === undefined ? null : uuidN(parent),
    message: { role: "assistant", content: [{ type: "text", text: `t${n}` }] },
  };
}

function boundaryEntry(n: number, parent?: number): SessionEntry {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: uuidN(n),
    parentUuid: null,
    logicalParentUuid: parent === undefined ? null : uuidN(parent),
    content: "Conversation compacted",
    isMeta: false,
    level: "info",
    compactMetadata: {
      trigger: "manual",
      preTokens: 100,
      preservedMessages: { anchorUuid: uuidN(n), uuids: [], allUuids: [] },
    },
  };
}

const entryEvent = (entry: SessionEntry): AgentEvent => ({
  kind: "sessionEntry",
  entry,
  expectsSdkMessage: true,
  leaf: { uuid: entry.uuid! },
  awaitingAnchors: [],
});

const fileChanged = (sessionId: UUID): AgentEvent => ({
  kind: "sessionFileChanged",
  sessionId,
});
const scanComplete: AgentEvent = { kind: "scanComplete" };

class Harness {
  state: AgentState = initialAgentState();
  /** `statesAfter[i]` is the state after the (i+1)th event. */
  readonly statesAfter: AgentState[] = [];
  readonly resolved: Array<[UUID, UUID]> = [];
  /** Whether `entryFor` had the resolved id when `onResolved` fired. */
  readonly entryPresentAtResolve: boolean[] = [];
  readonly sessionModels = new SessionModels(
    failOnInvalid,
    (sessionId, uuid) => {
      this.resolved.push([sessionId, uuid]);
      this.entryPresentAtResolve.push(
        this.sessionModels.get(sessionId)?.entryFor(uuid) !== undefined,
      );
    },
  );

  feed(...events: AgentEvent[]): void {
    for (const event of events) {
      this.state = nextAgentState(this.state, event);
      this.statesAfter.push(this.state);
      this.sessionModels.observe(event, this.state);
    }
  }

  byUuidKeys(sessionId: UUID): UUID[] {
    return [...(this.sessionModels.get(sessionId)?.byUuid.keys() ?? [])];
  }

  pendingKeys(sessionId: UUID): UUID[] {
    return [...(this.sessionModels.get(sessionId)?.queryMessages.keys() ?? [])];
  }
}

test("SessionModels: entries follow the file session across a rollover, query messages their own session, dropped sessions their session model", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, entryEvent(assistantEntry(1)));
  assert.deepEqual(h.byUuidKeys(SESSION_A), [uuidN(1)]);

  h.feed(assistantQuery(2, SESSION_B));
  assert.deepEqual(h.pendingKeys(SESSION_B), [uuidN(2)]);
  h.feed(fileChanged(SESSION_B), scanComplete);
  assert.equal(h.sessionModels.get(SESSION_A), undefined);
  h.feed(
    entryEvent(assistantEntry(2)),
    entryEvent(assistantEntry(3, 2)),
    assistantQuery(4, SESSION_C),
    entryEvent(assistantEntry(5, 3)),
  );
  assert.deepEqual(h.byUuidKeys(SESSION_B), [uuidN(2), uuidN(3), uuidN(5)]);
  assert.deepEqual(h.pendingKeys(SESSION_B), []);
  assert.deepEqual(h.byUuidKeys(SESSION_C), []);
  assert.deepEqual(h.pendingKeys(SESSION_C), [uuidN(4)]);
  assert.deepEqual(h.resolved, [[SESSION_B, uuidN(2)]]);
});

test("SessionModels: the snapshot lands in the file session at the cut; held events after the cut extend the session models with their own states; a session the latest state dropped stays dropped", () => {
  // Positions: 1 fileChanged(A), 2 scanComplete, 3 entry 1 (A),
  // 4 fileChanged(B), 5 entry 2 (B).
  const events = [
    fileChanged(SESSION_A),
    scanComplete,
    entryEvent(assistantEntry(1)),
    fileChanged(SESSION_B),
    entryEvent(assistantEntry(2)),
  ];

  const cutBeforeSwitch = new Harness();
  cutBeforeSwitch.feed(...events);
  cutBeforeSwitch.sessionModels.applySnapshot(
    [assistantEntry(1)],
    3,
    cutBeforeSwitch.statesAfter[2]!,
  );
  assert.equal(cutBeforeSwitch.sessionModels.get(SESSION_A), undefined);
  assert.deepEqual(cutBeforeSwitch.byUuidKeys(SESSION_B), [uuidN(2)]);

  const cutAfterSwitch = new Harness();
  cutAfterSwitch.feed(...events);
  cutAfterSwitch.sessionModels.applySnapshot(
    [],
    4,
    cutAfterSwitch.statesAfter[3]!,
  );
  assert.equal(cutAfterSwitch.sessionModels.get(SESSION_A), undefined);
  assert.deepEqual(cutAfterSwitch.byUuidKeys(SESSION_B), [uuidN(2)]);
});

test("SessionModels: a same-file rescan restarts the trees and keeps the entries and pending list", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(
    fileChanged(SESSION_A),
    scanComplete,
    entryEvent(assistantEntry(1)),
    entryEvent(assistantEntry(2, 1)),
    assistantQuery(3),
  );
  h.feed(fileChanged(SESSION_A));
  const sessionModel = h.sessionModels.get(SESSION_A)!;
  assert.deepEqual(sessionModel.displayTree.parentMap, new Map());
  assert.deepEqual(h.byUuidKeys(SESSION_A), [uuidN(1), uuidN(2)]);
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(3)]);
  h.feed(
    scanComplete,
    entryEvent(assistantEntry(1)),
    entryEvent(assistantEntry(2, 1)),
  );
  assert.equal(sessionModel.displayTree.parentMap.size, 2);
  assert.deepEqual(sessionModel.leaf, { uuid: uuidN(2) });
});

test("SessionModels: a query frame is recorded while its id pends and retired by its entry, with onResolved after the push", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, assistantQuery(2));
  const pending = h.sessionModels.get(SESSION_A)!.queryMessages.get(uuidN(2));
  assert.equal(pending?.type, "assistant");
  assert.equal(pending?.uuid, uuidN(2));
  h.feed(entryEvent(assistantEntry(2)));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [[SESSION_A, uuidN(2)]]);
  assert.deepEqual(h.entryPresentAtResolve, [true]);
});

test("SessionModels: a frame whose entry arrived first is never recorded; it still resolves", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, entryEvent(assistantEntry(2)));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  h.feed(assistantQuery(2));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [[SESSION_A, uuidN(2)]]);
});

test("SessionModels: one step retiring several ids fires onResolved for each in resolution order", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(
    assistantQuery(2),
    assistantQuery(3),
    fileChanged(SESSION_A),
    scanComplete,
  );
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(2), uuidN(3)]);
  h.feed(entryEvent(assistantEntry(3)));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [
    [SESSION_A, uuidN(2)],
    [SESSION_A, uuidN(3)],
  ]);
});

test("SessionModels: a stream_event stays recorded behind its unresolved query predecessor and retires with it", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(
    fileChanged(SESSION_A),
    scanComplete,
    assistantQuery(7),
    sdkMessage("stream_event", { uuid: uuidN(8) }),
  );
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(7), uuidN(8)]);
  h.feed(entryEvent(assistantEntry(7)));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [
    [SESSION_A, uuidN(7)],
    [SESSION_A, uuidN(8)],
  ]);
});

test("SessionModels: a compact_boundary frame is recorded and retired by its boundary entry", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, assistantQuery(1), {
    kind: "sdkMessage",
    message: boundaryMessage(7),
  });
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(1), uuidN(7)]);
  h.feed(entryEvent(assistantEntry(1)), entryEvent(boundaryEntry(7, 1)));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.byUuidKeys(SESSION_A), [uuidN(1), uuidN(7)]);
  assert.deepEqual(h.resolved, [
    [SESSION_A, uuidN(1)],
    [SESSION_A, uuidN(7)],
  ]);
});

test("SessionModels: sessionAppended messages join the pending list like query-stream frames", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, assistantQuery(1));
  h.feed(
    entryEvent(assistantEntry(1)),
    {
      kind: "sessionAppended",
      message: queryMessage("user", {
        uuid: uuidN(6),
        parent_tool_use_id: null,
        message: { role: "user", content: "summary" },
      }),
    },
    { kind: "sessionAppended", message: boundaryMessage(7) },
  );
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(6), uuidN(7)]);
  // The daemon's drain delivers the entries in the order it appended them.
  h.feed(
    entryEvent({
      type: "user",
      uuid: uuidN(6),
      parentUuid: uuidN(1),
      isCompactSummary: true,
      message: { role: "user", content: "summary" },
    }),
  );
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(7)]);
  h.feed(entryEvent(boundaryEntry(7, 6)));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
});

test("SessionModels: subagent traffic is never recorded", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(
    fileChanged(SESSION_A),
    scanComplete,
    sdkMessage("assistant", { uuid: uuidN(3), parent_tool_use_id: "tool-1" }),
    sdkMessage("stream_event", {
      uuid: uuidN(4),
      parent_tool_use_id: "tool-1",
    }),
  );
  assert.equal(h.sessionModels.get(SESSION_A)?.queryMessages.size ?? 0, 0);
});
