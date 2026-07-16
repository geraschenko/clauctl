import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "../agent-state.ts";
import type { SdkEvent } from "../sdk-socket.ts";
import { EventHub, type EventHubOptions } from "./event-hub.ts";

function userMessage(overrides: Partial<SDKUserMessage> = {}): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
    ...overrides,
  };
}

function sdkMessage(
  type: "assistant" | "result",
  fields: Record<string, unknown> = {},
): SDKMessage {
  return { type, ...fields } as unknown as SDKMessage;
}

function hub(options: Partial<EventHubOptions> = {}): EventHub {
  return new EventHub({
    seed: { cwd: "/work" },
    deliver: () => {},
    ...options,
  });
}

function eventsOf(lines: string[]): SdkEvent[] {
  return lines.map((line) => (JSON.parse(line) as { event: SdkEvent }).event);
}

test("seeded cwd and sessionId are visible before any event", () => {
  const seeded = hub({ seed: { cwd: "/work", sessionId: "sess-1" } });
  assert.equal(seeded.agentState.cwd, "/work");
  assert.equal(seeded.agentState.sessionId, "sess-1");
  assert.equal(seeded.agentState.activity, "idle");
});

test("a sink observes post-event state (fold before broadcast)", () => {
  const events = hub();
  const observed: AgentState[] = [];
  events.subscribe(() => observed.push(events.agentState));
  events.emit({ kind: "compactSent", message: userMessage() });
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.activity, "compacting");
});

test("deliverUserMessage calls deliver before its events reach sinks", () => {
  const order: string[] = [];
  const events = hub({ deliver: () => order.push("deliver") });
  events.subscribe(() => order.push("sink"));
  events.deliverUserMessage(userMessage());
  // Idle accept: queued + immediate dequeue, both after the delivery.
  assert.deepEqual(order, ["deliver", "sink", "sink"]);
});

test("deliverUserMessage while idle passes the message through to deliveredMessages", () => {
  const delivered: SDKUserMessage[] = [];
  const events = hub({ deliver: (message) => delivered.push(message) });
  const lines: string[] = [];
  events.subscribe((line) => lines.push(line));
  const message = userMessage();
  events.deliverUserMessage(message);
  assert.deepEqual(delivered, [message]);
  assert.deepEqual(
    eventsOf(lines).map((event) => event.kind),
    ["userMessageQueued", "userMessageDequeued"],
  );
  assert.deepEqual(events.agentState.queuedMessages, []);
  assert.equal(events.agentState.deliveredMessages.length, 1);
  assert.equal(events.agentState.activity, "pending");
});

test("deliverUserMessage while busy queues without dequeuing", () => {
  const events = hub();
  events.deliverUserMessage(userMessage());
  events.observeSdkMessage(sdkMessage("assistant"));
  assert.equal(events.agentState.activity, "working");
  const lines: string[] = [];
  events.subscribe((line) => lines.push(line));
  events.deliverUserMessage(userMessage());
  assert.deepEqual(
    eventsOf(lines).map((event) => event.kind),
    ["userMessageQueued"],
  );
  assert.equal(events.agentState.queuedMessages.length, 1);
});

test("observeSdkMessage emits the message first, then implied dequeues", () => {
  const events = hub();
  events.deliverUserMessage(userMessage());
  events.observeSdkMessage(sdkMessage("assistant"));
  events.deliverUserMessage(userMessage()); // queued behind the running turn
  const lines: string[] = [];
  events.subscribe((line) => lines.push(line));
  events.observeSdkMessage(sdkMessage("result"));
  assert.deepEqual(
    eventsOf(lines).map((event) => event.kind),
    ["sdkMessage", "userMessageDequeued"],
  );
});

test("whenIdle resolves immediately when already idle", async () => {
  await hub().whenIdle();
});

test("whenIdle resolves on the idle transition, seeing post-event state", async () => {
  const events = hub();
  events.deliverUserMessage(userMessage());
  let idleActivity: string | undefined;
  const waited = events.whenIdle().then(() => {
    idleActivity = events.agentState.activity;
  });
  events.observeSdkMessage(sdkMessage("assistant"));
  events.observeSdkMessage(sdkMessage("result"));
  await waited;
  assert.equal(idleActivity, "idle");
});

test("unsubscribe detaches the sink", () => {
  const events = hub();
  const lines: string[] = [];
  const unsubscribe = events.subscribe((line) => lines.push(line));
  events.emit({ kind: "interruptSent" });
  unsubscribe();
  events.emit({ kind: "interruptSent" });
  assert.equal(lines.length, 1);
});
