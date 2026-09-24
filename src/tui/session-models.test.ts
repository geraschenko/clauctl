/**
 * Drives `SessionModels` the way interactive mode does: every event folded
 * through the real `nextAgentState`, then observed with its state. Ids are
 * `uuidN(n)`; SESSION_A/B/C are session ids.
 */

import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentState, AgentEvent } from "../core/protocol/index.ts";
import {
  initialAgentState,
  nextAgentState,
} from "../core/agent-state/index.ts";
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

/** A query message event as the hub emits it: stamped `uuidN(eventStamp)`
 *  iff the message carries no uuid. */
function sdkMessage(
  type: Parameters<typeof queryMessage>[0],
  fields: Record<string, unknown> = {},
  eventStamp?: number,
): AgentEvent {
  const message = queryMessage(type, fields);
  return message.uuid === undefined
    ? { kind: "sdkMessage", message, uuid: uuidN(eventStamp!) }
    : { kind: "sdkMessage", message };
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

const entryEvent = (
  entry: SessionEntry,
  expectsSdkMessage = true,
): AgentEvent => ({
  kind: "sessionEntry",
  entry,
  expectsSdkMessage,
  leaf: { uuid: entry.uuid! },
  awaitingAnchors: [],
});

// --- prompts: stamped uuid `uuidN(n)`, dequeued as the query observation,
// filed as a `user` entry (a merged run under its last uuid) or, steered, as
// a `queued_command` attachment naming the uuid as source_uuid. The queued
// event itself is stamped `uuidN(1000 + n)`, a query node of its own.

const queued = (n: number, text: string): AgentEvent => ({
  kind: "userMessageQueued",
  uuid: uuidN(1000 + n),
  message: {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: uuidN(n),
  },
});
const dequeued = (
  delivery: "turn" | "steer" | "append",
  [first, ...rest]: [number, ...number[]],
): AgentEvent => ({
  kind: "userMessageDequeued",
  delivery,
  uuids: [uuidN(first), ...rest.map(uuidN)],
});
const promptEntryEvent = (n: number, parent?: number): AgentEvent =>
  entryEvent(
    {
      type: "user",
      uuid: uuidN(n),
      parentUuid: parent === undefined ? null : uuidN(parent),
      message: { role: "user", content: "hello" },
    },
    false,
  );
const steerEntryEvent = (n: number, source: number): AgentEvent =>
  entryEvent(
    {
      type: "attachment",
      uuid: uuidN(n),
      parentUuid: null,
      attachment: {
        type: "queued_command",
        prompt: "steer text",
        source_uuid: uuidN(source),
      },
    },
    false,
  );
/** SESSION_A's init: query-only, stamped uuidN(901), pends only behind
 *  earlier query ids. */
const init = sdkMessage("system", { subtype: "init", uuid: undefined }, 901);
const promptText = (h: Harness, n: number): unknown =>
  (
    h.sessionModels
      .get(SESSION_A)!
      .queryMessages.get(uuidN(n)) as SDKUserMessage
  ).message.content;

const queryChanged = (sessionId: UUID): AgentEvent => ({
  kind: "querySessionChanged",
  sessionId,
});
const fileChanged = (sessionId: UUID): AgentEvent => ({
  kind: "sessionFileChanged",
  sessionId,
});
const scanComplete: AgentEvent = { kind: "scanComplete", uuid: uuidN(900) };
/** A contextChanged for `boundary`, stamped `uuidN(stamp)`. */
const contextChanged = (boundary: number, stamp: number): AgentEvent => ({
  kind: "contextChanged",
  uuid: uuidN(stamp),
  boundary: uuidN(boundary),
  leaf: { uuid: uuidN(boundary) },
});

/** The hub's construction: SESSION_A announced as the query session, its
 *  start node pending on `query`. */
const announcedA: AgentState = nextAgentState(
  initialAgentState(),
  queryChanged(SESSION_A),
);

/** Starts as a subscriber does: seeded from `state`, whose pending ids
 *  (`announcedA`: SESSION_A's start node) `seed` records frameless. */
class Harness {
  state: AgentState;
  /** `statesAfter[i]` is the state after the (i+1)th event. */
  readonly statesAfter: AgentState[] = [];
  readonly resolved: Array<[UUID, UUID]> = [];
  /** Whether `onResolved` carried an entry. */
  readonly entryPresentAtResolve: boolean[] = [];
  /** Each `onContextChanged`, as the length of `resolved` when it fired. */
  readonly contextChangedAfterResolved: number[] = [];
  readonly sessionModels = new SessionModels(
    failOnInvalid,
    (sessionId, uuid, entry) => {
      this.resolved.push([sessionId, uuid]);
      this.entryPresentAtResolve.push(entry !== undefined);
    },
    () => {
      this.contextChangedAfterResolved.push(this.resolved.length);
    },
  );

  constructor(state: AgentState = announcedA) {
    this.state = state;
    this.sessionModels.seed(state);
  }

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

/** What following SESSION_A's file resolves, in order: its start node
 *  (announced on `query`, met by `sessionFileChanged`), then the scan's
 *  stamp. Both frameless, reported without an entry. */
const fileOpenedA: [UUID, UUID][] = [
  [SESSION_A, SESSION_A],
  [SESSION_A, uuidN(900)],
];
/** `init`'s stamp, resolved in its own step when nothing pends ahead. */
const initResolvedA: [UUID, UUID] = [SESSION_A, uuidN(901)];
/** `queued(n)`'s stamp, likewise. */
const queuedResolvedA = (n: number): [UUID, UUID] => [
  SESSION_A,
  uuidN(1000 + n),
];

test("SessionModels: entries follow the file session across a rollover, query messages their own session, dropped sessions their session model", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, entryEvent(assistantEntry(1)));
  assert.deepEqual(h.byUuidKeys(SESSION_A), [uuidN(1)]);

  h.feed(queryChanged(SESSION_B), assistantQuery(2, SESSION_B));
  assert.deepEqual(h.pendingKeys(SESSION_B), [SESSION_B, uuidN(2)]);
  h.feed(fileChanged(SESSION_B), scanComplete);
  assert.equal(h.sessionModels.get(SESSION_A), undefined);
  assert.deepEqual(h.pendingKeys(SESSION_B), [uuidN(2)]);
  h.feed(
    entryEvent(assistantEntry(2)),
    entryEvent(assistantEntry(3, 2)),
    queryChanged(SESSION_C),
    assistantQuery(4, SESSION_C),
    entryEvent(assistantEntry(5, 3)),
  );
  assert.deepEqual(h.byUuidKeys(SESSION_B), [uuidN(2), uuidN(3), uuidN(5)]);
  assert.deepEqual(h.pendingKeys(SESSION_B), []);
  assert.deepEqual(h.byUuidKeys(SESSION_C), []);
  assert.deepEqual(h.pendingKeys(SESSION_C), [SESSION_C, uuidN(4)]);
  assert.deepEqual(h.resolved, [
    ...fileOpenedA,
    [SESSION_B, SESSION_B],
    [SESSION_B, uuidN(900)],
    [SESSION_B, uuidN(2)],
  ]);
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

test("SessionModels: the snapshot's entries are in the trees; ids resolved before the cut still retire at applySnapshot, and an entry after the cut resolves through its replay", () => {
  // Positions: 1 fileChanged(A), 2 scanComplete, 3 query 2, 4 query 3,
  // 5 entry 3 (resolves 2 as query-only and 3), 6 query 4, 7 entry 4.
  const events = [
    fileChanged(SESSION_A),
    scanComplete,
    assistantQuery(2),
    assistantQuery(3),
    entryEvent(assistantEntry(3)),
    assistantQuery(4),
    entryEvent(assistantEntry(4, 3)),
  ];
  const h = new Harness();
  h.feed(...events);
  assert.deepEqual(h.resolved, []);
  // Held: the start node and scan stamp resolved in their steps, but the
  // resolutions replay only at applySnapshot.
  assert.deepEqual(h.pendingKeys(SESSION_A), [
    SESSION_A,
    uuidN(900),
    uuidN(2),
    uuidN(3),
    uuidN(4),
  ]);
  h.sessionModels.applySnapshot([assistantEntry(3)], 5, h.statesAfter[4]!);
  const sessionModel = h.sessionModels.get(SESSION_A)!;
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(sessionModel.leaf, { uuid: uuidN(4) });
  assert.deepEqual(h.resolved, [
    ...fileOpenedA,
    [SESSION_A, uuidN(2)],
    [SESSION_A, uuidN(3)],
    [SESSION_A, uuidN(4)],
  ]);
  assert.deepEqual(h.entryPresentAtResolve, [false, false, false, true, true]);
});

test("SessionModels: seed records the seed state's query-pending ids without frames, so their later resolution is a known id", () => {
  const before = new Harness();
  before.feed(
    fileChanged(SESSION_A),
    scanComplete,
    assistantQuery(2),
    sdkMessage("stream_event", { uuid: uuidN(3) }),
  );
  // Attaching at that state: both frames were delivered before this
  // process subscribed. The stream event resolves query-only, which
  // without the seed would be an unknown id (Harness throws on onInvalid).
  const h = new Harness(before.state);
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(2), uuidN(3)]);
  assert.equal(
    h.sessionModels.get(SESSION_A)!.queryMessages.get(uuidN(2)),
    undefined,
  );
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(entryEvent(assistantEntry(2)));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [
    [SESSION_A, uuidN(2)],
    [SESSION_A, uuidN(3)],
  ]);
  assert.deepEqual(h.entryPresentAtResolve, [true, false]);
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
  h.feed({ kind: "sessionFileChanged", sessionId: SESSION_A, uuid: uuidN(9) });
  const sessionModel = h.sessionModels.get(SESSION_A)!;
  assert.deepEqual(sessionModel.displayTree.parentMap, new Map());
  assert.deepEqual(h.byUuidKeys(SESSION_A), [uuidN(1), uuidN(2)]);
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(3)]);
  // The rescan's entries are session-only until it meets a query-reported
  // id (fold-session-entry.ts), so each resolves as it is re-emitted.
  h.feed(
    entryEvent(assistantEntry(1)),
    entryEvent(assistantEntry(2, 1)),
    scanComplete,
  );
  assert.equal(sessionModel.displayTree.parentMap.size, 2);
  assert.deepEqual(sessionModel.leaf, { uuid: uuidN(2) });
});

