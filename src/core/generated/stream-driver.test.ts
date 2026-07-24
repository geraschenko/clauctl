// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runStream, type StreamClient } from "./stream-driver.ts";
import { UntilTimeoutError } from "./until-engine.ts";

interface TestEvent {
  name: string;
}

/** The fake client's fold appends each event name, so the state paired with
 *  an event proves both ordering and event↔state alignment. */
interface TestState {
  applied: string[];
}

interface FakeClient {
  client: StreamClient<TestEvent, TestState>;
  emit(name: string): void;
  close(): void;
  seed(state?: TestState): void;
  failSubscribe(error: Error): void;
}

/** A StreamClient whose seed resolution, event dispatch, and close are all
 *  test-controlled. Like the real client it owns the fold: each emit advances
 *  the state (folding from the empty state, matching the default seed) and
 *  dispatches the (event, post-fold state) pair. */
function fakeClient(): FakeClient {
  let onEvent: ((event: TestEvent, state: TestState) => void) | undefined;
  let state: TestState = { applied: [] };
  let resolveSeed!: (seed: TestState) => void;
  let rejectSeed!: (error: Error) => void;
  const seedPromise = new Promise<TestState>((resolve, reject) => {
    resolveSeed = resolve;
    rejectSeed = reject;
  });
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return {
    client: {
      subscribe(listener) {
        onEvent = listener;
        return seedPromise;
      },
      waitClosed: () => closedPromise,
    },
    emit: (name) => {
      state = { applied: [...state.applied, name] };
      onEvent!({ name }, state);
    },
    close: () => resolveClosed(),
    seed: (seedState = { applied: [] }) => resolveSeed(seedState),
    failSubscribe: (error) => rejectSeed(error),
  };
}

/** Let all currently queued promise continuations run. */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("seed satisfaction stops before any event, dropping pre-seed pairs", async () => {
  const fake = fakeClient();
  const seen: string[] = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => true,
      onEvent: (event) => {
        seen.push(event.name);
        return false;
      },
    },
    undefined,
  );
  fake.emit("early");
  const seedState = { applied: ["seed"] };
  fake.seed(seedState);
  assert.deepEqual(await resultPromise, {
    outcome: "done",
    state: seedState,
  });
  await settleMicrotasks();
  assert.deepEqual(seen, []);
});

test("pairs dispatched before the seed are processed in order ahead of live events", async () => {
  const fake = fakeClient();
  const seen: Array<{ name: string; applied: string[] }> = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event, state) => {
        seen.push({ name: event.name, applied: state.applied });
        return event.name === "c";
      },
    },
    undefined,
  );
  fake.emit("a");
  fake.emit("b");
  fake.seed();
  await settleMicrotasks();
  fake.emit("c");
  const result = await resultPromise;
  assert.equal(result.outcome, "done");
  // Each event carries the state folded up to itself, and the result carries
  // the satisfying event's state.
  assert.deepEqual(seen, [
    { name: "a", applied: ["a"] },
    { name: "b", applied: ["a", "b"] },
    { name: "c", applied: ["a", "b", "c"] },
  ]);
  assert.deepEqual(result.state, { applied: ["a", "b", "c"] });
});

test("async handler calls are serialized FIFO, each judged against its own state snapshot", async () => {
  const fake = fakeClient();
  const started: Array<{ name: string; applied: string[] }> = [];
  const gates = new Map<string, ReturnType<typeof deferred<boolean>>>();
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event, state) => {
        started.push({ name: event.name, applied: state.applied });
        const gate = deferred<boolean>();
        gates.set(event.name, gate);
        return gate.promise;
      },
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("a");
  fake.emit("b");
  await settleMicrotasks();
  // b must not start while a's handler is in flight — and when it does, its
  // state is b's snapshot, not the client's (already advanced) live state.
  assert.deepEqual(started, [{ name: "a", applied: ["a"] }]);
  gates.get("a")!.resolve(false);
  await settleMicrotasks();
  assert.deepEqual(started, [
    { name: "a", applied: ["a"] },
    { name: "b", applied: ["a", "b"] },
  ]);
  gates.get("b")!.resolve(true);
  assert.deepEqual(await resultPromise, {
    outcome: "done",
    state: { applied: ["a", "b"] },
  });
});

