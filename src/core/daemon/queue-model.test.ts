import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  acceptUserMessage,
  INITIAL_QUEUE_MODEL_STATE,
  observeSdkMessage,
  type QueueModelState,
} from "./queue-model.ts";
import type { AgentEvent } from "../protocol.ts";

const uuidN = (n: number): UUID =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

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
  events: AgentEvent[];
  /** Messages accepted so far; the next one is stamped `uuidN(accepted + 1)`. */
  accepted: number;
}

function accept(
  scenario: Scenario,
  message: SDKUserMessage,
  isIdle: boolean,
): Scenario {
  const accepted = scenario.accepted + 1;
  const transition = acceptUserMessage(
    scenario.state,
    { ...message, uuid: uuidN(accepted) },
    isIdle,
  );
  return {
    state: transition.state,
    events: [...scenario.events, ...transition.events],
    accepted,
  };
}

function observe(scenario: Scenario, message: SDKMessage): Scenario {
  const transition = observeSdkMessage(scenario.state, message);
  return {
    state: transition.state,
    events: [...scenario.events, ...transition.events],
    accepted: scenario.accepted,
  };
}

function start(): Scenario {
  return { state: INITIAL_QUEUE_MODEL_STATE, events: [], accepted: 0 };
}

function dequeues(scenario: Scenario): AgentEvent[] {
  return scenario.events.filter(
    (event) => event.kind === "userMessageDequeued",
  );
}

test("idle accept: queued+dequeued pair, delivery turn", () => {
  const scenario = accept(start(), userMessage(), true);
  assert.equal(scenario.events.length, 2);
  assert.deepEqual(scenario.events[0], {
    kind: "userMessageQueued",
    uuid: uuidN(1),
    message: userMessage({ uuid: uuidN(1) }),
  });
  assert.deepEqual(scenario.events[1], {
    kind: "userMessageDequeued",
    delivery: "turn",
    uuids: [uuidN(1)],
  });
  assert.deepEqual(scenario.state.queued, []);
});

test("idle accept of a no-query message dequeues as append", () => {
  const scenario = accept(start(), userMessage({ shouldQuery: false }), true);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "append", uuids: [uuidN(1)] },
  ]);
});

test("busy accept: queued only", () => {
  const scenario = accept(start(), userMessage(), false);
  assert.equal(scenario.events.length, 1);
  assert.equal(scenario.events[0]!.kind, "userMessageQueued");
  assert.equal(scenario.state.queued.length, 1);
});

test("event uuids are the stamped uuids", () => {
  let scenario = accept(start(), userMessage(), true);
  scenario = accept(scenario, userMessage(), false);
  const queuedUuids = scenario.events
    .filter((event) => event.kind === "userMessageQueued")
    .map((event) => event.uuid);
  assert.deepEqual(queuedUuids, [uuidN(1), uuidN(2)]);
});

test("an unstamped message is rejected", () => {
  assert.throws(
    () => acceptUserMessage(INITIAL_QUEUE_MODEL_STATE, userMessage(), true),
    /no uuid/u,
  );
});

test("group demotion: marked demotables steer at assistant activity, one event each", () => {
  let scenario = accept(start(), userMessage(), false); // uuid 1, default
  scenario = accept(scenario, userMessage({ priority: "next" }), false); // uuid 2
  scenario = observe(scenario, toolResult);
  assert.deepEqual(dequeues(scenario), []);
  scenario = observe(scenario, assistant);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "steer", uuids: [uuidN(1)] },
    { kind: "userMessageDequeued", delivery: "steer", uuids: [uuidN(2)] },
  ]);
  assert.deepEqual(scenario.state.queued, []);
});

test("stream_event counts as assistant activity for the steer boundary", () => {
  let scenario = accept(start(), userMessage(), false);
  scenario = observe(scenario, toolResult);
  scenario = observe(scenario, streamEvent);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "steer", uuids: [uuidN(1)] },
  ]);
});

test("straggler: accepted between tool_result and assistant waits its own boundary", () => {
  let scenario = accept(start(), userMessage(), false); // uuid 1
  scenario = observe(scenario, toolResult);
  scenario = accept(scenario, userMessage(), false); // uuid 2, the straggler
  scenario = observe(scenario, assistant);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "steer", uuids: [uuidN(1)] },
  ]);
  // The straggler steers at the NEXT tool_result + assistant handoff.
  scenario = observe(scenario, toolResult);
  scenario = observe(scenario, assistant);
  assert.deepEqual(dequeues(scenario).at(-1), {
    kind: "userMessageDequeued",
    delivery: "steer",
    uuids: [uuidN(2)],
  });
});

test("later and now are not demotable", () => {
  let scenario = accept(start(), userMessage({ priority: "later" }), false);
  scenario = accept(scenario, userMessage({ priority: "now" }), false);
  scenario = observe(scenario, toolResult);
  scenario = observe(scenario, assistant);
  assert.deepEqual(dequeues(scenario), []);
});

test("same-priority merge: one dequeue carrying both uuids", () => {
  let scenario = accept(start(), userMessage({ priority: "later" }), false);
  scenario = accept(scenario, userMessage({ priority: "later" }), false);
  scenario = observe(scenario, result);
  assert.deepEqual(dequeues(scenario), [
    {
      kind: "userMessageDequeued",
      delivery: "turn",
      uuids: [uuidN(1), uuidN(2)],
    },
  ]);
  assert.deepEqual(scenario.state.queued, []);
});

