import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CONSECUTIVE_RAPID_EXITS,
  nextRespawnState,
  RAPID_EXIT_MS,
} from "./daemon.ts";

test("a slow exit resets the rapid-exit count and respawns", () => {
  assert.deepEqual(nextRespawnState(0, 0, RAPID_EXIT_MS), {
    consecutiveRapidExits: 0,
    respawn: true,
  });
  assert.deepEqual(
    nextRespawnState(MAX_CONSECUTIVE_RAPID_EXITS - 1, 1_000, 60_000),
    { consecutiveRapidExits: 0, respawn: true },
  );
});

test("rapid exits accumulate and respawn until the limit", () => {
  let consecutiveRapidExits = 0;
  for (let i = 1; i < MAX_CONSECUTIVE_RAPID_EXITS; i++) {
    const next = nextRespawnState(consecutiveRapidExits, 0, 1);
    assert.deepEqual(next, { consecutiveRapidExits: i, respawn: true });
    consecutiveRapidExits = next.consecutiveRapidExits;
  }
  assert.deepEqual(nextRespawnState(consecutiveRapidExits, 0, 1), {
    consecutiveRapidExits: MAX_CONSECUTIVE_RAPID_EXITS,
    respawn: false,
  });
});

test("a slow run between rapid exits breaks the consecutive chain", () => {
  const afterRapid = nextRespawnState(0, 0, 1);
  const afterSlow = nextRespawnState(
    afterRapid.consecutiveRapidExits,
    0,
    RAPID_EXIT_MS + 1,
  );
  assert.deepEqual(afterSlow, { consecutiveRapidExits: 0, respawn: true });
});
