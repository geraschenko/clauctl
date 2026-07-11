import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  acceptUserMessage,
  deliveredMessages,
  INITIAL_QUEUE_MODEL_STATE,
  observeSdkMessage,
  type QueueModelState,
} from "./queue-model.ts";
import type { SdkEvent } from "./sdk-socket.ts";

function userMessage(overrides: Partial<SDKUserMessage> = {}): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
    ...overrides,
  };
}

// The model only inspects `type` (and content blocks for user messages).
const assistant = { type: "assistant" } as unknown as SDKMessage;
const streamEvent = { type: "stream_event" } as unknown as SDKMessage;
const result = { type: "result" } as unknown as SDKMessage;
const toolResult = {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
  },
  parent_tool_use_id: null,
} as unknown as SDKMessage;

interface Scenario {
  state: QueueModelState;
  events: SdkEvent[];
}

function accept(
  scenario: Scenario,
  message: SDKUserMessage,
  busy: boolean,
): Scenario {
  const transition = acceptUserMessage(scenario.state, message, busy);
  return {
    state: transition.state,
    events: [...scenario.events, ...transition.events],
  };
}

function observe(scenario: Scenario, message: SDKMessage): Scenario {
  const transition = observeSdkMessage(scenario.state, message);
  return {
    state: transition.state,
    events: [...scenario.events, ...transition.events],
  };
}

function start(): Scenario {
  return { state: INITIAL_QUEUE_MODEL_STATE, events: [] };
}

function dequeues(scenario: Scenario): SdkEvent[] {
  return scenario.events.filter(
    (event) => event.kind === "userMessageDequeued",
  );
}

test("idle accept: queued+dequeued pair, delivery turn", () => {
  const scenario = accept(start(), userMessage(), false);
  assert.equal(scenario.events.length, 2);
  assert.deepEqual(scenario.events[0], {
    kind: "userMessageQueued",
    id: 1,
    message: userMessage(),
  });
  assert.deepEqual(scenario.events[1], {
    kind: "userMessageDequeued",
    delivery: "turn",
    ids: [1],
  });
  assert.deepEqual(scenario.state.queued, []);
});

test("idle accept of a no-query message dequeues as append", () => {
  const scenario = accept(start(), userMessage({ shouldQuery: false }), false);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "append", ids: [1] },
  ]);
});

test("busy accept: queued only", () => {
  const scenario = accept(start(), userMessage(), true);
  assert.equal(scenario.events.length, 1);
  assert.equal(scenario.events[0]!.kind, "userMessageQueued");
  assert.equal(scenario.state.queued.length, 1);
});

test("ids are daemon-assigned and monotonic", () => {
  let scenario = accept(start(), userMessage(), false);
  scenario = accept(scenario, userMessage(), true);
  const queuedIds = scenario.events
    .filter((event) => event.kind === "userMessageQueued")
    .map((event) => event.id);
  assert.deepEqual(queuedIds, [1, 2]);
});

test("group demotion: marked demotables steer at assistant activity", () => {
  let scenario = accept(start(), userMessage(), true); // id 1, default
  scenario = accept(scenario, userMessage({ priority: "next" }), true); // id 2
  scenario = observe(scenario, toolResult);
  assert.deepEqual(dequeues(scenario), []);
  scenario = observe(scenario, assistant);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "steer", ids: [1, 2] },
  ]);
  assert.deepEqual(scenario.state.queued, []);
});

test("stream_event counts as assistant activity for the steer boundary", () => {
  let scenario = accept(start(), userMessage(), true);
  scenario = observe(scenario, toolResult);
  scenario = observe(scenario, streamEvent);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "steer", ids: [1] },
  ]);
});

test("straggler: accepted between tool_result and assistant waits its own boundary", () => {
  let scenario = accept(start(), userMessage(), true); // id 1
  scenario = observe(scenario, toolResult);
  scenario = accept(scenario, userMessage(), true); // id 2, the straggler
  scenario = observe(scenario, assistant);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "steer", ids: [1] },
  ]);
  // The straggler steers at the NEXT tool_result + assistant handoff.
  scenario = observe(scenario, toolResult);
  scenario = observe(scenario, assistant);
  assert.deepEqual(dequeues(scenario).at(-1), {
    kind: "userMessageDequeued",
    delivery: "steer",
    ids: [2],
  });
});

