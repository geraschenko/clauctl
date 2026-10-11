import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { initialAgentState } from "../../core/agent-state/index.ts";
import type { AgentEvent, AgentState } from "../../core/protocol/index.ts";
import { HeldLiveEvents } from "./held-live-events.ts";

/** A distinguishable state per index; the event content is irrelevant. */
function heldPair(index: number): [AgentEvent, AgentState] {
  return [
    { kind: "interruptSent", uuid: randomUUID() },
    { ...initialAgentState(), cwd: `/state-${index}` },
  ];
}

test("position 0 resolves to the seed", async () => {
  const seed = { ...initialAgentState(), cwd: "/seed" };
  const held = new HeldLiveEvents();
  held.hold(...heldPair(1));
  assert.equal(await held.stateAtCut(0, seed), seed);
});

test("an already-reached cut resolves to the state at the cut, not the latest", async () => {
  const held = new HeldLiveEvents();
  const pairs = [heldPair(1), heldPair(2), heldPair(3)];
  for (const pair of pairs) held.hold(...pair);
  assert.equal(await held.stateAtCut(2, initialAgentState()), pairs[1]![1]);
  assert.deepEqual(held.events, pairs);
});

test("a cut not yet reached resolves once enough events are held", async () => {
  const held = new HeldLiveEvents();
  const pairs = [heldPair(1), heldPair(2), heldPair(3)];
  held.hold(...pairs[0]!);
  let resolved: AgentState | undefined;
  const cut = held.stateAtCut(2, initialAgentState()).then((state) => {
    resolved = state;
  });
  await Promise.resolve();
  assert.equal(resolved, undefined);
  held.hold(...pairs[1]!);
  held.hold(...pairs[2]!);
  await cut;
  assert.equal(resolved, pairs[1]![1]);
});
