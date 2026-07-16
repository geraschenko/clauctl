import assert from "node:assert/strict";
import { test } from "node:test";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PersistedOptions } from "../options.ts";
import type { SdkRequestRecord } from "../sdk-socket.ts";
import { EventHub } from "./event-hub.ts";
import {
  createRequestHandler,
  type RequestHandlerDeps,
} from "./request-handlers.ts";
import { RESPONSE_SENT, type SdkConnection } from "./sdk-server.ts";
import type { TurnQueue } from "./turn-queue.ts";

interface Fixture {
  handle: (
    request: SdkRequestRecord,
    connection?: SdkConnection,
  ) => Promise<unknown>;
  events: EventHub;
  pushed: SDKUserMessage[];
  persisted: PersistedOptions[];
}

function fixture(claudeQuery: Partial<Query> = {}): Fixture {
  const pushed: SDKUserMessage[] = [];
  const persisted: PersistedOptions[] = [];
  let options: PersistedOptions = {};
  const events = new EventHub({
    seed: { cwd: "/work" },
    deliver: (message) => pushed.push(message),
  });
  const deps: RequestHandlerDeps = {
    claudeQuery: claudeQuery as Query,
    events,
    // The compact path only pushes; a recording stub suffices.
    turnQueue: {
      push: (message: SDKUserMessage) => pushed.push(message),
    } as unknown as TurnQueue,
    cwd: "/work",
    getPersistedOptions: () => options,
    setPersistedOptions: (next) => {
      options = next;
      persisted.push(next);
    },
  };
  const handler = createRequestHandler(deps);
  const idleConnection: SdkConnection = {
    write: () => {},
    onClose: () => {},
  };
  return {
    handle: (request, connection = idleConnection) =>
      handler(request, connection),
    events,
    pushed,
    persisted,
  };
}

function userMessage(): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
  };
}

test("query delivers through the hub; the events are the response", async () => {
  const f = fixture();
  const result = await f.handle({ type: "query", content: "hi", id: "r1" });
  assert.equal(result, undefined);
  assert.equal(f.pushed.length, 1);
  assert.equal(f.events.agentState.activity, "pending");
});

test("/compact while idle pushes directly and emits compactSent", async () => {
  const f = fixture();
  const seen: string[] = [];
  f.events.subscribe((line) => {
    seen.push((JSON.parse(line) as { event: { kind: string } }).event.kind);
  });
  await f.handle({ type: "query", content: "/compact", id: "r1" });
  assert.equal(f.pushed.length, 1);
  assert.deepEqual(seen, ["compactSent"]); // no queued/dequeued pair
  assert.equal(f.events.agentState.activity, "compacting");
});

test("/compact is rejected when not idle", async () => {
  const f = fixture();
  f.events.deliverUserMessage(userMessage());
  assert.equal(f.events.agentState.activity, "pending");
  await assert.rejects(
    f.handle({ type: "query", content: "/compact", id: "r2" }),
    /requires an idle assistant/,
  );
});

test("subscribe writes its own response carrying events.agentState", async () => {
  const f = fixture();
  f.events.deliverUserMessage(userMessage());
  const written: string[] = [];
  const connection: SdkConnection = {
    write: (line) => written.push(line),
    onClose: () => {},
  };
  const result = await f.handle({ type: "subscribe", id: "s1" }, connection);
  assert.equal(result, RESPONSE_SENT);
  const response = JSON.parse(written[0]!) as {
    id: string;
    ok: boolean;
    data: unknown;
  };
  assert.equal(response.id, "s1");
  assert.equal(response.ok, true);
  assert.deepEqual(
    response.data,
    JSON.parse(JSON.stringify(f.events.agentState)),
  );
  // The attached sink receives every later event.
  f.events.emit({ kind: "interruptSent" });
  assert.equal(written.length, 2);
});

test("get-messages with no session returns [] without touching the transcript", async () => {
  const f = fixture();
  assert.deepEqual(await f.handle({ type: "get-messages", id: "g1" }), []);
});

test("two in-flight mutations do not interleave: apply and persist run as a chain", async () => {
  const order: string[] = [];
  const gates: Array<() => void> = [];
  const claudeQuery: Partial<Query> = {
    setModel: (model?: string) => {
      order.push(`apply:${model}`);
      return new Promise((resolve) => gates.push(() => resolve(undefined)));
    },
  };
  const f = fixture(claudeQuery);
  const first = f.handle({ type: "set-model", model: "a", id: "m1" });
  const second = f.handle({ type: "set-model", model: "b", id: "m2" });
  // Flush microtasks so both handlers reach the chain, then check that only
  // the first apply has started; the second waits on the chain.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["apply:a"]);
  gates.shift()!();
  await first;
  assert.deepEqual(order, ["apply:a", "apply:b"]);
  gates.shift()!();
  await second;
  assert.deepEqual(
    f.persisted.map((options) => options.model),
    ["a", "b"],
  );
});

test("a failed mutation rejects its requester without poisoning the chain", async () => {
  let calls = 0;
  const claudeQuery: Partial<Query> = {
    setModel: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(undefined);
    },
  };
  const f = fixture(claudeQuery);
  await assert.rejects(f.handle({ type: "set-model", model: "a", id: "m1" }));
  await f.handle({ type: "set-model", model: "b", id: "m2" });
  assert.deepEqual(
    f.persisted.map((options) => options.model),
    ["b"],
  );
});
