/*
 * clauctl's instantiation of the shared `--until` checkers (the grammar and
 * generic engine live in generated/until-engine.ts), consumed through
 * runStream (generated/streaming/driver.ts) by `wait`, `tail --until`, and
 * archive's polite stop. Condition semantics here:
 *
 * - turn-end: the next `sdkMessage` event whose message is a `result` — a
 *   compaction's terminating result counts. Met at the seed only when fully
 *   idle: a pending queued querying message counts as a turn that must end,
 *   which keeps sequential `query; wait` race-free. With multiple turns
 *   queued, this fires at the *first* result (waiting out the queue is
 *   `idle`).
 * - idle: `isIdle` — activity is idle and no querying messages are queued
 *   (the common condition, so it gets the short name). A task's pending
 *   permission ask does not affect it: the CLI would run a prompt.
 * - quiescent: `isQuiescent` — idle and no live task (subagent, background
 *   shell); what a Query restart requires.
 * - no-activity:<secs>: no AgentEvent of any kind for N seconds, regardless of
 *   activity state; catches turns stalled on human-facing UI, which `idle`
 *   never reports. N may be fractional (e.g. `no-activity:0.5`). Enforced by
 *   the stream driver's quiet timer, never by an event.
 */

import { isIdle, isQuiescent } from "./agent-state/index.ts";
import type { AgentState, AgentEvent } from "./protocol/index.ts";
import { makeUntilCheckers } from "./generated/until-engine.ts";

export const {
  usage: UNTIL_USAGE,
  completions: UNTIL_COMPLETIONS,
  parse: parseUntilCondition,
  untilMetAtSeed,
  untilMetByEvent,
  untilQuietMs,
} = makeUntilCheckers<AgentEvent, AgentState>({
  stateConditions: { idle: isIdle, quiescent: isQuiescent },
  isTurnEnd: (event) =>
    event.kind === "sdkMessage" && event.message.type === "result",
});