test("events after settlement are dropped", async () => {
  const fake = fakeClient();
  const seen: string[] = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event) => {
        seen.push(event.name);
        return event.name === "stop";
      },
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("stop");
  fake.emit("late");
  assert.equal((await resultPromise).outcome, "done");
  await settleMicrotasks();
  assert.deepEqual(seen, ["stop"]);
});

test("quiet timer settles done after silence with the last event's state, re-arming per handler call", async () => {
  const fake = fakeClient();
  const seen: string[] = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event) => {
        seen.push(event.name);
        return false;
      },
      quietMs: 20,
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("a");
  fake.emit("b");
  assert.deepEqual(await resultPromise, {
    outcome: "done",
    state: { applied: ["a", "b"] },
  });
  assert.deepEqual(seen, ["a", "b"]);
});

test("deadline expiry rejects with UntilTimeoutError, winning ties against the quiet timer", async () => {
  const fake = fakeClient();
  const resultPromise = runStream(
    fake.client,
    { onSeed: () => false, onEvent: () => false, quietMs: 20 },
    20,
  );
  fake.seed();
  await assert.rejects(resultPromise, UntilTimeoutError);
});

test("timers arm only after the seed, so subscribe latency does not count", async () => {
  const fake = fakeClient();
  const resultPromise = runStream(
    fake.client,
    { onSeed: () => false, onEvent: () => false, quietMs: 5 },
    undefined,
  );
  // The quiet timer must not be running yet; give it ample time to misfire.
  await new Promise((resolve) => setTimeout(resolve, 25));
  fake.seed();
  assert.equal((await resultPromise).outcome, "done");
});

test("socket close settles closed after the in-flight handler call, dropping the queue", async () => {
  const fake = fakeClient();
  const started: string[] = [];
  const gate = deferred<boolean>();
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event) => {
        started.push(event.name);
        return gate.promise;
      },
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("in-flight");
  fake.emit("queued");
  await settleMicrotasks();
  fake.close();
  await settleMicrotasks();
  gate.resolve(false);
  assert.deepEqual(await resultPromise, {
    outcome: "closed",
    state: { applied: ["in-flight"] },
  });
  await settleMicrotasks();
  assert.deepEqual(started, ["in-flight"]);
});

test("socket close after the seed settles closed with the seed state", async () => {
  const fake = fakeClient();
  const resultPromise = runStream(
    fake.client,
    { onSeed: () => false, onEvent: () => false },
    undefined,
  );
  const seedState = { applied: ["seeded"] };
  fake.seed(seedState);
  await settleMicrotasks();
  fake.close();
  assert.deepEqual(await resultPromise, {
    outcome: "closed",
    state: seedState,
  });
});

test("socket close before the seed rejects (there is no state to resolve with)", async () => {
  const fake = fakeClient();
  const resultPromise = runStream(
    fake.client,
    { onSeed: () => false, onEvent: () => false },
    undefined,
  );
  fake.close();
  await assert.rejects(resultPromise, /closed before the subscribe seed/);
});

test("handler exceptions reject the stream", async () => {
  const failure = new Error("handler failed");
  const fake = fakeClient();
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: () => {
        throw failure;
      },
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("boom");
  await assert.rejects(resultPromise, failure);
});

test("onSeed exceptions and subscribe failures reject the stream", async () => {
  const seedFailure = new Error("seed failed");
  const seedFake = fakeClient();
  const seedResult = runStream(
    seedFake.client,
    {
      onSeed: () => {
        throw seedFailure;
      },
      onEvent: () => false,
    },
    undefined,
  );
  seedFake.seed();
  await assert.rejects(seedResult, seedFailure);

  const subscribeFailure = new Error("not a pi socket");
  const subscribeFake = fakeClient();
  const subscribeResult = runStream(
    subscribeFake.client,
    { onSeed: () => false, onEvent: () => false },
    undefined,
  );
  subscribeFake.failSubscribe(subscribeFailure);
  await assert.rejects(subscribeResult, subscribeFailure);
});