test("SessionModels: a query frame is recorded while its id pends and retired by its entry, with onResolved carrying the entry after the push", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, assistantQuery(2));
  const pending = h.sessionModels.get(SESSION_A)!.queryMessages.get(uuidN(2));
  assert.equal(pending?.type, "assistant");
  assert.equal(pending?.uuid, uuidN(2));
  h.feed(entryEvent(assistantEntry(2)));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [...fileOpenedA, [SESSION_A, uuidN(2)]]);
  assert.deepEqual(h.entryPresentAtResolve, [false, false, true]);
  assert.deepEqual(h.sessionModels.get(SESSION_A)!.leaf, { uuid: uuidN(2) });
});

test("SessionModels: an entry awaiting its query echo is retained but outside the trees until the echo resolves it", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, entryEvent(assistantEntry(2)));
  const sessionModel = h.sessionModels.get(SESSION_A)!;
  assert.deepEqual(h.byUuidKeys(SESSION_A), [uuidN(2)]);
  assert.equal(sessionModel.leaf, null);
  h.feed(assistantQuery(2));
  assert.deepEqual(sessionModel.leaf, { uuid: uuidN(2) });
  assert.deepEqual(h.entryPresentAtResolve, [false, false, true]);
});

test("SessionModels: a frame whose entry arrived first resolves in its own step and leaves nothing pending", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, entryEvent(assistantEntry(2)));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  h.feed(assistantQuery(2));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [...fileOpenedA, [SESSION_A, uuidN(2)]]);
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
    ...fileOpenedA,
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
    ...fileOpenedA,
    [SESSION_A, uuidN(7)],
    [SESSION_A, uuidN(8)],
  ]);
});

