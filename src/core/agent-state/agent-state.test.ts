import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentState,
  excludedFromQuery,
  freshSessionState,
  initialAgentState,
  isIdle,
  leaf,
  nextAgentState,
  querySession,
  settled,
} from "./agent-state.ts";
import type { AgentEvent } from "../protocol.ts";
import type { SessionEntry } from "../session/file.ts";
import { hasPending, pending } from "../stream-merge.ts";

const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001" as const;
const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002" as const;
const uuidN = (n: number): UUID =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/** The hub's stamp on an event whose payload carries no uuid: distinct
 *  per call, from 1000 up so it never collides with a test's own ids. */
let stampCounter = 1000;
const stamp = (): UUID => uuidN(stampCounter++);

// The fold only inspects the fields each step reads, so minimal stubs
// suffice; assistant messages get the usage payload and the (wire-mandatory)
// parent_tool_use_id the fold reads. Every message names SESSION_A's file.
function queryMessage(
  type:
    "assistant" | "result" | "system" | "stream_event" | "conversation_reset",
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

/** A query message event as the hub emits it: stamped iff the message
 *  carries no uuid. */
function sdkMessage(
  type: Parameters<typeof queryMessage>[0],
  fields: Record<string, unknown> = {},
  eventStamp: UUID = stamp(),
): AgentEvent {
  const message = queryMessage(type, fields);
  return message.uuid === undefined
    ? { kind: "sdkMessage", message, uuid: eventStamp }
    : { kind: "sdkMessage", message };
}

/** A tracker event as `TrackedSessionLog` would publish it: the
 *  classification applied, the entry itself the leaf. */
function sessionEntry(
  entry: SessionEntry,
  overrides: Partial<Extract<AgentEvent, { kind: "sessionEntry" }>> = {},
): AgentEvent {
  return {
    kind: "sessionEntry",
    entry,
    expectsSdkMessage: !excludedFromQuery(entry),
    leaf: entry.uuid === undefined ? null : { uuid: entry.uuid },
    awaitingAnchors: [],
    ...overrides,
  };
}

const queryChanged = (sessionId: UUID): AgentEvent => ({
  kind: "querySessionChanged",
  sessionId,
});
const fileChanged = (sessionId: UUID): AgentEvent => ({
  kind: "sessionFileChanged",
  sessionId,
});
const rescan = (n: number): AgentEvent => ({
  kind: "sessionFileChanged",
  sessionId: SESSION_A,
  uuid: uuidN(n),
});
const scanComplete: AgentEvent = { kind: "scanComplete", uuid: uuidN(900) };
const trackerAnomaly = (
  n: number,
  stream: "query" | "session",
  anomaly: AgentState["anomaly"] & object,
): AgentEvent => ({ kind: "trackerAnomaly", uuid: uuidN(n), stream, anomaly });

function userMessage(overrides: Partial<SDKUserMessage> = {}): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
    ...overrides,
  };
}

/** The prompt is stamped `uuidN(id)`; the event carries its own stamp,
 *  a query node in its own right. */
function queued(
  id: number,
  overrides: Partial<SDKUserMessage> = {},
  eventStamp: UUID = stamp(),
): AgentEvent {
  return {
    kind: "userMessageQueued",
    uuid: eventStamp,
    message: userMessage({ uuid: uuidN(id), ...overrides }),
  };
}

function dequeued(
  delivery: "turn" | "steer" | "append",
  [first, ...rest]: [number, ...number[]],
): AgentEvent {
  return {
    kind: "userMessageDequeued",
    delivery,
    uuids: [uuidN(first), ...rest.map(uuidN)],
  };
}

/** The hub's construction: SESSION_A announced as the query session before
 *  anything is observed on it. */
const announcedA: AgentState = nextAgentState(
  initialAgentState(),
  queryChanged(SESSION_A),
);

function run(events: AgentEvent[], from = announcedA): AgentState {
  return events.reduce(nextAgentState, from);
}

function queuedIds(state: AgentState): UUID[] {
  return state.queuedMessages.map((entry) => entry.uuid);
}

test("initial state is idle with empty arrays", () => {
  assert.equal(initialAgentState().activity, "idle");
  assert.deepEqual(initialAgentState().queuedMessages, []);
  assert.deepEqual(initialAgentState().observedPermissionModes, []);
  assert.equal(isIdle(initialAgentState()), true);
});

test("querying message queued while idle → pending", () => {
  const state = run([queued(1)]);
  assert.equal(state.activity, "pending");
  assert.deepEqual(queuedIds(state), [uuidN(1)]);
  assert.equal(isIdle(state), false);
});

test("non-querying message queued while idle stays idle", () => {
  const state = run([queued(1, { shouldQuery: false })]);
  assert.equal(state.activity, "idle");
  assert.deepEqual(queuedIds(state), [uuidN(1)]);
  assert.equal(isIdle(state), true);
});

test("turn dequeue removes the entry without changing activity", () => {
  const state = run([queued(1), dequeued("turn", [1])]);
  assert.equal(state.activity, "pending");
  assert.deepEqual(state.queuedMessages, []);
});

test("assistant message confirms the turn started", () => {
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
  ]);
  assert.equal(state.activity, "working");
});

