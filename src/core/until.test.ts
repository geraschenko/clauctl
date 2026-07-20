import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { INITIAL_AGENT_STATE, type AgentState } from "./agent-state.ts";
import { UsageError } from "./generated/util.ts";
import type { SdkEvent } from "./sdk-socket.ts";
import {
  parseUntilCondition,
  secondsToTimerMs,
  untilMetAtSeed,
  untilMetByEvent,
  untilQuietMs,
} from "./until.ts";

const idleState = INITIAL_AGENT_STATE;
const workingState: AgentState = {
  ...INITIAL_AGENT_STATE,
  activity: "working",
};
const queryingMessage: SDKUserMessage = {
  type: "user",
  message: { role: "user", content: "hi" },
  parent_tool_use_id: null,
};
/** Idle activity but a querying message queued — a turn is still owed. */
const pendingState: AgentState = {
  ...INITIAL_AGENT_STATE,
  activity: "pending",
  queuedMessages: [{ id: 1, message: queryingMessage }],
};

const resultEvent: SdkEvent = {
  kind: "sdkMessage",
  message: { type: "result" } as SDKMessage,
};
const assistantEvent: SdkEvent = {
  kind: "sdkMessage",
  message: { type: "assistant" } as SDKMessage,
};

// --- parseUntilCondition -----------------------------------------------------

test("parseUntilCondition accepts the three condition kinds", () => {
  assert.deepEqual(parseUntilCondition("turn-end"), { kind: "turn-end" });
  assert.deepEqual(parseUntilCondition("idle"), { kind: "idle" });
  assert.deepEqual(parseUntilCondition("no-activity:1.5"), {
    kind: "no-activity",
    idleMs: 1500,
  });
  assert.deepEqual(parseUntilCondition("no-activity:0"), {
    kind: "no-activity",
    idleMs: 0,
  });
});

test("parseUntilCondition rejects malformed conditions as usage errors", () => {
  for (const bad of [
    "bogus",
    "no-activity",
    "no-activity:",
    "no-activity:-1",
    "no-activity:abc",
    "no-activity:1s",
    "",
  ]) {
    assert.throws(() => parseUntilCondition(bad), UsageError, bad);
  }
});

test("parseUntilCondition rejects over-timer-max no-activity durations", () => {
  assert.throws(
    () => parseUntilCondition("no-activity:9999999999"),
    UsageError,
  );
});

// --- secondsToTimerMs --------------------------------------------------------

test("secondsToTimerMs converts valid durations, including zero", () => {
  assert.equal(secondsToTimerMs(0), 0);
  assert.equal(secondsToTimerMs(1.5), 1500);
  assert.equal(secondsToTimerMs(2147483), 2147483000);
});

test("secondsToTimerMs rejects non-finite and over-timer-max values", () => {
  assert.throws(() => secondsToTimerMs(Infinity), UsageError);
  assert.throws(() => secondsToTimerMs(NaN), UsageError);
  assert.throws(() => secondsToTimerMs(2 ** 31), UsageError); // ms overflows
});

// --- untilQuietMs ------------------------------------------------------------

test("untilQuietMs is the no-activity window and undefined otherwise", () => {
  assert.equal(untilQuietMs({ kind: "no-activity", idleMs: 500 }), 500);
  assert.equal(untilQuietMs({ kind: "turn-end" }), undefined);
  assert.equal(untilQuietMs({ kind: "idle" }), undefined);
});

// --- untilMetAtSeed ----------------------------------------------------------

test("turn-end and idle are met at a fully idle seed", () => {
  assert.equal(untilMetAtSeed({ kind: "turn-end" }, idleState), true);
  assert.equal(untilMetAtSeed({ kind: "idle" }, idleState), true);
});

test("turn-end and idle are not met at a busy or pending-queued seed", () => {
  for (const seed of [workingState, pendingState]) {
    assert.equal(untilMetAtSeed({ kind: "turn-end" }, seed), false);
    assert.equal(untilMetAtSeed({ kind: "idle" }, seed), false);
  }
});

test("no-activity is never met at the seed, even idle", () => {
  assert.equal(
    untilMetAtSeed({ kind: "no-activity", idleMs: 0 }, idleState),
    false,
  );
});

// --- untilMetByEvent ---------------------------------------------------------

test("turn-end fires at any result, even with more turns queued", () => {
  assert.equal(
    untilMetByEvent({ kind: "turn-end" }, resultEvent, idleState),
    true,
  );
  // First result of a queue: post-fold state is pending, still a turn end.
  assert.equal(
    untilMetByEvent({ kind: "turn-end" }, resultEvent, pendingState),
    true,
  );
  assert.equal(
    untilMetByEvent({ kind: "turn-end" }, assistantEvent, workingState),
    false,
  );
});

test("idle fires only when the post-fold state is fully idle", () => {
  assert.equal(untilMetByEvent({ kind: "idle" }, resultEvent, idleState), true);
  assert.equal(
    untilMetByEvent({ kind: "idle" }, resultEvent, pendingState),
    false,
  );
});

test("no-activity is never met by an event (the quiet timer owns it)", () => {
  assert.equal(
    untilMetByEvent({ kind: "no-activity", idleMs: 0 }, resultEvent, idleState),
    false,
  );
});