test("SessionModels: a query-only frame with nothing pending ahead resolves in its own step as a known id", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(
    fileChanged(SESSION_A),
    scanComplete,
    sdkMessage("stream_event", { uuid: uuidN(8) }),
  );
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [...fileOpenedA, [SESSION_A, uuidN(8)]]);
  assert.deepEqual(h.entryPresentAtResolve, [false, false, false]);
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
    ...fileOpenedA,
    [SESSION_A, uuidN(1)],
    [SESSION_A, uuidN(7)],
  ]);
});

test("SessionModels: a contextChanged behind a boundary awaiting its echo fires when the boundary resolves, after its onResolved; behind a resolved entry it fires at once", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, assistantQuery(1));
  h.feed(entryEvent(assistantEntry(1)));
  assert.deepEqual(h.resolved, [...fileOpenedA, [SESSION_A, uuidN(1)]]);
  // The boundary entry precedes its frame: queued, and the contextChanged
  // waits with it.
  h.feed(entryEvent(boundaryEntry(7, 1)), contextChanged(7, 91));
  assert.deepEqual(h.contextChangedAfterResolved, []);
  h.feed({ kind: "sdkMessage", message: boundaryMessage(7) });
  assert.deepEqual(h.resolved, [
    ...fileOpenedA,
    [SESSION_A, uuidN(1)],
    [SESSION_A, uuidN(7)],
    [SESSION_A, uuidN(91)],
  ]);
  assert.deepEqual(h.contextChangedAfterResolved, [5]);
  // Nothing pending on session: the contextChanged resolves in its own step.
  h.feed(contextChanged(7, 92));
  assert.deepEqual(h.contextChangedAfterResolved, [5, 6]);
});