test("result with nothing queued → idle", () => {
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    sdkMessage("result"),
  ]);
  assert.equal(state.activity, "idle");
});

test("result with a querying message still queued → pending, never idle", () => {
  // The about-to-run bucket's dequeue event follows the result on the stream,
  // so at the result the entry is still in the fold's queue.
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    queued(2, { priority: "later" }),
    sdkMessage("result"),
  ]);
  assert.equal(state.activity, "pending");
  assert.deepEqual(queuedIds(state), [uuidN(2)]);
  const done = run(
    [dequeued("turn", [2]), sdkMessage("assistant"), sdkMessage("result")],
    state,
  );
  assert.equal(done.activity, "idle");
  assert.deepEqual(done.queuedMessages, []);
});

test("merge accounting: one dequeue for two laters, idle after one result", () => {
  // Regression for the Phase-1 leak: two laters run merged as ONE turn with
  // ONE result; a per-message depth would strand at 1 and never reach idle.
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    queued(2, { priority: "later" }),
    queued(3, { priority: "later" }),
    sdkMessage("result"), // pending: ids 2 and 3 still queued
    dequeued("turn", [2, 3]), // the merged bucket
    sdkMessage("assistant"),
    sdkMessage("result"),
  ]);
  assert.equal(state.activity, "idle");
  assert.deepEqual(state.queuedMessages, []);
});

test("steer dequeue removes entries mid-turn without changing activity", () => {
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    queued(2),
    dequeued("steer", [2]),
  ]);
  assert.equal(state.activity, "working");
  assert.deepEqual(state.queuedMessages, []);
  const done = run([sdkMessage("result")], state);
  assert.equal(done.activity, "idle");
});

test("non-querying entry may sit across idle; append dequeue clears it", () => {
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    queued(2, { priority: "later", shouldQuery: false }),
    sdkMessage("result"), // Q === 0 → idle, entry 2 still queued
  ]);
  assert.equal(state.activity, "idle");
  assert.deepEqual(queuedIds(state), [uuidN(2)]);
  const done = run([dequeued("append", [2])], state);
  assert.equal(done.activity, "idle");
  assert.deepEqual(done.queuedMessages, []);
});

test("compact: compacting is exited by result, not assistant output", () => {
  const compactSent: AgentEvent = {
    kind: "compactSent",
    uuid: stamp(),
    message: userMessage(),
  };
  const compacting = run([compactSent]);
  assert.equal(compacting.activity, "compacting");
  // Assistant output during compaction does not flip to working.
  const still = nextAgentState(compacting, sdkMessage("assistant"));
  assert.equal(still.activity, "compacting");
  const done = nextAgentState(still, sdkMessage("result"));
  assert.equal(done.activity, "idle");
});

test("compact with a later turn queued behind it", () => {
  const state = run([
    { kind: "compactSent", uuid: stamp(), message: userMessage() },
    queued(1, { priority: "later" }),
    sdkMessage("result"), // compaction finished
  ]);
  assert.equal(state.activity, "pending");
  assert.deepEqual(queuedIds(state), [uuidN(1)]);
});

test("interruptSent and non-tracking controlApplied only observe their node on query", () => {
  const working = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant", {}, uuidN(2)),
  ]);
  const before = pending(fileA(working).merge, "query");
  const interrupted = nextAgentState(working, {
    kind: "interruptSent",
    uuid: uuidN(3),
  });
  const reloaded = nextAgentState(interrupted, {
    kind: "controlApplied",
    uuid: uuidN(4),
    request: { type: "reload-plugins" },
  });
  for (const state of [interrupted, reloaded]) {
    assert.equal(state.activity, working.activity);
    assert.deepEqual(state.queuedMessages, working.queuedMessages);
    assert.equal(state.anomaly, undefined);
  }
  assert.deepEqual(pending(fileA(reloaded).merge, "query"), [
    ...before,
    uuidN(3),
    uuidN(4),
  ]);
  assert.deepEqual(fileA(reloaded).merge.nodes[uuidN(4)]!.excludedFrom, [
    "session",
  ]);
});

test("unexpected result while idle stays idle", () => {
  const state = nextAgentState(announcedA, sdkMessage("result"));
  assert.equal(state.activity, "idle");
});

test("a query message on a session never announced is a merge-error anomaly", () => {
  const state = nextAgentState(initialAgentState(), sdkMessage("result"));
  assert.equal(state.anomaly?.kind, "merge-error");
  assert.match(state.anomaly!.detail, /not announced/);
  assert.deepEqual(state.sessions, {});
});

