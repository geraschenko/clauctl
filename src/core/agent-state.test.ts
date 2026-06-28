import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentState,
  INITIAL_AGENT_STATE,
  isIdle,
  nextAgentState,
} from "./agent-state.ts";
import type { SdkEvent } from "./sdk-socket.ts";

// The fold only inspects the fields each step reads, so minimal stubs
// suffice; assistant messages get the usage payload and the (wire-mandatory)
// parent_tool_use_id the fold reads.
function sdkMessage(
  type:
    "assistant" | "result" | "system" | "stream_event" | "conversation_reset",
  fields: Record<string, unknown> = {},
): SdkEvent {
  return {
    kind: "sdkMessage",
    message: {
      type,
      ...(type === "assistant" && {
        parent_tool_use_id: null,
        message: { usage: { input_tokens: 5, output_tokens: 7 } },
      }),
      ...fields,
    } as unknown as SDKMessage,
  };
}

function userMessage(overrides: Partial<SDKUserMessage> = {}): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
    ...overrides,
  };
}

function queued(id: number, overrides: Partial<SDKUserMessage> = {}): SdkEvent {
  return { kind: "userMessageQueued", id, message: userMessage(overrides) };
}

function dequeued(
  delivery: "turn" | "steer" | "append",
  ids: number[],
): SdkEvent {
  return { kind: "userMessageDequeued", delivery, ids };
}

function run(events: SdkEvent[], from = INITIAL_AGENT_STATE): AgentState {
  return events.reduce(nextAgentState, from);
}

function queuedIds(state: AgentState): number[] {
  return state.queuedMessages.map((entry) => entry.id);
}

