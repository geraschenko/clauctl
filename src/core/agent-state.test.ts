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
import type { AgentEvent } from "./sdk-socket.ts";
import type { SessionEntry } from "./session/file.ts";
import { hasPending, pending } from "./stream-merge.ts";

const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001" as const;
const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002" as const;
const uuidN = (n: number): UUID =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

// The fold only inspects the fields each step reads, so minimal stubs
// suffice; assistant messages get the usage payload and the (wire-mandatory)
// parent_tool_use_id the fold reads. Every message names SESSION_A's file.
function sdkMessage(
  type:
    "assistant" | "result" | "system" | "stream_event" | "conversation_reset",
  fields: Record<string, unknown> = {},
): AgentEvent {
  return {
    kind: "sdkMessage",
    message: {
      type,
      session_id: SESSION_A,
      ...(type === "assistant" && {
        parent_tool_use_id: null,
        message: { usage: { input_tokens: 5, output_tokens: 7 } },
      }),
      ...fields,
    } as unknown as SDKMessage,
  };
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

const fileChanged = (sessionId: UUID): AgentEvent => ({
  kind: "sessionFileChanged",
  sessionId,
});
const scanComplete: AgentEvent = { kind: "scanComplete" };

function userMessage(overrides: Partial<SDKUserMessage> = {}): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
    ...overrides,
  };
}

function queued(
  id: number,
  overrides: Partial<SDKUserMessage> = {},
): AgentEvent {
  return { kind: "userMessageQueued", id, message: userMessage(overrides) };
}

function dequeued(
  delivery: "turn" | "steer" | "append",
  ids: number[],
): AgentEvent {
  return { kind: "userMessageDequeued", delivery, ids };
}

function run(events: AgentEvent[], from = initialAgentState()): AgentState {
  return events.reduce(nextAgentState, from);
}

function queuedIds(state: AgentState): number[] {
  return state.queuedMessages.map((entry) => entry.id);
}

test("initial state is idle with empty arrays", () => {
  assert.equal(initialAgentState().activity, "idle");
  assert.deepEqual(initialAgentState().queuedMessages, []);
  assert.deepEqual(initialAgentState().deliveredMessages, []);
  assert.deepEqual(initialAgentState().observedPermissionModes, []);
  assert.equal(isIdle(initialAgentState()), true);
});

test("querying message queued while idle → pending", () => {
  const state = run([queued(1)]);
  assert.equal(state.activity, "pending");
  assert.deepEqual(queuedIds(state), [1]);
  assert.equal(isIdle(state), false);
});

test("non-querying message queued while idle stays idle", () => {
  const state = run([queued(1, { shouldQuery: false })]);
  assert.equal(state.activity, "idle");
  assert.deepEqual(queuedIds(state), [1]);
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
  assert.deepEqual(queuedIds(state), [2]);
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
  assert.deepEqual(queuedIds(state), [2]);
  const done = run([dequeued("append", [2])], state);
  assert.equal(done.activity, "idle");
  assert.deepEqual(done.queuedMessages, []);
});

test("compact: compacting is exited by result, not assistant output", () => {
  const compactSent: AgentEvent = {
    kind: "compactSent",
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
    { kind: "compactSent", message: userMessage() },
    queued(1, { priority: "later" }),
    sdkMessage("result"), // compaction finished
  ]);
  assert.equal(state.activity, "pending");
  assert.deepEqual(queuedIds(state), [1]);
});

test("interruptSent and non-tracking controlApplied leave state unchanged", () => {
  const working = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
  ]);
  assert.equal(nextAgentState(working, { kind: "interruptSent" }), working);
  assert.equal(
    nextAgentState(working, {
      kind: "controlApplied",
      request: { type: "reload-plugins" },
    }),
    working,
  );
});

test("unexpected result while idle stays idle", () => {
  const state = nextAgentState(initialAgentState(), sdkMessage("result"));
  assert.equal(state.activity, "idle");
});

