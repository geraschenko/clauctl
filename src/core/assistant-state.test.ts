import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type AssistantState,
  INITIAL_ASSISTANT_STATE,
  isBusy,
  nextAssistantState,
} from "./assistant-state.ts";
import type { SdkEvent } from "./sdk-socket.ts";

// The tracker only inspects `type`, so a minimal stub suffices.
function sdkMessage(type: "assistant" | "result" | "system"): SdkEvent {
  return { kind: "sdkMessage", message: { type } as unknown as SDKMessage };
}

function run(
  events: SdkEvent[],
  from = INITIAL_ASSISTANT_STATE,
): AssistantState {
  return events.reduce(nextAssistantState, from);
}

test("initial state is idle with an empty queue", () => {
  assert.deepEqual(INITIAL_ASSISTANT_STATE, {
    activity: "idle",
    queueDepth: 0,
  });
  assert.equal(isBusy(INITIAL_ASSISTANT_STATE), false);
});

test("turn accepted while idle → pending, depth 1", () => {
  const state = run([{ kind: "turnAccepted" }]);
  assert.deepEqual(state, { activity: "pending", queueDepth: 1 });
  assert.equal(isBusy(state), true);
});

test("assistant message confirms the turn started", () => {
  const state = run([{ kind: "turnAccepted" }, sdkMessage("assistant")]);
  assert.deepEqual(state, { activity: "working", queueDepth: 1 });
});

test("result on the only queued turn → idle, depth 0", () => {
  const state = run([
    { kind: "turnAccepted" },
    sdkMessage("assistant"),
    sdkMessage("result"),
  ]);
  assert.deepEqual(state, { activity: "idle", queueDepth: 0 });
});

test("default-priority turn while busy merges into the running turn", () => {
  const state = run([
    { kind: "turnAccepted" },
    sdkMessage("assistant"),
    { kind: "turnAccepted" }, // no priority → joined to the in-flight turn
    sdkMessage("result"),
  ]);
  assert.deepEqual(state, { activity: "idle", queueDepth: 0 });
});

test("later-priority turn while busy survives the current result", () => {
  const state = run([
    { kind: "turnAccepted" },
    sdkMessage("assistant"),
    { kind: "turnAccepted", priority: "later" },
    sdkMessage("result"),
  ]);
  assert.deepEqual(state, { activity: "pending", queueDepth: 1 });
  // ...and the queued turn runs to completion.
  const done = run([sdkMessage("assistant"), sdkMessage("result")], state);
  assert.deepEqual(done, { activity: "idle", queueDepth: 0 });
});

test("now-priority turn while busy counts as its own unit", () => {
  const state = run([
    { kind: "turnAccepted" },
    sdkMessage("assistant"),
    { kind: "turnAccepted", priority: "now" }, // current turn's result arrives early
    sdkMessage("result"),
  ]);
  assert.deepEqual(state, { activity: "pending", queueDepth: 1 });
});

test("compact: compacting is exited by result, not assistant output", () => {
  const compacting = run([{ kind: "compactSent" }]);
  assert.deepEqual(compacting, { activity: "compacting", queueDepth: 1 });
  // Assistant output during compaction does not flip to working.
  const still = nextAssistantState(compacting, sdkMessage("assistant"));
  assert.deepEqual(still, { activity: "compacting", queueDepth: 1 });
  const done = nextAssistantState(still, sdkMessage("result"));
  assert.deepEqual(done, { activity: "idle", queueDepth: 0 });
});

test("compact with a later turn queued behind it", () => {
  const state = run([
    { kind: "compactSent" },
    { kind: "turnAccepted", priority: "later" },
    sdkMessage("result"), // compaction finished
  ]);
  assert.deepEqual(state, { activity: "pending", queueDepth: 1 });
});

test("interruptSent leaves state unchanged; the result transitions", () => {
  const working: AssistantState = { activity: "working", queueDepth: 1 };
  assert.deepEqual(
    nextAssistantState(working, { kind: "interruptSent" }),
    working,
  );
  assert.deepEqual(nextAssistantState(working, sdkMessage("result")), {
    activity: "idle",
    queueDepth: 0,
  });
});

test("unexpected result while idle clamps queueDepth at 0", () => {
  const state = nextAssistantState(
    INITIAL_ASSISTANT_STATE,
    sdkMessage("result"),
  );
  assert.deepEqual(state, { activity: "idle", queueDepth: 0 });
});

test("other message types do not change state", () => {
  const pending: AssistantState = { activity: "pending", queueDepth: 1 };
  assert.deepEqual(nextAssistantState(pending, sdkMessage("system")), pending);
});

test("invariant: idle implies empty queue across a busy scenario", () => {
  const events: SdkEvent[] = [
    { kind: "turnAccepted" },
    sdkMessage("assistant"),
    { kind: "turnAccepted", priority: "later" },
    { kind: "turnAccepted" }, // merged
    sdkMessage("result"),
    sdkMessage("assistant"),
    sdkMessage("result"),
  ];
  let state = INITIAL_ASSISTANT_STATE;
  for (const event of events) {
    state = nextAssistantState(state, event);
    if (state.activity === "idle") {
      assert.equal(state.queueDepth, 0);
    }
  }
  assert.deepEqual(state, { activity: "idle", queueDepth: 0 });
});