test("subagent user/assistant messages are observed on query only, with no other effect", () => {
  const working = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
  ]);
  // A subagent assistant must not overwrite lastUsage, advance the leaf, or
  // clear the delivered hold; same for a subagent user message or
  // stream_event. None of their ids can meet an entry in this file, so
  // each is excluded from session.
  const afterSub = run(
    [
      sdkMessage("assistant", {
        parent_tool_use_id: "tool-1",
        uuid: uuidN(0xaa),
        message: { usage: { input_tokens: 999, output_tokens: 999 } },
      }),
      sdkMessage("stream_event", {
        parent_tool_use_id: "tool-1",
        uuid: uuidN(0xac),
        event: { type: "message_start" },
      }),
      {
        kind: "sdkMessage",
        message: userMessage({
          parent_tool_use_id: "tool-1",
          uuid: uuidN(0xab),
          session_id: SESSION_A,
        }) as SDKMessage,
      },
    ],
    working,
  );
  assert.equal(afterSub.activity, working.activity);
  assert.equal(afterSub.anomaly, undefined);
  assert.equal(fileA(afterSub).lastUsage?.input_tokens, 5);
  assert.equal(fileA(afterSub).pendingLeaf, fileA(working).pendingLeaf);
  assert.deepEqual(pending(fileA(afterSub).merge, "query"), [
    ...pending(fileA(working).merge, "query"),
    uuidN(0xaa),
    uuidN(0xac),
    uuidN(0xab),
  ]);
  for (const id of [uuidN(0xaa), uuidN(0xac), uuidN(0xab)]) {
    assert.deepEqual(fileA(afterSub).merge.nodes[id]!.excludedFrom, [
      "session",
    ]);
  }
});

test("compact_boundary with post_tokens becomes lastUsage; without, drops it", () => {
  const working = run([sdkMessage("assistant")]);
  assert.equal(querySession(working)?.lastUsage?.input_tokens, 5);
  const updated = nextAgentState(
    working,
    sdkMessage("system", {
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 150_000,
        post_tokens: 12_000,
      },
    }),
  );
  assert.deepEqual(querySession(updated)?.lastUsage, {
    input_tokens: 12_000,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  const dropped = nextAgentState(
    working,
    sdkMessage("system", {
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 150_000 },
    }),
  );
  assert.equal(querySession(dropped)?.lastUsage, undefined);
  assert.equal("lastUsage" in querySession(dropped)!, false);
});

test("other message types do not change activity or the queue", () => {
  const pendingTurn = run([queued(1)]);
  for (const event of [sdkMessage("system"), sdkMessage("stream_event")]) {
    const state = nextAgentState(pendingTurn, event);
    assert.equal(state.activity, "pending");
    assert.deepEqual(state.queuedMessages, pendingTurn.queuedMessages);
  }
});

test("invariant: idle implies no querying entries across a busy scenario", () => {
  const events: AgentEvent[] = [
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    queued(2, { priority: "later" }),
    queued(3), // demotable, steered mid-turn
    dequeued("steer", [3]),
    sdkMessage("result"),
    dequeued("turn", [2]),
    sdkMessage("assistant"),
    sdkMessage("result"),
  ];
  let state = initialAgentState();
  for (const event of events) {
    state = nextAgentState(state, event);
    if (state.activity === "idle") {
      assert.equal(
        state.queuedMessages.filter(
          (entry) => entry.message.shouldQuery !== false,
        ).length,
        0,
      );
    }
  }
  assert.equal(state.activity, "idle");
  assert.deepEqual(state.queuedMessages, []);
});

// --- session / model / permission-mode observation ---------------------------

function init(fields: Record<string, unknown> = {}): AgentEvent {
  return sdkMessage("system", {
    subtype: "init",
    model: "opus",
    cwd: "/work",
    permissionMode: "default",
    uuid: undefined,
    ...fields,
  });
}

test("conversation_reset preserves queued work and activity", () => {
  const before: AgentState = {
    ...announcedA,
    activity: "working",
    queuedMessages: [
      { uuid: uuidN(2), message: userMessage({ priority: "later" }) },
    ],
  };
  const state = nextAgentState(
    before,
    sdkMessage("conversation_reset", {
      new_conversation_id: "new-session",
    }),
  );
  assert.deepEqual(queuedIds(state), [uuidN(2)]);
  assert.equal(state.activity, "working");
});

test("querySessionChanged sets the query session; system/init sets model, cwd, and observes the mode", () => {
  assert.equal(initialAgentState().querySessionId, undefined);
  assert.equal(announcedA.querySessionId, SESSION_A);
  const state = run([init()]);
  assert.equal(state.model, "opus");
  assert.equal(state.cwd, "/work");
  assert.equal(state.permissionMode, "default");
  assert.deepEqual(state.observedPermissionModes, ["default"]);
});

// A resumed session can fork: the query moves to a new session id whose
// file never contains the resumed file's leaf. The leaf is per file, so
// the announcement moves the query file and the leaf follows.
test("querySessionChanged to a different session id moves the query file; the leaf follows", () => {
  const forked = "aaaaaaaa-0000-0000-0000-00000000000f" as UUID;
  const seeded: AgentState = {
    ...initialAgentState(),
    querySessionId: SESSION_A,
    sessions: {
      [SESSION_A]: {
        ...freshSessionState(),
        treeLeaf: { uuid: "00000000-0000-0000-0000-00000000000a" },
      },
    },
  };
  assert.deepEqual(leaf(seeded), {
    uuid: "00000000-0000-0000-0000-00000000000a",
  });
  const state = nextAgentState(seeded, queryChanged(forked));
  assert.equal(state.querySessionId, forked);
  assert.equal(leaf(state), null);
  assert.deepEqual(leaf(nextAgentState(seeded, init())), {
    uuid: "00000000-0000-0000-0000-00000000000a",
  });
});

