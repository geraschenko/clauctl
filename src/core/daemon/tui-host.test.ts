import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CONSECUTIVE_RAPID_EXITS,
  nextConsecutiveRapidExits,
  RAPID_EXIT_MS,
} from "./tui-host.ts";

test("a slow exit resets the rapid-exit count", () => {
  assert.equal(nextConsecutiveRapidExits(0, 0, RAPID_EXIT_MS), 0);
  assert.equal(
    nextConsecutiveRapidExits(MAX_CONSECUTIVE_RAPID_EXITS - 1, 1_000, 60_000),
    0,
  );
});

test("rapid exits accumulate up to the respawn limit", () => {
  let count = 0;
  for (let i = 1; i <= MAX_CONSECUTIVE_RAPID_EXITS; i++) {
    count = nextConsecutiveRapidExits(count, 0, 1);
    assert.equal(count, i);
  }
  assert.ok(count >= MAX_CONSECUTIVE_RAPID_EXITS);
});

test("a slow run between rapid exits breaks the consecutive chain", () => {
  const afterRapid = nextConsecutiveRapidExits(0, 0, 1);
  assert.equal(afterRapid, 1);
  assert.equal(nextConsecutiveRapidExits(afterRapid, 0, RAPID_EXIT_MS + 1), 0);
});
