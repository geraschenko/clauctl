import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { INITIAL_AGENT_STATE, type AgentState } from "./agent-state.ts";
import type { SdkEvent } from "./sdk-socket.ts";
import { untilMetAtSeed, untilMetByEvent } from "./until.ts";

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

// Grammar, duration, and generic checker behavior are covered by the synced
// generated/until-engine.test.ts; these tests pin the clauctl instantiation:
// the SdkEvent/AgentState predicates.

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