test("system/status with a permissionMode observes it; without one, no change", () => {
  const state = run([
    init(),
    sdkMessage("system", { subtype: "status", permissionMode: "plan" }),
  ]);
  assert.equal(state.permissionMode, "plan");
  assert.deepEqual(state.observedPermissionModes, ["default", "plan"]);
  const unchanged = nextAgentState(
    state,
    sdkMessage("system", { subtype: "status" }),
  );
  assert.equal(unchanged.permissionMode, "plan");
  assert.deepEqual(unchanged.observedPermissionModes, ["default", "plan"]);
});

test("observedPermissionModes is duplicate-free, first-observed order", () => {
  const state = run([
    init(),
    sdkMessage("system", { subtype: "status", permissionMode: "plan" }),
    sdkMessage("system", { subtype: "status", permissionMode: "default" }),
  ]);
  assert.equal(state.permissionMode, "default");
  assert.deepEqual(state.observedPermissionModes, ["default", "plan"]);
});

test("controlApplied set-model updates model; undefined means SDK default", () => {
  const state = run([
    init(),
    {
      kind: "controlApplied",
      uuid: stamp(),
      request: { type: "set-model", model: "sonnet" },
    },
  ]);
  assert.equal(state.model, "sonnet");
  const reset = nextAgentState(state, {
    kind: "controlApplied",
    uuid: stamp(),
    request: { type: "set-model" },
  });
  assert.equal(reset.model, undefined);
});

test("controlApplied apply-flag-settings folds effortLevel; null unsets", () => {
  const applied = (settings: {
    effortLevel?: "low" | "medium" | "high" | "xhigh" | null;
  }): AgentEvent => ({
    kind: "controlApplied",
    uuid: stamp(),
    request: { type: "apply-flag-settings", settings },
  });
  const state = run([applied({ effortLevel: "xhigh" })]);
  assert.equal(state.effortLevel, "xhigh");
  // Settings without the key leave the level alone.
  assert.equal(nextAgentState(state, applied({})).effortLevel, "xhigh");
  const unset = nextAgentState(state, applied({ effortLevel: null }));
  assert.equal(unset.effortLevel, undefined);
  assert.equal("effortLevel" in unset, false);
});

test("controlApplied set-permission-mode observes the mode", () => {
  const state = run([
    {
      kind: "controlApplied",
      uuid: stamp(),
      request: { type: "set-permission-mode", mode: "acceptEdits" },
    },
  ]);
  assert.equal(state.permissionMode, "acceptEdits");
  assert.deepEqual(state.observedPermissionModes, ["acceptEdits"]);
});

// --- prompt identity ---------------------------------------------------------
// A prompt's dequeue is its `query` observation under the stamped uuid
// (uuidN(n) here); its file entry — a merged run's under the last id, a
// steer's `queued_command` attachment naming it as source_uuid — is the
// `session` one. `withQuerySession` makes SESSION_A (announced by
// `announcedA`) the tracked file too, scanned: its start node resolves and
// nothing pends.

const withQuerySession: AgentEvent[] = [
  init(),
  fileChanged(SESSION_A),
  scanComplete,
];
const steerEntry = (n: number, source: number): AgentEvent =>
  sessionEntry({
    type: "attachment",
    uuid: uuidN(n),
    attachment: {
      type: "queued_command",
      prompt: "steer text",
      source_uuid: uuidN(source),
    },
  });
const resolvedIds = (state: AgentState): UUID[] =>
  fileA(state).resolved.map((node) => node.id);

test("turn dequeue observes the run key on query and holds it as the pending leaf until its entry", () => {
  const dequeuedState = run([
    ...withQuerySession,
    queued(1),
    queued(2),
    dequeued("turn", [1, 2]),
  ]);
  assert.deepEqual(dequeuedState.queuedMessages, []);
  const file = fileA(dequeuedState);
  assert.deepEqual(pending(file.merge, "query"), [uuidN(2)]);
  assert.equal(file.pendingLeaf, uuidN(2));
  assert.deepEqual(leaf(dequeuedState), { uuid: uuidN(2) });
  assert.equal(settled(dequeuedState), false);
  const filed = nextAgentState(dequeuedState, promptEntry(2));
  assert.deepEqual(fileA(filed).merge.nodes, {});
  assert.equal(fileA(filed).pendingLeaf, null);
  assert.deepEqual(resolvedIds(filed), [uuidN(2)]);
  assert.equal(settled(filed), true);
  assert.equal(filed.anomaly, undefined);
});

test("append dequeue observes like a turn; a dequeue without a query session only leaves the queue", () => {
  const appended = run([
    ...withQuerySession,
    queued(1, { shouldQuery: false }),
    dequeued("append", [1]),
  ]);
  assert.deepEqual(pending(fileA(appended).merge, "query"), [uuidN(1)]);
  const sessionless = run(
    [queued(1), dequeued("turn", [1])],
    initialAgentState(),
  );
  assert.deepEqual(sessionless.queuedMessages, []);
  assert.deepEqual(sessionless.sessions, {});
  assert.equal(sessionless.anomaly?.kind, "merge-error");
});

