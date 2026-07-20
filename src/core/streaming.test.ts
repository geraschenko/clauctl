import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { INITIAL_AGENT_STATE, type AgentState } from "./agent-state.ts";
import type { SdkEvent } from "./sdk-socket.ts";
import {
  runStream,
  type StreamClient,
  type StreamHandler,
} from "./streaming.ts";
import { UntilTimeoutError } from "./until.ts";

const resultEvent: SdkEvent = {
  kind: "sdkMessage",
  message: { type: "result" } as SDKMessage,
};
const assistantEvent: SdkEvent = {
  kind: "sdkMessage",
  message: {
    type: "assistant",
    message: { usage: { input_tokens: 1, output_tokens: 1 } },
  } as SDKMessage,
};

interface Fake {
  client: StreamClient;
  /** Dispatch an event as the socket's data listener would. */
  emit: (event: SdkEvent) => void;
  /** Close the socket. */
  close: () => void;
}

/** A StreamClient whose subscribe dispatches `preSeedEvents` synchronously
 *  before the seed promise settles (mirroring event lines racing the
 *  response's microtask on the real socket). */
function fakeClient(seed: AgentState, preSeedEvents: SdkEvent[] = []): Fake {
  let onEvent: ((event: SdkEvent) => void) | undefined;
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return {
    client: {
      subscribe: (handler) => {
        onEvent = handler;
        for (const event of preSeedEvents) {
          handler(event);
        }
        return Promise.resolve(seed);
      },
      waitClosed: () => closed,
    },
    emit: (event) => onEvent!(event),
    close,
  };
}

/** A recording handler stopping when `stopOn` matches the event. */
function recordingHandler(stopOn?: (event: SdkEvent) => boolean): {
  handler: StreamHandler;
  calls: string[];
  states: AgentState[];
} {
  const calls: string[] = [];
  const states: AgentState[] = [];
  return {
    calls,
    states,
    handler: {
      onSeed: (seed) => {
        calls.push("seed");
        states.push(seed);
        return false;
      },
      onEvent: (event, state) => {
        calls.push(`event:${event.kind}`);
        states.push(state);
        return stopOn?.(event) ?? false;
      },
    },
  };
}

test("a seed-satisfied handler stops before any event, ignoring the deadline", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE, [resultEvent]);
  let events = 0;
  const outcome = await runStream(
    fake.client,
    {
      onSeed: () => true,
      onEvent: () => {
        events += 1;
        return false;
      },
    },
    0, // would fire immediately if it armed before the seed check
  );
  assert.equal(outcome, "done");
  assert.equal(events, 0);
});

test("pre-seed events are buffered and processed after onSeed, in order", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE, [assistantEvent, resultEvent]);
  const { handler, calls } = recordingHandler(
    (event) => event.kind === "sdkMessage" && event.message.type === "result",
  );
  const outcome = await runStream(fake.client, handler, undefined);
  assert.equal(outcome, "done");
  assert.deepEqual(calls, ["seed", "event:sdkMessage", "event:sdkMessage"]);
});

test("onEvent sees the post-fold state; the satisfying event is delivered before the stop", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE);
  const { handler, calls, states } = recordingHandler(
    (event) => event.kind === "sdkMessage" && event.message.type === "result",
  );
  const stream = runStream(fake.client, handler, undefined);
  await Promise.resolve(); // let subscribe settle
  fake.emit(assistantEvent);
  fake.emit(resultEvent);
  assert.equal(await stream, "done");
  assert.deepEqual(calls, ["seed", "event:sdkMessage", "event:sdkMessage"]);
  assert.equal(states[1]!.activity, "working"); // post-fold at the event
  assert.equal(states[2]!.activity, "idle");
});

test("events after settlement are ignored (same-chunk multi-line dispatch)", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE);
  const { handler, calls } = recordingHandler(() => true);
  const stream = runStream(fake.client, handler, undefined);
  await Promise.resolve();
  // Two lines from one chunk: the second dispatch happens synchronously
  // after the first already settled the stream.
  fake.emit(resultEvent);
  fake.emit(assistantEvent);
  assert.equal(await stream, "done");
  assert.deepEqual(calls, ["seed", "event:sdkMessage"]);
});

test("pre-seed buffer processing stops at the first satisfying event", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE, [resultEvent, assistantEvent]);
  const { handler, calls } = recordingHandler(() => true);
  assert.equal(await runStream(fake.client, handler, undefined), "done");
  assert.deepEqual(calls, ["seed", "event:sdkMessage"]);
});

test("the quiet timer stops the stream after event silence", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE);
  const outcome = await runStream(
    fake.client,
    { onSeed: () => false, onEvent: () => false, quietMs: 5 },
    undefined,
  );
  assert.equal(outcome, "done");
});

test("each processed event resets the quiet timer", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE);
  let processed = 0;
  const stream = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: () => {
        processed += 1;
        return false;
      },
      quietMs: 60,
    },
    undefined,
  );
  await Promise.resolve();
  // Five events 20ms apart span past the 60ms window; without the per-event
  // reset the quiet timer would fire mid-sequence and the later dispatches
  // would be ignored. Chained timeouts (not a sleep loop) keep each gap well
  // under the window regardless of scheduler jitter.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.emit(assistantEvent);
  }
  assert.equal(await stream, "done");
  assert.equal(processed, 5);
});

test("a satisfying event beats a same-tick close", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE);
  const stream = runStream(
    fake.client,
    { onSeed: () => false, onEvent: () => true },
    undefined,
  );
  await Promise.resolve();
  fake.emit(resultEvent);
  fake.close();
  assert.equal(await stream, "done");
});

test("the deadline rejects with UntilTimeoutError", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE);
  await assert.rejects(
    runStream(fake.client, { onSeed: () => false, onEvent: () => false }, 5),
    UntilTimeoutError,
  );
});

test("the deadline wins a tie with the quiet timer", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE);
  await assert.rejects(
    runStream(
      fake.client,
      { onSeed: () => false, onEvent: () => false, quietMs: 0 },
      0,
    ),
    UntilTimeoutError,
  );
});

test("socket close resolves 'closed'", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE);
  const stream = runStream(
    fake.client,
    { onSeed: () => false, onEvent: () => false },
    undefined,
  );
  await Promise.resolve();
  fake.close();
  assert.equal(await stream, "closed");
});

test("a throwing onSeed rejects the stream", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE);
  await assert.rejects(
    runStream(
      fake.client,
      {
        onSeed: () => {
          throw new Error("seed hook failed");
        },
        onEvent: () => false,
      },
      undefined,
    ),
    /seed hook failed/,
  );
});

test("a throwing onEvent rejects the stream without escaping the dispatcher", async () => {
  const fake = fakeClient(INITIAL_AGENT_STATE);
  const stream = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: () => {
        throw new Error("event hook failed");
      },
    },
    undefined,
  );
  await Promise.resolve();
  // Must not throw here (into the socket's data listener); the rejection
  // surfaces on the stream promise.
  fake.emit(resultEvent);
  await assert.rejects(stream, /event hook failed/);
});

test("a rejecting subscribe rejects the stream", async () => {
  const client: StreamClient = {
    subscribe: () => Promise.reject(new Error("subscribe failed")),
    waitClosed: () => new Promise<void>(() => {}),
  };
  await assert.rejects(
    runStream(client, { onSeed: () => false, onEvent: () => false }, undefined),
    /subscribe failed/,
  );
});