test("SessionModels: a contextChanged held before the snapshot cut is not replayed; one after it is", () => {
  const h = new Harness();
  h.feed(fileChanged(SESSION_A), scanComplete, contextChanged(7, 91));
  h.feed(contextChanged(7, 92));
  assert.deepEqual(h.contextChangedAfterResolved, []);
  h.sessionModels.applySnapshot([], 3, h.statesAfter[2]!);
  assert.deepEqual(h.resolved, [
    ...fileOpenedA,
    [SESSION_A, uuidN(91)],
    [SESSION_A, uuidN(92)],
  ]);
  assert.deepEqual(h.contextChangedAfterResolved, [4]);
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

test("SessionModels: subagent traffic is recorded like any query-only frame and retires with its query predecessor", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(
    fileChanged(SESSION_A),
    scanComplete,
    assistantQuery(1),
    sdkMessage("assistant", { uuid: uuidN(3), parent_tool_use_id: "tool-1" }),
    sdkMessage("stream_event", {
      uuid: uuidN(4),
      parent_tool_use_id: "tool-1",
    }),
  );
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(1), uuidN(3), uuidN(4)]);
  h.feed(entryEvent(assistantEntry(1)));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [
    ...fileOpenedA,
    [SESSION_A, uuidN(1)],
    [SESSION_A, uuidN(3)],
    [SESSION_A, uuidN(4)],
  ]);
});

test("SessionModels: a dequeued run is recorded as its joined prompt under the run key and retired by its entry", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(
    fileChanged(SESSION_A),
    scanComplete,
    init,
    queued(1, "one"),
    queued(2, "two"),
    dequeued("turn", [1, 2]),
  );
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(2)]);
  assert.equal(promptText(h, 2), "one\ntwo");
  h.feed(promptEntryEvent(2));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [
    ...fileOpenedA,
    initResolvedA,
    queuedResolvedA(1),
    queuedResolvedA(2),
    [SESSION_A, uuidN(2)],
  ]);
  assert.deepEqual(h.entryPresentAtResolve, [
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
});

