import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AssistantState,
  INITIAL_ASSISTANT_STATE,
  isBusy,
  nextAssistantState,
} from "./assistant-state.ts";
import type { SdkEvent } from "./sdk-socket.ts";

// The tracker only inspects `type`, so a minimal stub suffices.
function sdkMessage(
  type: "assistant" | "result" | "system" | "stream_event",
): SdkEvent {
  return { kind: "sdkMessage", message: { type } as unknown as SDKMessage };
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

function run(
  events: SdkEvent[],
  from = INITIAL_ASSISTANT_STATE,
): AssistantState {
  return events.reduce(nextAssistantState, from);
}

test("initial state is idle with an empty queue", () => {
  assert.deepEqual(INITIAL_ASSISTANT_STATE, { activity: "idle", queued: [] });
  assert.equal(isBusy(INITIAL_ASSISTANT_STATE), false);
});

test("querying message queued while idle → pending", () => {
  const state = run([queued(1)]);
  assert.deepEqual(state, {
    activity: "pending",
    queued: [{ id: 1, shouldQuery: true }],
  });
  assert.equal(isBusy(state), true);
});

test("non-querying message queued while idle stays idle", () => {
  const state = run([queued(1, { shouldQuery: false })]);
  assert.deepEqual(state, {
    activity: "idle",
    queued: [{ id: 1, shouldQuery: false }],
  });
  assert.equal(isBusy(state), false);
});

test("turn dequeue removes the entry without changing activity", () => {
  const state = run([queued(1), dequeued("turn", [1])]);
  assert.deepEqual(state, { activity: "pending", queued: [] });
});

test("assistant message confirms the turn started", () => {
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
  ]);
  assert.deepEqual(state, { activity: "working", queued: [] });
});

test("result with nothing queued → idle", () => {
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    sdkMessage("result"),
  ]);
  assert.deepEqual(state, { activity: "idle", queued: [] });
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
  assert.deepEqual(state, {
    activity: "pending",
    queued: [{ id: 2, shouldQuery: true }],
  });
  const done = run(
    [dequeued("turn", [2]), sdkMessage("assistant"), sdkMessage("result")],
    state,
  );
  assert.deepEqual(done, { activity: "idle", queued: [] });
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
  assert.deepEqual(state, { activity: "idle", queued: [] });
});

test("steer dequeue removes entries mid-turn without changing activity", () => {
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    queued(2),
    dequeued("steer", [2]),
  ]);
  assert.deepEqual(state, { activity: "working", queued: [] });
  const done = run([sdkMessage("result")], state);
  assert.deepEqual(done, { activity: "idle", queued: [] });
});

test("non-querying entry may sit across idle; append dequeue clears it", () => {
  const state = run([
    queued(1),
    dequeued("turn", [1]),
    sdkMessage("assistant"),
    queued(2, { priority: "later", shouldQuery: false }),
    sdkMessage("result"), // Q === 0 → idle, entry 2 still queued
  ]);
  assert.deepEqual(state, {
    activity: "idle",
    queued: [{ id: 2, shouldQuery: false }],
  });
  const done = run([dequeued("append", [2])], state);
  assert.deepEqual(done, { activity: "idle", queued: [] });
});

test("compact: compacting is exited by result, not assistant output", () => {
  const compactSent: SdkEvent = { kind: "compactSent", message: userMessage() };
  const compacting = run([compactSent]);
  assert.deepEqual(compacting, { activity: "compacting", queued: [] });
  // Assistant output during compaction does not flip to working.
  const still = nextAssistantState(compacting, sdkMessage("assistant"));
  assert.deepEqual(still, { activity: "compacting", queued: [] });
  const done = nextAssistantState(still, sdkMessage("result"));
  assert.deepEqual(done, { activity: "idle", queued: [] });
});

test("compact with a later turn queued behind it", () => {
  const state = run([
    { kind: "compactSent", message: userMessage() },
    queued(1, { priority: "later" }),
    sdkMessage("result"), // compaction finished
  ]);
  assert.deepEqual(state, {
    activity: "pending",
    queued: [{ id: 1, shouldQuery: true }],
  });
});

test("interruptSent and controlApplied leave state unchanged", () => {
  const working: AssistantState = {
    activity: "working",
    queued: [{ id: 1, shouldQuery: true }],
  };
  assert.deepEqual(
    nextAssistantState(working, { kind: "interruptSent" }),
    working,
  );
  assert.deepEqual(
    nextAssistantState(working, {
      kind: "controlApplied",
      request: { type: "set-model", model: "sonnet" },
    }),
    working,
  );
});

test("unexpected result while idle stays idle", () => {
  const state = nextAssistantState(
    INITIAL_ASSISTANT_STATE,
    sdkMessage("result"),
  );
  assert.deepEqual(state, { activity: "idle", queued: [] });
});

test("other message types do not change state", () => {
  const pending: AssistantState = {
    activity: "pending",
    queued: [{ id: 1, shouldQuery: true }],
  };
  assert.deepEqual(nextAssistantState(pending, sdkMessage("system")), pending);
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
  let state = INITIAL_ASSISTANT_STATE;
  for (const event of events) {
    state = nextAssistantState(state, event);
    if (state.activity === "idle") {
      assert.equal(state.queued.filter((entry) => entry.shouldQuery).length, 0);
    }
  }
  assert.deepEqual(state, { activity: "idle", queued: [] });
});
