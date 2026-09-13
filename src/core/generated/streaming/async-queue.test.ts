// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncQueue } from "./async-queue.ts";

test("pushedCount counts buffered and directly delivered values without resetting on drain", async () => {
  const queue = new AsyncQueue<number>();
  assert.equal(queue.pushedCount, 0);
  queue.push(1);
  assert.equal(queue.pushedCount, 1);
  queue.push(2);
  assert.equal(queue.pushedCount, 2);

  const iterator = queue[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  assert.equal(queue.pushedCount, 2);

  const pending = iterator.next();
  queue.push(3);
  assert.equal(queue.pushedCount, 3);
  assert.deepEqual(await pending, { done: false, value: 3 });
  assert.equal(queue.pushedCount, 3);
});

test("pushedCount is updated before onPush handlers run", () => {
  const queue = new AsyncQueue<number>();
  const observedCounts: number[] = [];
  queue.onPush(() => {
    observedCounts.push(queue.pushedCount);
  });
  queue.push(1);
  queue.push(2);
  assert.deepEqual(observedCounts, [1, 2]);
});

test("pushedCount survives close and drain and excludes ignored pushes", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.close();
  assert.equal(queue.pushedCount, 1);
  queue.push(2);
  assert.equal(queue.pushedCount, 1);
  const iterator = queue[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: 1 });
  assert.equal((await iterator.next()).done, true);
  assert.equal(queue.pushedCount, 1);
});

test("pushedCount survives cancellation and excludes ignored pushes", () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.push(2);
  queue.cancel();
  assert.equal(queue.pushedCount, 2);
  queue.push(3);
  assert.equal(queue.pushedCount, 2);
});

test("values pushed before next() are delivered in order", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.push(2);
  const iterator = queue[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: 1 });
  assert.deepEqual(await iterator.next(), { done: false, value: 2 });
});

test("a parked next() resolves when a value arrives", async () => {
  const queue = new AsyncQueue<number>();
  const pending = queue[Symbol.asyncIterator]().next();
  queue.push(7);
  assert.deepEqual(await pending, { done: false, value: 7 });
});

test("concurrent next() calls each take a distinct queued value", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.push(2);
  const iterator = queue[Symbol.asyncIterator]();
  const results = await Promise.all([iterator.next(), iterator.next()]);
  assert.deepEqual(
    results.map(({ value }) => value),
    [1, 2],
  );
});

test("close() establishes only the first cutoff and drains queued values", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  assert.equal(queue.close(), true);
  assert.equal(queue.close(), false);
  const iterator = queue[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: 1 });
  assert.equal((await iterator.next()).done, true);
});

test("close() ends a parked next()", async () => {
  const queue = new AsyncQueue<number>();
  const pending = queue[Symbol.asyncIterator]().next();
  queue.close();
  assert.equal((await pending).done, true);
});

test("cancel() drops queued values and ends immediately", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.cancel();
  assert.equal((await queue[Symbol.asyncIterator]().next()).done, true);
});

test("return() ends a parked next(), which an async generator cannot", async () => {
  const queue = new AsyncQueue<number>();
  const iterator = queue[Symbol.asyncIterator]();
  const pending = iterator.next();
  assert.equal((await iterator.return!()).done, true);
  assert.equal((await pending).done, true);
});

test("onPush observes only accepted source activity and can unsubscribe", () => {
  const queue = new AsyncQueue<number>();
  let pushes = 0;
  const unsubscribe = queue.onPush(() => {
    pushes += 1;
  });
  queue.push(1);
  unsubscribe();
  queue.push(2);
  queue.close();
  queue.push(3);
  assert.equal(pushes, 1);
});

test("push() after close() or cancel() is ignored", async () => {
  const closed = new AsyncQueue<number>();
  closed.close();
  closed.push(1);
  assert.equal((await closed[Symbol.asyncIterator]().next()).done, true);

  const cancelled = new AsyncQueue<number>();
  cancelled.cancel();
  cancelled.push(1);
  assert.equal((await cancelled[Symbol.asyncIterator]().next()).done, true);
});