test("initial state is idle with empty arrays", () => {
  assert.equal(INITIAL_AGENT_STATE.activity, "idle");
  assert.deepEqual(INITIAL_AGENT_STATE.queuedMessages, []);
  assert.deepEqual(INITIAL_AGENT_STATE.deliveredMessages, []);
  assert.deepEqual(INITIAL_AGENT_STATE.observedPermissionModes, []);
  assert.equal(isIdle(INITIAL_AGENT_STATE), true);
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
  const compactSent: SdkEvent = { kind: "compactSent", message: userMessage() };
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
  const state = nextAgentState(INITIAL_AGENT_STATE, sdkMessage("result"));
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
  assert.equal(working.lastUsage?.input_tokens, 5);
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
  assert.deepEqual(updated.lastUsage, {
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
  assert.equal(dropped.lastUsage, undefined);
  assert.equal("lastUsage" in dropped, false);
});

test("other message types do not change state", () => {
  const pending = run([queued(1)]);
  assert.equal(nextAgentState(pending, sdkMessage("system")), pending);
  assert.equal(nextAgentState(pending, sdkMessage("stream_event")), pending);
});

test("invariant: idle implies no querying entries across a busy scenario", () => {
  const events: SdkEvent[] = [
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
  let state = INITIAL_AGENT_STATE;
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

function init(fields: Record<string, unknown> = {}): SdkEvent {
  return sdkMessage("system", {
    subtype: "init",
    session_id: "sess-1",
    model: "opus",
    cwd: "/work",
    permissionMode: "default",
    uuid: undefined,
    ...fields,
  });
}

test("conversation_reset switches history state and preserves queued work", () => {
  const oldUsage = run([sdkMessage("assistant")]).lastUsage;
  assert.notEqual(oldUsage, undefined);
  const before: AgentState = {
    ...INITIAL_AGENT_STATE,
    activity: "working",
    sessionId: "old-session",
    lastUsage: oldUsage,
    leaf: { uuid: "00000000-0000-0000-0000-00000000000a" },
    deliveredMessages: [userMessage()],
    queuedMessages: [{ id: 2, message: userMessage({ priority: "later" }) }],
  };
  const state = nextAgentState(
    before,
    sdkMessage("conversation_reset", {
      new_conversation_id: "new-session",
    }),
  );
  assert.equal(state.sessionId, undefined);
  assert.equal(state.lastUsage, undefined);
  assert.equal(state.leaf, undefined);
  assert.deepEqual(state.deliveredMessages, []);
  assert.deepEqual(queuedIds(state), [2]);
  assert.equal(state.activity, "working");
});

test("system/init sets sessionId, model, cwd, and observes the mode", () => {
  const state = run([init()]);
  assert.equal(state.sessionId, "sess-1");
  assert.equal(state.model, "opus");
  assert.equal(state.cwd, "/work");
  assert.equal(state.permissionMode, "default");
  assert.deepEqual(state.observedPermissionModes, ["default"]);
});

// A resumed session can fork: init announces a new session id whose file
// never contains the leaf seeded from the resumed file. The leaf must always
// belong to sessionId's file, so an id change drops it.
test("system/init announcing a different session id drops the leaf", () => {
  const seeded: AgentState = {
    ...INITIAL_AGENT_STATE,
    sessionId: "resumed-session",
    leaf: { uuid: "00000000-0000-0000-0000-00000000000a" },
  };
  const state = nextAgentState(seeded, init({ session_id: "forked-session" }));
  assert.equal(state.sessionId, "forked-session");
  assert.equal(state.leaf, undefined);
});

test("system/init announcing the same session id preserves the leaf", () => {
  const seeded: AgentState = {
    ...INITIAL_AGENT_STATE,
    sessionId: "sess-1",
    leaf: { uuid: "00000000-0000-0000-0000-00000000000a" },
  };
  const state = nextAgentState(seeded, init());
  assert.equal(state.sessionId, "sess-1");
  assert.deepEqual(state.leaf, {
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
  assert.equal(unchanged, state);
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
  }): SdkEvent => ({
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
  assert.deepEqual(confirmed.leaf, { uuid: "uuid-1" });
  assert.deepEqual(confirmed.deliveredMessages, []);
  const userUuid = "00000000-0000-0000-0000-000000000002";
  const user = nextAgentState(confirmed, {
    kind: "sdkMessage",
    message: userMessage({ uuid: userUuid }) as SDKMessage,
  });
  assert.deepEqual(user.leaf, { uuid: userUuid });
});

test("messages without a uuid neither advance the boundary nor clear deliveredMessages", () => {
  const delivered = run([queued(1), dequeued("turn", [1])]);
  const state = run(
    [sdkMessage("system"), sdkMessage("stream_event"), sdkMessage("assistant")],
    delivered,
  );
  assert.equal(state.leaf, undefined);
  assert.equal(state.deliveredMessages.length, 1);
});

test("exactly-one-place property across an accept→deliver→confirm cycle", () => {
  // The prompt is visible in exactly one of queuedMessages/deliveredMessages/
  // behind-the-boundary at every step.
  let state = nextAgentState(INITIAL_AGENT_STATE, queued(1));
  assert.equal(state.queuedMessages.length, 1);
  assert.equal(state.deliveredMessages.length, 0);

  state = nextAgentState(state, dequeued("turn", [1]));
  assert.equal(state.queuedMessages.length, 0);
  assert.equal(state.deliveredMessages.length, 1);

  state = nextAgentState(state, sdkMessage("assistant", { uuid: "uuid-1" }));
  assert.equal(state.queuedMessages.length, 0);
  assert.equal(state.deliveredMessages.length, 0);
  assert.deepEqual(state.leaf, { uuid: "uuid-1" });
});

test("contextChanged folds its post-change leaf; null unsets", () => {
  const request = { type: "set-context" as const, uuids: [] };
  const leaf = {
    uuid: "00000000-0000-0000-0000-000000000001" as const,
    viaBoundary: "00000000-0000-0000-0000-000000000002" as const,
  };
  let state = nextAgentState(INITIAL_AGENT_STATE, {
    kind: "contextChanged",
    request,
    leaf,
  });
  assert.deepEqual(state.leaf, leaf);
  state = nextAgentState(state, {
    kind: "contextChanged",
    request,
    leaf: null,
  });
  assert.equal(state.leaf, undefined);
});
