import assert from "node:assert/strict";
import { test } from "node:test";
import { RwGate } from "./rw-gate.ts";

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

test("shared holders coexist; tryExclusive throws until they release", async () => {
  const gate = new RwGate();
  const releaseA = gate.tryShared();
  const releaseB = await gate.awaitShared();
  assert.throws(() => gate.tryExclusive(), /lock is held/);
  releaseA();
  assert.throws(() => gate.tryExclusive(), /lock is held/);
  releaseB();
  const releaseExclusive = gate.tryExclusive();
  assert.throws(() => gate.tryShared(), /exclusive acquisition in progress/);
  releaseExclusive();
  gate.tryShared()();
});

test("awaitExclusive drains shared holders; new shared acquisitions wait", async () => {
  const gate = new RwGate();
  const releaseShared = gate.tryShared();
  let exclusiveGranted = false;
  const exclusive = gate.awaitExclusive().then((release) => {
    exclusiveGranted = true;
    return release;
  });
  await flushMicrotasks();
  assert.equal(exclusiveGranted, false);

  // Writer preference: the pending writer blocks new shared acquisitions.
  assert.throws(() => gate.tryShared(), /exclusive acquisition in progress/);
  let lateSharedGranted = false;
  const lateShared = gate.awaitShared().then((release) => {
    lateSharedGranted = true;
    return release;
  });
  await flushMicrotasks();
  assert.equal(lateSharedGranted, false);

  releaseShared();
  const releaseExclusive = await exclusive;
  assert.equal(lateSharedGranted, false); // still excluded by the holder
  releaseExclusive();
  (await lateShared)();
});

test("awaitExclusive queues behind another exclusive holder", async () => {
  const gate = new RwGate();
  const releaseFirst = await gate.awaitExclusive();
  let secondGranted = false;
  const second = gate.awaitExclusive().then((release) => {
    secondGranted = true;
    return release;
  });
  await flushMicrotasks();
  assert.equal(secondGranted, false);
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondGranted, true);
  releaseSecond();
});

test("release functions are idempotent", async () => {
  const gate = new RwGate();
  const releaseShared = gate.tryShared();
  releaseShared();
  releaseShared(); // a double release must not free another holder's slot
  const releaseExclusive = await gate.awaitExclusive();
  releaseExclusive();
  releaseExclusive();
  gate.tryShared()();
});
