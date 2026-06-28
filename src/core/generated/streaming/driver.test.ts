// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncQueue } from "./async-queue.ts";
import {
  runStream,
  type StreamClient,
  type StreamEvent,
  type StreamSubscription,
} from "./driver.ts";

interface TestEvent {
  readonly name: string;
}

interface TestState {
  readonly applied: readonly string[];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** The production queue, instrumented to record whether the driver cancelled
 *  the stream or merely drained it. */
class TestEventSource extends AsyncQueue<StreamEvent<TestEvent, TestState>> {
  cancelled = false;

  override cancel(): void {
    this.cancelled = true;
    super.cancel();
  }
}

interface FakeClient {
  readonly client: StreamClient<TestEvent, TestState>;
  readonly source: TestEventSource;
  emit(name: string): void;
  close(): void;
  seed(state?: TestState): void;
  failSubscribe(error: Error): void;
}

function fakeClient(): FakeClient {
  const source = new TestEventSource();
  const seedDeferred = deferred<TestState>();
  let state: TestState = { applied: [] };
  const client: StreamClient<TestEvent, TestState> = {
    async subscribe(): Promise<StreamSubscription<TestEvent, TestState>> {
      const seed = await seedDeferred.promise;
      return { seed, events: source };
    },
  };
  return {
    client,
    source,
    emit(name: string): void {
      state = { applied: [...state.applied, name] };
      source.push({ event: { name }, state });
    },
    close: () => source.close(),
    seed(seedState: TestState = { applied: [] }): void {
      seedDeferred.resolve(seedState);
    },
    failSubscribe: (error: Error) => seedDeferred.reject(error),
  };
}

function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("seed satisfaction cancels queued events and flushes before resolving", async () => {
  const fake = fakeClient();
  const order: string[] = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => {
        order.push("seed");
        return true;
      },
      onEvent: (event) => {
        order.push(event.name);
        return false;
      },
      onEnd: () => {
        order.push("end");
      },
    },
    undefined,
  );
  fake.emit("queued");
  const seed = { applied: ["seed"] };
  fake.seed(seed);
  assert.deepEqual(await resultPromise, { outcome: "done", state: seed });
  assert.deepEqual(order, ["seed", "end"]);
  assert.equal(fake.source.cancelled, true);
});

test("queued events are consumed FIFO with their post-fold states", async () => {
  const fake = fakeClient();
  const seen: Array<{ name: string; applied: readonly string[] }> = [];
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
  assert.deepEqual(await resultPromise, {
    outcome: "done",
    state: { applied: ["a", "b", "c"] },
  });
  assert.deepEqual(seen, [
    { name: "a", applied: ["a"] },
    { name: "b", applied: ["a", "b"] },
    { name: "c", applied: ["a", "b", "c"] },
  ]);
});

test("async event handlers are serialized", async () => {
  const fake = fakeClient();
  const firstGate = deferred<boolean>();
  const started: string[] = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event) => {
        started.push(event.name);
        return event.name === "a" ? firstGate.promise : true;
      },
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("a");
  fake.emit("b");
  await settleMicrotasks();
  assert.deepEqual(started, ["a"]);
  firstGate.resolve(false);
  assert.equal((await resultPromise).outcome, "done");
  assert.deepEqual(started, ["a", "b"]);
});

test("a satisfying event is delivered before projector flush", async () => {
  const fake = fakeClient();
  const order: string[] = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event) => {
        order.push(event.name);
        return true;
      },
      onEnd: () => {
        order.push("end");
      },
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("stop");
  await resultPromise;
  assert.deepEqual(order, ["stop", "end"]);
  assert.equal(fake.source.cancelled, true);
});

test("quiet source cutoff waits for an in-flight handler", async () => {
  const fake = fakeClient();
  const gate = deferred<boolean>();
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: () => gate.promise,
      quietMs: 10,
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("slow");
  let resolved = false;
  void resultPromise.then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(resolved, false);
  gate.resolve(false);
  assert.deepEqual(await resultPromise, {
    outcome: "done",
    state: { applied: ["slow"] },
  });
  assert.equal(fake.source.cancelled, false);
});

