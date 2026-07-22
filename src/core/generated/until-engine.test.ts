// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeUntilCheckers,
  parseUntilCondition,
  secondsToTimerMs,
} from "./until-engine.ts";
import { UsageError } from "./util.ts";

test("parseUntilCondition accepts the three grammar forms", () => {
  assert.deepEqual(parseUntilCondition("turn-end"), { kind: "turn-end" });
  assert.deepEqual(parseUntilCondition("idle"), { kind: "idle" });
  assert.deepEqual(parseUntilCondition("no-activity:1.5"), {
    kind: "no-activity",
    idleMs: 1500,
  });
});

test("parseUntilCondition rejects unknown words including killed", () => {
  assert.throws(() => parseUntilCondition("killed"), UsageError);
  assert.throws(() => parseUntilCondition("no-activity:"), UsageError);
  assert.throws(() => parseUntilCondition("no-activity:-1"), UsageError);
});

test("secondsToTimerMs accepts zero and rejects oversized or non-finite durations", () => {
  assert.equal(secondsToTimerMs(0), 0);
  assert.equal(secondsToTimerMs(0.5), 500);
  assert.throws(() => secondsToTimerMs(Infinity), UsageError);
  assert.throws(() => secondsToTimerMs(NaN), UsageError);
  // 2**31 ms is one past Node's timer max.
  assert.throws(() => secondsToTimerMs(2 ** 31 / 1000), UsageError);
  assert.equal(secondsToTimerMs((2 ** 31 - 1) / 1000), 2 ** 31 - 1);
});

// A minimal instantiation: state is "busy or not", the turn ends on "end".
const { untilMetAtSeed, untilMetByEvent, untilQuietMs } = makeUntilCheckers<
  string,
  { busy: boolean }
>({
  isIdle: (state) => !state.busy,
  isTurnEnd: (event) => event === "end",
});

test("turn-end and idle are met at the seed only when not busy", () => {
  for (const kind of ["turn-end", "idle"] as const) {
    assert.equal(untilMetAtSeed({ kind }, { busy: false }), true);
    assert.equal(untilMetAtSeed({ kind }, { busy: true }), false);
  }
  assert.equal(
    untilMetAtSeed({ kind: "no-activity", idleMs: 0 }, { busy: false }),
    false,
  );
});

test("turn-end is met by the turn-end event regardless of state", () => {
  assert.equal(
    untilMetByEvent({ kind: "turn-end" }, "end", { busy: true }),
    true,
  );
  assert.equal(
    untilMetByEvent({ kind: "turn-end" }, "other", { busy: false }),
    false,
  );
});

test("idle is met by any event whose post-fold state is not busy", () => {
  assert.equal(
    untilMetByEvent({ kind: "idle" }, "other", { busy: false }),
    true,
  );
  assert.equal(untilMetByEvent({ kind: "idle" }, "end", { busy: true }), false);
});

test("no-activity is never met by an event and sets the quiet timer", () => {
  const condition = { kind: "no-activity", idleMs: 250 } as const;
  assert.equal(untilMetByEvent(condition, "end", { busy: false }), false);
  assert.equal(untilQuietMs(condition), 250);
  assert.equal(untilQuietMs({ kind: "idle" }), undefined);
  assert.equal(untilQuietMs({ kind: "turn-end" }), undefined);
});