test("a prompt entry ahead of its dequeue pends on session, not excluded from query; the dequeue resolves it", () => {
  const ahead = run([...withQuerySession, queued(1), promptEntry(1)]);
  assert.deepEqual(pending(fileA(ahead).merge, "session"), [uuidN(1)]);
  assert.equal(ahead.anomaly, undefined);
  const caughtUp = nextAgentState(ahead, dequeued("turn", [1]));
  assert.deepEqual(fileA(caughtUp).merge.nodes, {});
  assert.equal(fileA(caughtUp).pendingLeaf, null);
  assert.deepEqual(resolvedIds(caughtUp), [uuidN(1)]);
  assert.equal(caughtUp.anomaly, undefined);
});

test("each steer dequeue observes its uuid without predicting a leaf; each attachment's source_uuid resolves its own", () => {
  const steered = run([
    ...withQuerySession,
    queued(1),
    queued(2),
    dequeued("steer", [1]),
    dequeued("steer", [2]),
  ]);
  const file = fileA(steered);
  assert.deepEqual(pending(file.merge, "query"), [uuidN(1), uuidN(2)]);
  assert.equal(file.pendingLeaf, null);
  const one = nextAgentState(steered, steerEntry(5, 1));
  assert.deepEqual(pending(fileA(one).merge, "query"), [uuidN(2)]);
  assert.deepEqual(resolvedIds(one), [uuidN(5), uuidN(1)]);
  const both = nextAgentState(one, steerEntry(6, 2));
  assert.deepEqual(fileA(both).merge.nodes, {});
  assert.equal(both.anomaly, undefined);
});

test("an attachment ahead of its steer dequeue pends its source on session; the dequeue resolves it", () => {
  const ahead = run([...withQuerySession, queued(1), steerEntry(5, 1)]);
  assert.deepEqual(pending(fileA(ahead).merge, "session"), [uuidN(1)]);
  const caughtUp = nextAgentState(ahead, dequeued("steer", [1]));
  assert.deepEqual(fileA(caughtUp).merge.nodes, {});
  assert.equal(caughtUp.anomaly, undefined);
});

test("historical prompt and attachment entries (no queued id) are session-only and resolve at once", () => {
  const state = run([...withQuerySession, promptEntry(3), steerEntry(5, 7)]);
  assert.deepEqual(fileA(state).merge.nodes, {});
  assert.equal(state.anomaly, undefined);
});

test("dequeue ids not present in queuedMessages still observe: the entry may already have passed", () => {
  const state = run([
    ...withQuerySession,
    queued(1),
    dequeued("turn", [1, 99]),
  ]);
  assert.deepEqual(state.queuedMessages, []);
  assert.deepEqual(pending(fileA(state).merge, "query"), [uuidN(99)]);
});

test("conversation_reset excludes the reset prompt (the last query-pending id awaiting the file) from the old file; its own stamp follows", () => {
  const state = run([
    ...withQuerySession,
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("conversation_reset", { new_conversation_id: "x" }, uuidN(4)),
  ]);
  assert.deepEqual(fileA(state).merge.nodes, {});
  assert.equal(fileA(state).pendingLeaf, null);
  assert.deepEqual(resolvedIds(state), [uuidN(1), uuidN(4)]);
  assert.equal(state.anomaly, undefined);
});

test("conversation_reset's exclusion resolves in stream order, behind earlier pending ids", () => {
  const reset = run([
    ...withQuerySession,
    assistantQuery(3),
    queued(1, {}, uuidN(5)),
    dequeued("turn", [1]),
    sdkMessage("conversation_reset", { new_conversation_id: "x" }, uuidN(4)),
  ]);
  assert.deepEqual(pending(fileA(reset).merge, "query"), [
    uuidN(3),
    uuidN(5),
    uuidN(1),
    uuidN(4),
  ]);
  assert.deepEqual(fileA(reset).merge.nodes[uuidN(1)]!.excludedFrom, [
    "session",
  ]);
  const caughtUp = nextAgentState(reset, assistantEntry(3));
  assert.deepEqual(fileA(caughtUp).merge.nodes, {});
  assert.deepEqual(resolvedIds(caughtUp), [
    uuidN(3),
    uuidN(5),
    uuidN(1),
    uuidN(4),
  ]);
  assert.equal(caughtUp.anomaly, undefined);
});

test("conversation_reset with nothing pending on query resolves only its own stamp", () => {
  const state = run([
    ...withQuerySession,
    sdkMessage("conversation_reset", { new_conversation_id: "x" }, uuidN(4)),
  ]);
  assert.deepEqual(fileA(state).merge.nodes, {});
  assert.deepEqual(resolvedIds(state), [uuidN(4)]);
  assert.equal(state.anomaly, undefined);
});

test("contextChanged is a session node that resolves behind the entry it followed; the tip it carries is folded from that entry", () => {
  const ahead = run([...withQuerySession, assistantEntry(2)]);
  const changed = nextAgentState(ahead, {
    kind: "contextChanged",
    uuid: uuidN(9),
    boundary: uuidN(7),
    leaf: { uuid: uuidN(2) },
  });
  assert.deepEqual(pending(fileA(changed).merge, "session"), [
    uuidN(2),
    uuidN(9),
  ]);
  assert.equal(leaf(changed), leaf(ahead));
  const caughtUp = nextAgentState(changed, assistantQuery(2));
  assert.deepEqual(resolvedIds(caughtUp), [uuidN(2), uuidN(9)]);
  assert.equal(caughtUp.anomaly, undefined);
});