test("SessionModels: a prompt whose entry arrived first resolves in its dequeue step and leaves nothing pending", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(
    fileChanged(SESSION_A),
    scanComplete,
    init,
    queued(1, "one"),
    promptEntryEvent(1),
  );
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  const beforeDequeue = [...fileOpenedA, initResolvedA, queuedResolvedA(1)];
  assert.deepEqual(h.resolved, beforeDequeue);
  h.feed(dequeued("turn", [1]));
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [...beforeDequeue, [SESSION_A, uuidN(1)]]);
  assert.deepEqual(h.entryPresentAtResolve, [false, false, false, false, true]);
});

test("SessionModels: each steer is recorded under its uuid and retired by its attachment, which onResolved carries", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(
    fileChanged(SESSION_A),
    scanComplete,
    init,
    queued(1, "one"),
    queued(2, "two"),
    dequeued("steer", [1]),
    dequeued("steer", [2]),
  );
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(1), uuidN(2)]);
  assert.equal(promptText(h, 1), "one");
  assert.equal(promptText(h, 2), "two");
  h.feed(steerEntryEvent(5, 1));
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(2)]);
  assert.deepEqual(h.resolved, [
    ...fileOpenedA,
    initResolvedA,
    queuedResolvedA(1),
    queuedResolvedA(2),
    [SESSION_A, uuidN(1)],
    [SESSION_A, uuidN(5)],
  ]);
  assert.deepEqual(h.entryPresentAtResolve, [
    false,
    false,
    false,
    false,
    false,
    true,
    true,
  ]);
});

test("SessionModels: a steer's attachment ahead of its dequeue stays out of the trees, unreported, until the dequeue resolves both nodes", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(
    fileChanged(SESSION_A),
    scanComplete,
    init,
    queued(1, "one"),
    steerEntryEvent(5, 1),
  );
  const sessionModel = h.sessionModels.get(SESSION_A)!;
  assert.deepEqual(h.byUuidKeys(SESSION_A), [uuidN(5)]);
  assert.equal(sessionModel.leaf, null);
  assert.deepEqual(h.resolved, [
    ...fileOpenedA,
    initResolvedA,
    queuedResolvedA(1),
  ]);
  h.feed(dequeued("steer", [1]));
  assert.deepEqual(sessionModel.leaf, { uuid: uuidN(5) });
  assert.deepEqual(h.pendingKeys(SESSION_A), []);
  assert.deepEqual(h.resolved, [
    ...fileOpenedA,
    initResolvedA,
    queuedResolvedA(1),
    [SESSION_A, uuidN(1)],
    [SESSION_A, uuidN(5)],
  ]);
  assert.deepEqual(h.entryPresentAtResolve, [
    false,
    false,
    false,
    false,
    true,
    true,
  ]);
});

test("SessionModels: seed holds the seed state's queued prompts for their dequeues", () => {
  const before = new Harness();
  before.feed(fileChanged(SESSION_A), scanComplete, init, queued(1, "one"));
  const h = new Harness(before.state);
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(dequeued("turn", [1]));
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(1)]);
  assert.equal(promptText(h, 1), "one");
});

test("SessionModels: a dequeue of a prompt this process never held is recorded frameless", () => {
  const h = new Harness();
  h.sessionModels.applySnapshot([], 0, h.state);
  h.feed(fileChanged(SESSION_A), scanComplete, init, dequeued("turn", [1]));
  assert.deepEqual(h.pendingKeys(SESSION_A), [uuidN(1)]);
  assert.equal(
    h.sessionModels.get(SESSION_A)!.queryMessages.get(uuidN(1)),
    undefined,
  );
  h.feed(promptEntryEvent(1));
  assert.deepEqual(h.resolved, [
    ...fileOpenedA,
    initResolvedA,
    [SESSION_A, uuidN(1)],
  ]);
});