test("c_perm drain order: now cuts ahead, then next, then later", () => {
  let scenario = accept(start(), userMessage({ priority: "next" }), false); // uuid 1
  scenario = accept(scenario, userMessage({ priority: "later" }), false); // uuid 2
  scenario = accept(scenario, userMessage({ priority: "now" }), false); // uuid 3
  scenario = observe(scenario, result);
  scenario = observe(scenario, result);
  scenario = observe(scenario, result);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "turn", uuids: [uuidN(3)] },
    { kind: "userMessageDequeued", delivery: "turn", uuids: [uuidN(1)] },
    { kind: "userMessageDequeued", delivery: "turn", uuids: [uuidN(2)] },
  ]);
});

test("no-query would-be-steer stays steer", () => {
  let scenario = accept(start(), userMessage({ shouldQuery: false }), false);
  scenario = observe(scenario, toolResult);
  scenario = observe(scenario, assistant);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "steer", uuids: [uuidN(1)] },
  ]);
});

test("no-query bucket dequeues as append at the result", () => {
  const scenario = observe(
    accept(
      start(),
      userMessage({ priority: "later", shouldQuery: false }),
      false,
    ),
    result,
  );
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "append", uuids: [uuidN(1)] },
  ]);
});

test("an append at the head of a bucket is its own run; the querying member follows at the next result", () => {
  let scenario = accept(
    start(),
    userMessage({ priority: "later", shouldQuery: false }),
    false,
  );
  scenario = accept(scenario, userMessage({ priority: "later" }), false);
  scenario = observe(scenario, result);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "append", uuids: [uuidN(1)] },
  ]);
  assert.equal(scenario.state.queued.length, 1);
  scenario = observe(scenario, result);
  assert.deepEqual(dequeues(scenario).at(-1), {
    kind: "userMessageDequeued",
    delivery: "turn",
    uuids: [uuidN(2)],
  });
  assert.deepEqual(scenario.state.queued, []);
});

test("[Q, Q, A, Q] in one bucket drains as turn, append, turn over three results", () => {
  let scenario = accept(start(), userMessage({ priority: "later" }), false);
  scenario = accept(scenario, userMessage({ priority: "later" }), false);
  scenario = accept(
    scenario,
    userMessage({ priority: "later", shouldQuery: false }),
    false,
  );
  scenario = accept(scenario, userMessage({ priority: "later" }), false);
  scenario = observe(scenario, result);
  scenario = observe(scenario, result);
  scenario = observe(scenario, result);
  assert.deepEqual(dequeues(scenario), [
    {
      kind: "userMessageDequeued",
      delivery: "turn",
      uuids: [uuidN(1), uuidN(2)],
    },
    { kind: "userMessageDequeued", delivery: "append", uuids: [uuidN(3)] },
    { kind: "userMessageDequeued", delivery: "turn", uuids: [uuidN(4)] },
  ]);
  assert.deepEqual(scenario.state.queued, []);
});

test("a higher priority accepted mid-drain cuts ahead of the bucket's remaining runs", () => {
  let scenario = accept(start(), userMessage({ priority: "later" }), false); // uuid 1
  scenario = accept(
    scenario,
    userMessage({ priority: "later", shouldQuery: false }),
    false,
  ); // uuid 2
  scenario = accept(scenario, userMessage({ priority: "later" }), false); // uuid 3
  scenario = observe(scenario, result); // run 1 (uuid 1) runs
  scenario = accept(scenario, userMessage(), false); // uuid 4, default priority
  scenario = observe(scenario, result);
  scenario = observe(scenario, result);
  scenario = observe(scenario, result);
  assert.deepEqual(dequeues(scenario), [
    { kind: "userMessageDequeued", delivery: "turn", uuids: [uuidN(1)] },
    { kind: "userMessageDequeued", delivery: "turn", uuids: [uuidN(4)] },
    { kind: "userMessageDequeued", delivery: "append", uuids: [uuidN(2)] },
    { kind: "userMessageDequeued", delivery: "turn", uuids: [uuidN(3)] },
  ]);
  assert.deepEqual(scenario.state.queued, []);
});

test("only a turn dequeues several uuids: steers and appends are runs of one", () => {
  let scenario = accept(start(), userMessage({ shouldQuery: false }), false);
  scenario = accept(scenario, userMessage({ shouldQuery: false }), false);
  scenario = accept(scenario, userMessage(), false);
  scenario = accept(scenario, userMessage(), false);
  scenario = observe(scenario, toolResult);
  scenario = observe(scenario, assistant);
  scenario = accept(
    scenario,
    userMessage({ priority: "later", shouldQuery: false }),
    false,
  );
  scenario = accept(
    scenario,
    userMessage({ priority: "later", shouldQuery: false }),
    false,
  );
  scenario = observe(scenario, result);
  scenario = observe(scenario, result);
  for (const event of dequeues(scenario)) {
    assert.equal(event.kind, "userMessageDequeued");
    if (event.kind === "userMessageDequeued" && event.delivery !== "turn") {
      assert.equal(event.uuids.length, 1, event.delivery);
    }
  }
  assert.equal(dequeues(scenario).length, 6);
});

test("result with an empty queue emits nothing", () => {
  const scenario = observe(start(), result);
  assert.deepEqual(scenario.events, []);
});