test("subagent user/assistant messages leave state unchanged", () => {
  const working = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
  ]);
  // A subagent assistant must not overwrite lastUsage, advance the leaf, or
  // clear the delivered hold; same for a subagent user message.
  const afterSub = run(
    [
      sdkMessage("assistant", {
        parent_tool_use_id: "tool-1",
        uuid: "sub-uuid",
        message: { usage: { input_tokens: 999, output_tokens: 999 } },
      }),
      {
        kind: "sdkMessage",
        message: userMessage({
          parent_tool_use_id: "tool-1",
          uuid: "00000000-0000-0000-0000-0000000000ab",
        }) as SDKMessage,
      },
    ],
    working,
  );
  assert.equal(afterSub, working);
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
    assert.deepEqual(state.deliveredMessages, pendingTurn.deliveredMessages);
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

test("conversation_reset clears delivered prompts and preserves queued work", () => {
  const before: AgentState = {
    ...initialAgentState(),
    activity: "working",
    deliveredMessages: [userMessage()],
    queuedMessages: [{ id: 2, message: userMessage({ priority: "later" }) }],
  };
  const state = nextAgentState(
    before,
    sdkMessage("conversation_reset", {
      new_conversation_id: "new-session",
    }),
  );
  assert.deepEqual(state.deliveredMessages, []);
  assert.deepEqual(queuedIds(state), [2]);
  assert.equal(state.activity, "working");
});

test("system/init sets the query session, model, cwd, and observes the mode", () => {
  const state = run([init()]);
  assert.equal(state.querySessionId, SESSION_A);
  assert.equal(state.model, "opus");
  assert.equal(state.cwd, "/work");
  assert.equal(state.permissionMode, "default");
  assert.deepEqual(state.observedPermissionModes, ["default"]);
});

// A resumed session can fork: init announces a new session id whose file
// never contains the resumed file's leaf. The leaf is per file, so an id
// change moves the query file and the leaf follows.
test("system/init announcing a different session id moves the query file; the leaf follows", () => {
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
  const state = nextAgentState(seeded, init({ session_id: forked }));
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
    { kind: "controlApplied", request: { type: "set-model", model: "sonnet" } },
  ]);
  assert.equal(state.model, "sonnet");
  const reset = nextAgentState(state, {
    kind: "controlApplied",
    request: { type: "set-model" },
  });
  assert.equal(reset.model, undefined);
});

test("controlApplied apply-flag-settings folds effortLevel; null unsets", () => {
  const applied = (settings: {
    effortLevel?: "low" | "medium" | "high" | "xhigh" | null;
  }): AgentEvent => ({
    kind: "controlApplied",
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
      request: { type: "set-permission-mode", mode: "acceptEdits" },
    },
  ]);
  assert.equal(state.permissionMode, "acceptEdits");
  assert.deepEqual(state.observedPermissionModes, ["acceptEdits"]);
});

// --- prompt-visibility bookkeeping -------------------------------------------
// The fold cannot prove transcript presence — that rests on the documented CLI
// transcript-ordering assumption (agent-state.ts header). These tests cover
// the bookkeeping properties the fold does own.

test("turn dequeue moves messages from queuedMessages to deliveredMessages in ids order", () => {
  const first = userMessage({ message: { role: "user", content: "one" } });
  const second = userMessage({ message: { role: "user", content: "two" } });
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    { kind: "userMessageQueued", id: 2, message: first },
    { kind: "userMessageQueued", id: 3, message: second },
    sdkMessage("result"),
    dequeued("turn", [3, 2]),
  ]);
  assert.deepEqual(state.queuedMessages, []);
  // Ids order (3 before 2), not queue order.
  assert.deepEqual(
    state.deliveredMessages.map((m) => m.message.content),
    ["hello", "two", "one"],
  );
});

test("append dequeue also delivers; steer dequeue removes without delivering", () => {
  const appended = run([
    queued(1, { shouldQuery: false }),
    dequeued("append", [1]),
  ]);
  assert.deepEqual(appended.queuedMessages, []);
  assert.equal(appended.deliveredMessages.length, 1);

  const steered = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    queued(2),
    dequeued("steer", [2]),
  ]);
  assert.deepEqual(steered.queuedMessages, []);
  // Id 1's turn delivery is held; the steered id 2 is not.
  assert.equal(steered.deliveredMessages.length, 1);
});

test("dequeue ids not present in queuedMessages are ignored", () => {
  const state = run([queued(1), dequeued("turn", [1, 99])]);
  assert.deepEqual(state.queuedMessages, []);
  assert.equal(state.deliveredMessages.length, 1);
});