test("timeout wins a tie with quiet completion", async () => {
  const fake = fakeClient();
  const resultPromise = runStream(
    fake.client,
    { onSeed: () => false, onEvent: () => false, quietMs: 10 },
    10,
  );
  fake.seed();
  assert.deepEqual(await resultPromise, {
    outcome: "timeout",
    state: { applied: [] },
  });
});

test("subscription latency does not count toward timers", async () => {
  const fake = fakeClient();
  const resultPromise = runStream(
    fake.client,
    { onSeed: () => false, onEvent: () => false, quietMs: 5 },
    undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.seed();
  assert.equal((await resultPromise).outcome, "done");
});

test("source pushes do not arm quiet timing while onSeed is in flight", async () => {
  const fake = fakeClient();
  const seedGate = deferred<boolean>();
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => seedGate.promise,
      onEvent: () => false,
      quietMs: 5,
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("during-seed");
  let resolved = false;
  void resultPromise.then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resolved, false);
  seedGate.resolve(false);
  assert.deepEqual(await resultPromise, {
    outcome: "done",
    state: { applied: ["during-seed"] },
  });
});

test("source pushes reset quiet timing while a handler is in flight", async () => {
  const fake = fakeClient();
  const gate = deferred<boolean>();
  const seen: string[] = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event) => {
        seen.push(event.name);
        return event.name === "slow" ? gate.promise : false;
      },
      quietMs: 50,
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("slow");
  await new Promise((resolve) => setTimeout(resolve, 30));
  fake.emit("reset-quiet");
  await new Promise((resolve) => setTimeout(resolve, 30));
  fake.emit("after-original-cutoff");
  gate.resolve(false);
  assert.deepEqual(await resultPromise, {
    outcome: "done",
    state: { applied: ["slow", "reset-quiet", "after-original-cutoff"] },
  });
  assert.deepEqual(seen, ["slow", "reset-quiet", "after-original-cutoff"]);
});

test("timeout drains queued events, awaits the in-flight handler, then flushes", async () => {
  const fake = fakeClient();
  const gate = deferred<boolean>();
  const order: string[] = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event) => {
        order.push(event.name);
        return gate.promise;
      },
      onEnd: () => {
        order.push("end");
      },
    },
    5,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("in-flight");
  fake.emit("queued");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(order, ["in-flight"]);
  assert.equal(fake.source.cancelled, false);
  gate.resolve(false);
  assert.deepEqual(await resultPromise, {
    outcome: "timeout",
    state: { applied: ["in-flight", "queued"] },
  });
  assert.deepEqual(order, ["in-flight", "queued", "end"]);
});

test("a queued satisfying event overrides a timeout cutoff without restarting onStop", async () => {
  const fake = fakeClient();
  const gate = deferred<boolean>();
  const seen: string[] = [];
  let stopCalls = 0;
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event) => {
        seen.push(event.name);
        return event.name === "in-flight" ? gate.promise : true;
      },
      onStop: () => {
        stopCalls += 1;
      },
    },
    5,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("in-flight");
  fake.emit("satisfying");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(stopCalls, 1);
  gate.resolve(false);
  assert.deepEqual(await resultPromise, {
    outcome: "done",
    state: { applied: ["in-flight", "satisfying"] },
  });
  assert.deepEqual(seen, ["in-flight", "satisfying"]);
  assert.equal(stopCalls, 1);
});

test("transport close remains first cutoff when draining crosses timeout", async () => {
  const fake = fakeClient();
  const gate = deferred<boolean>();
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: () => gate.promise,
    },
    10,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("in-flight");
  fake.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  gate.resolve(false);
  assert.deepEqual(await resultPromise, {
    outcome: "closed",
    state: { applied: ["in-flight"] },
  });
});