const shutdown: AgentEvent = {
  kind: "shutdown",
  uuid: uuidN(9),
  reason: "test",
};

test("shutdown is a query node of every session that resolves behind the query tail", () => {
  const state = run([...withQuerySession, assistantQuery(2), shutdown]);
  assert.deepEqual(pending(fileA(state).merge, "query"), [uuidN(2), uuidN(9)]);
  assert.deepEqual(pending(fileA(state).merge, "session"), []);
  const done = nextAgentState(state, assistantEntry(2));
  assert.deepEqual(resolvedIds(done), [uuidN(2), uuidN(9)]);
  assert.equal(done.anomaly, undefined);
});

test("shutdown leaves a session-pending id alone: it resolves in its own step, the entry still awaits its query twin", () => {
  const state = run([...withQuerySession, assistantEntry(3), shutdown]);
  assert.deepEqual(resolvedIds(state), [uuidN(9)]);
  assert.deepEqual(pending(fileA(state).merge, "session"), [uuidN(3)]);
  assert.equal(state.anomaly, undefined);
});

// --- merge rules (spec, Fold rules) ------------------------------------------
// Ids: uuidN(n); assistant messages/entries are shared, system/init is
// query-only, a user prompt entry is session-only.

const assistantQuery = (n: number, usage = 5): AgentEvent =>
  sdkMessage("assistant", {
    uuid: uuidN(n),
    message: { usage: { input_tokens: usage, output_tokens: 7 }, model: "q" },
  });
const assistantEntry = (
  n: number,
  overrides: Partial<Extract<AgentEvent, { kind: "sessionEntry" }>> = {},
): AgentEvent => sessionEntry({ type: "assistant", uuid: uuidN(n) }, overrides);
const promptEntry = (n: number): AgentEvent =>
  sessionEntry({
    type: "user",
    uuid: uuidN(n),
    message: { role: "user", content: "hi" },
  });

function fileA(state: AgentState) {
  const file = state.sessions[SESSION_A];
  assert.notEqual(file, undefined);
  return file!;
}

test("querySessionChanged creates the file headed by its start node; query-only ids pend behind it until sessionFileChanged resolves the start", () => {
  assert.deepEqual(pending(fileA(announcedA).merge, "query"), [SESSION_A]);
  assert.equal(settled(announcedA), true);
  const state = run([init({ uuid: uuidN(1) })]);
  assert.deepEqual(pending(fileA(state).merge, "query"), [SESSION_A, uuidN(1)]);
  assert.equal(settled(state), true);
  assert.equal(state.anomaly, undefined);
  const started = nextAgentState(state, fileChanged(SESSION_A));
  assert.deepEqual(fileA(started).merge.nodes, {});
  assert.deepEqual(resolvedIds(started), [SESSION_A, uuidN(1)]);
  assert.equal(started.anomaly, undefined);
});

test("a second session's start pends its query messages until the follower moves to it", () => {
  const state = run([
    ...withQuerySession,
    queryChanged(SESSION_B),
    sdkMessage("assistant", { uuid: uuidN(3), session_id: SESSION_B }),
  ]);
  assert.equal(state.querySessionId, SESSION_B);
  assert.equal(state.fileSessionId, SESSION_A);
  const fileB = state.sessions[SESSION_B]!;
  assert.deepEqual(pending(fileB.merge, "query"), [SESSION_B, uuidN(3)]);
  assert.equal(settled(state), false);
  const switched = nextAgentState(state, fileChanged(SESSION_B));
  assert.deepEqual(
    switched.sessions[SESSION_B]!.resolved.map((node) => node.id),
    [SESSION_B],
  );
  assert.deepEqual(pending(switched.sessions[SESSION_B]!.merge, "query"), [
    uuidN(3),
  ]);
  assert.equal(switched.anomaly, undefined);
});

test("a shared query id pends on session and is the leaf until its entry resolves it", () => {
  const unsettled = run([assistantQuery(2)]);
  const file = fileA(unsettled);
  assert.equal(hasPending(file.merge, "query"), true);
  assert.equal(file.pendingLeaf, uuidN(2));
  assert.deepEqual(leaf(unsettled), { uuid: uuidN(2) });
  assert.equal(settled(unsettled), false);
  assert.equal(file.lastUsage?.input_tokens, 5);
  assert.equal(file.model, "q");

  const logLeaf = { uuid: uuidN(2), viaBoundary: uuidN(9) };
  const resolved = run(
    [
      fileChanged(SESSION_A),
      scanComplete,
      assistantEntry(2, {
        leaf: logLeaf,
        lastAssistant: {
          usage: { input_tokens: 9, output_tokens: 1 } as never,
          model: "m",
        },
      }),
    ],
    unsettled,
  );
  const settledFile = fileA(resolved);
  assert.deepEqual(settledFile.merge.nodes, {});
  assert.equal(settledFile.pendingLeaf, null);
  assert.deepEqual(leaf(resolved), logLeaf);
  assert.equal(settled(resolved), true);
  assert.equal(settledFile.lastUsage?.input_tokens, 9);
  assert.equal(settledFile.model, "m");
  assert.equal(resolved.anomaly, undefined);
});

