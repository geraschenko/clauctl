// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeUntilCheckers,
  secondsToTimerMs,
  type UntilCondition,
} from "./until-engine.ts";
import { UsageError } from "./util.ts";

const {
  usage,
  completions,
  parse,
  untilMetAtSeed,
  untilMetByEvent,
  untilQuietMs,
} = makeUntilCheckers<string, { busy: boolean; ready?: boolean }>({
  stateConditions: {
    idle: (state) => !state.busy,
    ready: (state) => state.ready === true,
  },
  isTurnEnd: (event) => event === "end",
});

test("usage and completions list the instantiated conditions in order", () => {
  assert.equal(usage, "turn-end|idle|ready|no-activity:<secs>");
  assert.deepEqual(completions, ["turn-end", "idle", "ready", "no-activity:"]);
});

test("each instance accepts only its own named conditions", () => {
  const idleOnly = makeUntilCheckers<string, boolean>({
    stateConditions: { idle: (busy) => !busy },
    isTurnEnd: (event) => event === "end",
  });
  assert.equal(idleOnly.usage, "turn-end|idle|no-activity:<secs>");
  assert.deepEqual(idleOnly.completions, ["turn-end", "idle", "no-activity:"]);
  assert.throws(() => idleOnly.parse("ready"), UsageError);
  assert.deepEqual(parse("ready"), { kind: "state", name: "ready" });
});

test("parse accepts turn-end, named states, and no-activity durations", () => {
  assert.deepEqual(parse("turn-end"), { kind: "turn-end" });
  for (const name of ["idle", "ready"]) {
    assert.deepEqual(parse(name), { kind: "state", name });
  }
  assert.deepEqual(parse("no-activity:1.5"), {
    kind: "no-activity",
    idleMs: 1500,
  });
  assert.deepEqual(parse("no-activity:0"), {
    kind: "no-activity",
    idleMs: 0,
  });
});

test("parse rejects unknown names and malformed durations with instance usage", () => {
  for (const value of [
    "killed",
    "",
    "toString",
    "constructor",
    "__proto__",
    "no-activity:",
    "no-activity:-1",
  ]) {
    assert.throws(
      () => parse(value),
      (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.equal(
          error.message,
          `--until must be ${usage} (got '${value}')`,
        );
        return true;
      },
    );
  }
  assert.throws(() => parse(`no-activity:${2 ** 31 / 1000}`), UsageError);
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

test("turn-end and idle are met at the seed only when not busy", () => {
  const conditions: UntilCondition[] = [
    { kind: "turn-end" },
    { kind: "state", name: "idle" },
  ];
  for (const condition of conditions) {
    assert.equal(untilMetAtSeed(condition, { busy: false }), true);
    assert.equal(untilMetAtSeed(condition, { busy: true, ready: true }), false);
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
  const condition = parse("idle");
  assert.equal(untilMetByEvent(condition, "other", { busy: false }), true);
  assert.equal(untilMetByEvent(condition, "end", { busy: true }), false);
});

test("a second named condition uses its own predicate at seed and by event", () => {
  const condition = parse("ready");
  assert.equal(untilMetAtSeed(condition, { busy: true, ready: true }), true);
  assert.equal(untilMetAtSeed(condition, { busy: false }), false);
  assert.equal(
    untilMetByEvent(condition, "other", { busy: true, ready: true }),
    true,
  );
  assert.equal(untilMetByEvent(condition, "end", { busy: false }), false);
  assert.equal(untilQuietMs(condition), undefined);
});

test("no-activity is never met by an event and sets the quiet timer", () => {
  const condition = { kind: "no-activity", idleMs: 250 } as const;
  assert.equal(untilMetByEvent(condition, "end", { busy: false }), false);
  assert.equal(untilQuietMs(condition), 250);
  assert.equal(untilQuietMs(parse("idle")), undefined);
  assert.equal(untilQuietMs({ kind: "turn-end" }), undefined);
});