test("uuid-carrying message advances the boundary and clears deliveredMessages in one step", () => {
  const delivered = run([queued(1), dequeued("turn", [1])]);
  assert.equal(delivered.deliveredMessages.length, 1);
  const confirmed = nextAgentState(
    delivered,
    sdkMessage("assistant", { uuid: "uuid-1" }),
  );
  assert.deepEqual(leaf(confirmed), { uuid: "uuid-1" });
  assert.deepEqual(confirmed.deliveredMessages, []);
  const userUuid = "00000000-0000-0000-0000-000000000002";
  const user = nextAgentState(confirmed, {
    kind: "sdkMessage",
    message: userMessage({
      uuid: userUuid,
      session_id: SESSION_A,
    }) as SDKMessage,
  });
  assert.deepEqual(leaf(user), { uuid: userUuid });
});

test("messages without a uuid neither advance the boundary nor clear deliveredMessages", () => {
  const delivered = run([queued(1), dequeued("turn", [1])]);
  const state = run(
    [sdkMessage("system"), sdkMessage("stream_event"), sdkMessage("assistant")],
    delivered,
  );
  assert.equal(leaf(state), null);
  assert.equal(state.deliveredMessages.length, 1);
});

test("exactly-one-place property across an accept→deliver→confirm cycle", () => {
  // The prompt is visible in exactly one of queuedMessages/deliveredMessages/
  // behind-the-boundary at every step.
  let state = nextAgentState(initialAgentState(), queued(1));
  assert.equal(state.queuedMessages.length, 1);
  assert.equal(state.deliveredMessages.length, 0);

  state = nextAgentState(state, dequeued("turn", [1]));
  assert.equal(state.queuedMessages.length, 0);
  assert.equal(state.deliveredMessages.length, 1);

  state = nextAgentState(state, sdkMessage("assistant", { uuid: "uuid-1" }));
  assert.equal(state.queuedMessages.length, 0);
  assert.equal(state.deliveredMessages.length, 0);
  assert.deepEqual(leaf(state), { uuid: "uuid-1" });
});

test("contextChanged is pass-through: the tip it carries is folded from the completing entry", () => {
  const state = initialAgentState();
  assert.equal(
    nextAgentState(state, {
      kind: "contextChanged",
      boundary: "00000000-0000-0000-0000-000000000002",
      leaf: { uuid: "00000000-0000-0000-0000-000000000001" },
    }),
    state,
  );
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

test("a query message creates its file; a query-only id resolves at once", () => {
  const state = run([init({ uuid: uuidN(1) })]);
  assert.equal(state.querySessionId, SESSION_A);
  assert.deepEqual(fileA(state).merge.nodes, {});
  assert.equal(settled(state), true);
  assert.equal(state.anomaly, undefined);
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

test("trackerAnomaly sets the anomaly for one fold", () => {
  const anomaly = { kind: "malformed-line", detail: "bytes 10-20" } as const;
  const state = run([init(), { kind: "trackerAnomaly", anomaly }]);
  assert.deepEqual(state.anomaly, anomaly);
  assert.equal(nextAgentState(state, sdkMessage("result")).anomaly, undefined);
});

test("sessionAppended ids are query action items resolved by their entries", () => {
  const appended = run([
    init({ uuid: uuidN(1) }),
    fileChanged(SESSION_A),
    scanComplete,
    { kind: "sessionAppended", uuids: [uuidN(6), uuidN(7)] },
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

test("sessionFileChanged to another id drops the old file and adopts a query-created one", () => {
  const state = run([
    fileChanged(SESSION_A),
    scanComplete,
    assistantQuery(2),
    sdkMessage("assistant", { uuid: uuidN(3), session_id: SESSION_B }),
    fileChanged(SESSION_B),
  ]);
  assert.equal(state.fileSessionId, SESSION_B);
  assert.deepEqual(Object.keys(state.sessions), [SESSION_B]);
  assert.deepEqual(pending(state.sessions[SESSION_B]!.merge, "query"), [
    uuidN(3),
  ]);
});

test("sessionFileChanged to the same id rebuilds from the query side's pending observations", () => {
  const before = run([
    assistantQuery(2),
    init({ uuid: uuidN(1) }),
    fileChanged(SESSION_A),
    scanComplete,
    promptEntry(3),
  ]);
  assert.notEqual(fileA(before).treeLeaf, null);
  const rebuilt = fileA(nextAgentState(before, fileChanged(SESSION_A)));
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