test("log entries ahead of the query stream keep the file settled; the query message resolves them", () => {
  const ahead = run([
    init({ uuid: uuidN(1) }),
    fileChanged(SESSION_A),
    scanComplete,
    promptEntry(3),
    assistantEntry(2),
  ]);
  assert.deepEqual(pending(fileA(ahead).merge, "session"), [uuidN(2)]);
  assert.equal(settled(ahead), true);
  const caughtUp = nextAgentState(ahead, assistantQuery(2));
  assert.deepEqual(fileA(caughtUp).merge.nodes, {});
  assert.equal(caughtUp.anomaly, undefined);
});

test("scan: entries before the first query-reported id are excluded from query; meeting one ends the exclusion", () => {
  const state = run([
    assistantQuery(3),
    fileChanged(SESSION_A),
    assistantEntry(1),
    assistantEntry(3),
    assistantEntry(4),
  ]);
  const file = fileA(state);
  assert.equal(file.scanExcluded, false);
  assert.deepEqual(pending(file.merge, "session"), [uuidN(4)]);
  assert.equal(file.pendingLeaf, null);
  assert.equal(settled(state), true);
  const done = run([scanComplete, assistantQuery(4)], state);
  assert.deepEqual(fileA(done).merge.nodes, {});
  assert.equal(done.anomaly, undefined);
});

test("log-side usage, model and version apply only once the file is settled", () => {
  const evidence = {
    lastAssistant: {
      usage: { input_tokens: 9, output_tokens: 1 } as never,
      model: "m",
    },
  };
  const unsettled = run([
    assistantQuery(2),
    assistantQuery(5),
    fileChanged(SESSION_A),
    scanComplete,
    sessionEntry(
      { type: "assistant", uuid: uuidN(2), version: "9.9.9" },
      evidence,
    ),
  ]);
  assert.equal(settled(unsettled), false);
  assert.equal(fileA(unsettled).lastUsage?.input_tokens, 5);
  assert.equal(fileA(unsettled).model, "q");
  assert.equal(unsettled.claudeCodeVersion, undefined);

  const settledState = nextAgentState(
    unsettled,
    sessionEntry(
      { type: "assistant", uuid: uuidN(5), version: "9.9.9" },
      evidence,
    ),
  );
  assert.equal(fileA(settledState).lastUsage?.input_tokens, 9);
  assert.equal(fileA(settledState).model, "m");
  assert.equal(settledState.claudeCodeVersion, "9.9.9");

  // Absent log evidence unsets both.
  const cleared = nextAgentState(settledState, promptEntry(6));
  assert.equal("lastUsage" in fileA(cleared), false);
  assert.equal("model" in fileA(cleared), false);
});

test("awaiting anchors keep the file unsettled", () => {
  const waiting = run([
    init({ uuid: uuidN(1) }),
    fileChanged(SESSION_A),
    scanComplete,
    promptEntry(3),
    sessionEntry(
      { type: "system", subtype: "compact_boundary", uuid: uuidN(7) },
      {
        awaitingAnchors: [uuidN(7)],
      },
    ),
  ]);
  assert.equal(settled(waiting), false);
  const anchored = nextAgentState(waiting, promptEntry(8));
  assert.equal(settled(anchored), true);
});

test("a duplicate query observation is a merge-error anomaly; the message still folds and the next fold clears it", () => {
  const state = run([assistantQuery(2), assistantQuery(2, 6)]);
  assert.equal(state.anomaly?.kind, "merge-error");
  assert.ok(state.anomaly?.detail.includes(uuidN(2)));
  assert.equal(fileA(state).lastUsage?.input_tokens, 6);
  assert.equal(nextAgentState(state, assistantQuery(3)).anomaly, undefined);
});

test("a log entry for an id the classification excluded from session is a classification anomaly", () => {
  const state = run([
    assistantQuery(2),
    init({ uuid: uuidN(1) }),
    fileChanged(SESSION_A),
    scanComplete,
    sessionEntry({ type: "system", subtype: "init", uuid: uuidN(1) }),
  ]);
  assert.equal(state.anomaly?.kind, "classification");
  assert.ok(state.anomaly?.detail.includes("system/init"));
});

test("a stream skipping an id is a head-mismatch anomaly naming it", () => {
  const state = run([
    assistantQuery(2),
    assistantQuery(3),
    fileChanged(SESSION_A),
    scanComplete,
    assistantEntry(3),
  ]);
  assert.equal(state.anomaly?.kind, "head-mismatch");
  assert.ok(state.anomaly?.detail.includes(uuidN(2)));
  assert.deepEqual(fileA(state).merge.nodes, {});
});