test("a timeout-time in-flight handler failure rejects without flushing", async () => {
  const fake = fakeClient();
  const gate = deferred<boolean>();
  const failure = new Error("late handler failure");
  let ended = false;
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: () => gate.promise,
      onEnd: () => {
        ended = true;
      },
    },
    5,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("in-flight");
  await new Promise((resolve) => setTimeout(resolve, 15));
  gate.reject(failure);
  await assert.rejects(resultPromise, failure);
  assert.equal(ended, false);
});

test("source close drains queued events and a satisfying event wins", async () => {
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
  fake.emit("a");
  fake.emit("stop");
  fake.emit("after-stop");
  fake.close();
  assert.deepEqual(await resultPromise, {
    outcome: "done",
    state: { applied: ["a", "stop"] },
  });
  assert.deepEqual(seen, ["a", "stop"]);
});

test("source exhaustion flushes and reports the last drained state", async () => {
  const fake = fakeClient();
  const order: string[] = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: (event) => {
        order.push(event.name);
        return false;
      },
      onEnd: () => {
        order.push("end");
      },
    },
    undefined,
  );
  fake.seed();
  fake.emit("a");
  fake.emit("b");
  fake.close();
  assert.deepEqual(await resultPromise, {
    outcome: "closed",
    state: { applied: ["a", "b"] },
  });
  assert.deepEqual(order, ["a", "b", "end"]);
  assert.equal(fake.source.cancelled, false);
});

test("hook failures reject without onEnd", async () => {
  const fake = fakeClient();
  const failure = new Error("handler failed");
  let ended = false;
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: () => {
        throw failure;
      },
      onEnd: () => {
        ended = true;
      },
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("boom");
  await assert.rejects(resultPromise, failure);
  assert.equal(ended, false);
  assert.equal(fake.source.cancelled, true);
});

test("onSeed and subscription failures reject without flushing", async () => {
  const seedFake = fakeClient();
  let ended = false;
  const seedResult = runStream(
    seedFake.client,
    {
      onSeed: () => {
        throw new Error("seed failed");
      },
      onEvent: () => false,
      onEnd: () => {
        ended = true;
      },
    },
    undefined,
  );
  seedFake.seed();
  await assert.rejects(seedResult, /seed failed/u);
  assert.equal(ended, false);

  const subscribeFake = fakeClient();
  const subscribeResult = runStream(
    subscribeFake.client,
    { onSeed: () => false, onEvent: () => false },
    undefined,
  );
  subscribeFake.failSubscribe(new Error("subscribe failed"));
  await assert.rejects(subscribeResult, /subscribe failed/u);
});

test("onStop starts at event cancellation and completes before onEnd", async () => {
  const fake = fakeClient();
  const stopGate = deferred<void>();
  const order: string[] = [];
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: () => true,
      onStop: () => {
        order.push("stop-start");
        return stopGate.promise.then(() => {
          order.push("stop-end");
        });
      },
      onEnd: () => {
        order.push("end");
      },
    },
    undefined,
  );
  fake.seed();
  await settleMicrotasks();
  fake.emit("satisfying");
  await settleMicrotasks();
  assert.deepEqual(order, ["stop-start"]);
  stopGate.resolve();
  assert.equal((await resultPromise).outcome, "done");
  assert.deepEqual(order, ["stop-start", "stop-end", "end"]);
});

test("onStop failure cancels draining and rejects without onEnd", async () => {
  const fake = fakeClient();
  const failure = new Error("stop failed");
  let ended = false;
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => false,
      onEvent: () => false,
      onStop: () => {
        throw failure;
      },
      onEnd: () => {
        ended = true;
      },
    },
    5,
  );
  fake.seed();
  fake.emit("queued");
  await assert.rejects(resultPromise, failure);
  assert.equal(ended, false);
  assert.equal(fake.source.cancelled, true);
});

test("onEnd failure rejects successful settlement", async () => {
  const fake = fakeClient();
  const resultPromise = runStream(
    fake.client,
    {
      onSeed: () => true,
      onEvent: () => false,
      onEnd: () => {
        throw new Error("flush failed");
      },
    },
    undefined,
  );
  fake.seed();
  await assert.rejects(resultPromise, /flush failed/u);
});