test("later and now are not demotable", () => {
  let scenario = accept(start(), userMessage({ priority: "later" }), true);
  scenario = accept(scenario, userMessage({ priority: "now" }), true);
  scenario = observe(scenario, toolResult);
  scenario = observe(scenario, assistant);
  assert.deepEqual(dequeues(scenario), []);
});

test("same-priority merge: one dequeue carrying both ids", () => {
  let scenario = accept(start(), userMessage({ priority: "later" }), true);
  scenario = accept(scenario, userMessage({ priority: "later" }), true);
  scenario = observe(scenario, result);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "turn", ids: [1, 2] },
  ]);
  assert.deepEqual(scenario.state.queued, []);
});

test("c_perm drain order: now cuts ahead, then next, then later", () => {
  let scenario = accept(start(), userMessage({ priority: "next" }), true); // id 1
  scenario = accept(scenario, userMessage({ priority: "later" }), true); // id 2
  scenario = accept(scenario, userMessage({ priority: "now" }), true); // id 3
  scenario = observe(scenario, result);
  scenario = observe(scenario, result);
  scenario = observe(scenario, result);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "turn", ids: [3] },
    { kind: "userMessageDequeued", delivery: "turn", ids: [1] },
    { kind: "userMessageDequeued", delivery: "turn", ids: [2] },
  ]);
});

test("no-query would-be-steer stays steer", () => {
  let scenario = accept(start(), userMessage({ shouldQuery: false }), true);
  scenario = observe(scenario, toolResult);
  scenario = observe(scenario, assistant);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "steer", ids: [1] },
  ]);
});

test("no-query bucket dequeues as append at the result", () => {
  const scenario = observe(
    accept(
      start(),
      userMessage({ priority: "later", shouldQuery: false }),
      true,
    ),
    result,
  );
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "append", ids: [1] },
  ]);
});

test("mixed bucket with one querying message dequeues as turn", () => {
  let scenario = accept(
    start(),
    userMessage({ priority: "later", shouldQuery: false }),
    true,
  );
  scenario = accept(scenario, userMessage({ priority: "later" }), true);
  scenario = observe(scenario, result);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "turn", ids: [1, 2] },
  ]);
});

test("result with an empty queue emits nothing", () => {
  const scenario = observe(start(), result);
  assert.deepEqual(scenario.events, []);
});

// deliveredMessages: which prompts a transition hands to the CLI (the
// attach-window gap — a prompt dequeued before a subscribe whose transcript
// entry the boundary-cut history read does not cover is visible only
// through this).

test("deliveredMessages: idle accept delivers the just-accepted message", () => {
  const message = userMessage();
  const transition = acceptUserMessage(
    INITIAL_QUEUE_MODEL_STATE,
    message,
    false,
  );
  assert.deepEqual(deliveredMessages(INITIAL_QUEUE_MODEL_STATE, transition), [
    message,
  ]);
});

test("deliveredMessages: busy accept delivers nothing", () => {
  const transition = acceptUserMessage(
    INITIAL_QUEUE_MODEL_STATE,
    userMessage(),
    true,
  );
  assert.deepEqual(
    deliveredMessages(INITIAL_QUEUE_MODEL_STATE, transition),
    [],
  );
});

test("deliveredMessages: result dequeue delivers the bucket in FIFO order", () => {
  const first = userMessage({
    priority: "later",
    message: { role: "user", content: "first" },
  });
  const second = userMessage({
    priority: "later",
    message: { role: "user", content: "second" },
  });
  let scenario = accept(start(), first, true);
  scenario = accept(scenario, second, true);
  const before = scenario.state;
  const transition = observeSdkMessage(before, result);
  assert.deepEqual(deliveredMessages(before, transition), [first, second]);
});

test("deliveredMessages: steer dequeues deliver nothing", () => {
  let scenario = accept(start(), userMessage(), true);
  scenario = observe(scenario, toolResult);
  const before = scenario.state;
  const transition = observeSdkMessage(before, assistant);
  assert.equal(
    transition.events.some((event) => event.kind === "userMessageDequeued"),
    true,
  );
  assert.deepEqual(deliveredMessages(before, transition), []);
});