test("resolved lists what the step resolved and is empty on the next state", () => {
  const pendingOnSession = run([
    assistantQuery(2),
    fileChanged(SESSION_A),
    scanComplete,
  ]);
  assert.deepEqual(fileA(pendingOnSession).resolved, [
    { id: uuidN(900), seenOn: ["session"], excludedFrom: ["query"] },
  ]);
  const entryResolves = nextAgentState(pendingOnSession, assistantEntry(2));
  assert.deepEqual(fileA(entryResolves).resolved, [
    { id: uuidN(2), seenOn: ["query", "session"], excludedFrom: [] },
  ]);
  const sessionOnly = nextAgentState(entryResolves, promptEntry(3));
  assert.deepEqual(fileA(sessionOnly).resolved, [
    { id: uuidN(3), seenOn: ["session"], excludedFrom: ["query"] },
  ]);
  const stamped = nextAgentState(
    sessionOnly,
    sdkMessage("result", {}, uuidN(4)),
  );
  assert.deepEqual(fileA(stamped).resolved, [
    { id: uuidN(4), seenOn: ["query"], excludedFrom: ["session"] },
  ]);
});

test("resolved accumulates every resolution of one step, in resolution order", () => {
  // The session stream skipping 2 resolves 2 and 3 together (head-mismatch).
  const state = run([
    assistantQuery(2),
    assistantQuery(3),
    fileChanged(SESSION_A),
    scanComplete,
    assistantEntry(3),
  ]);
  assert.deepEqual(
    fileA(state).resolved.map((node) => node.id),
    [uuidN(2), uuidN(3)],
  );
});

test("trackerAnomaly sets the anomaly for one fold and observes its node on its stream", () => {
  const anomaly = { kind: "malformed-line", detail: "bytes 10-20" } as const;
  const state = run([
    ...withQuerySession,
    assistantQuery(2),
    trackerAnomaly(8, "query", anomaly),
  ]);
  assert.deepEqual(state.anomaly, anomaly);
  assert.deepEqual(pending(fileA(state).merge, "query"), [uuidN(2), uuidN(8)]);
  const onSession = nextAgentState(
    state,
    trackerAnomaly(9, "session", anomaly),
  );
  assert.deepEqual(onSession.anomaly, anomaly);
  assert.deepEqual(resolvedIds(onSession), [uuidN(9)]);
  assert.equal(
    nextAgentState(onSession, sdkMessage("result")).anomaly,
    undefined,
  );
});

test("sessionAppended ids are query action items resolved by their entries", () => {
  const appended = run([
    init({ uuid: uuidN(1) }),
    fileChanged(SESSION_A),
    scanComplete,
    {
      kind: "sessionAppended",
      message: userMessage({ uuid: uuidN(6), session_id: SESSION_A }),
    },
    {
      kind: "sessionAppended",
      message: queryMessage("system", {
        subtype: "compact_boundary",
        uuid: uuidN(7),
        compact_metadata: { trigger: "manual", pre_tokens: 100 },
      }),
    },
  ]);
  assert.deepEqual(pending(fileA(appended).merge, "query"), [
    uuidN(6),
    uuidN(7),
  ]);
  assert.equal(settled(appended), false);
  const drained = run([assistantEntry(6), assistantEntry(7)], appended);
  assert.equal(settled(drained), true);
  assert.equal(drained.anomaly, undefined);
});

test("sessionFileChanged to another id drops the old file and adopts the announced one", () => {
  const state = run([
    fileChanged(SESSION_A),
    scanComplete,
    assistantQuery(2),
    queryChanged(SESSION_B),
    sdkMessage("assistant", { uuid: uuidN(3), session_id: SESSION_B }),
    fileChanged(SESSION_B),
  ]);
  assert.equal(state.fileSessionId, SESSION_B);
  assert.deepEqual(Object.keys(state.sessions), [SESSION_B]);
  assert.deepEqual(pending(state.sessions[SESSION_B]!.merge, "query"), [
    uuidN(3),
  ]);
});

test("a rescan (sessionFileChanged to the same id) rebuilds from the query side's pending observations; its own node resolves alone", () => {
  const before = run([
    assistantQuery(2),
    init({ uuid: uuidN(1) }),
    fileChanged(SESSION_A),
    scanComplete,
    promptEntry(3),
  ]);
  assert.notEqual(fileA(before).treeLeaf, null);
  const rescanned = nextAgentState(before, rescan(9));
  assert.deepEqual(resolvedIds(rescanned), [uuidN(9)]);
  assert.equal(rescanned.anomaly, undefined);
  const rebuilt = fileA(rescanned);
  assert.deepEqual(pending(rebuilt.merge, "query"), [uuidN(2), uuidN(1)]);
  assert.deepEqual(rebuilt.merge.nodes[uuidN(1)]?.excludedFrom, ["session"]);
  assert.deepEqual(rebuilt.merge.nodes[uuidN(2)]?.excludedFrom, []);
  assert.equal(rebuilt.pendingLeaf, uuidN(2));
  assert.equal(rebuilt.lastUsage?.input_tokens, 5);
  assert.equal(rebuilt.treeLeaf, null);
  assert.equal(rebuilt.scanExcluded, true);
});

test("scanComplete ends the scan exclusion without a query-reported id", () => {
  const state = run([fileChanged(SESSION_A), scanComplete, assistantEntry(2)]);
  assert.equal(fileA(state).scanExcluded, false);
  assert.deepEqual(pending(fileA(state).merge, "session"), [uuidN(2)]);
});
