/*
 * The `--until` condition grammar and its fold checkers, consumed through
 * runStream (streaming.ts) by `wait`, `tail --until`, and archive's polite
 * stop. Clauctl-local; the grammar layer is a candidate for a later pictl
 * sync (see docs/specs/wait-and-tail-until.md, Non-goals).
 *
 * - turn-end: the next `sdkMessage` event whose message is a `result` — a
 *   compaction's terminating result counts. Met at the seed only when fully
 *   idle: a pending queued querying message counts as a turn that must end,
 *   which keeps sequential `query; wait` race-free. With multiple turns
 *   queued, this fires at the *first* result (waiting out the queue is
 *   `idle`).
 * - idle: `!isBusy` — activity is idle and no querying messages are queued
 *   (the common condition, so it gets the short name).
 * - no-activity:<secs>: no SdkEvent of any kind for N seconds, regardless of
 *   activity state; catches turns stalled on human-facing UI, which `idle`
 *   never reports. N may be fractional (e.g. `no-activity:0.5`). Enforced by
 *   the stream driver's quiet timer, never by an event.
 */

import { isBusy, type AgentState } from "./agent-state.ts";
import type { SdkEvent } from "./sdk-socket.ts";
import { UsageError } from "./generated/util.ts";

/** app.ts maps this to exit code 3. */
export class UntilTimeoutError extends Error {}

export type UntilCondition =
  | { kind: "turn-end" }
  | { kind: "idle" }
  | { kind: "no-activity"; idleMs: number };

export const UNTIL_USAGE = "turn-end|idle|no-activity:<secs>";
export const UNTIL_COMPLETIONS = ["turn-end", "idle", "no-activity:"] as const;

export function parseUntilCondition(value: string): UntilCondition {
  if (value === "turn-end") {
    return { kind: "turn-end" };
  }
  if (value === "idle") {
    return { kind: "idle" };
  }
  const noActivitySeconds = /^no-activity:(\d+(?:\.\d+)?)$/.exec(value)?.[1];
  if (noActivitySeconds !== undefined) {
    return {
      kind: "no-activity",
      idleMs: secondsToTimerMs(Number(noActivitySeconds)),
    };
  }
  throw new UsageError(`--until must be ${UNTIL_USAGE} (got '${value}')`);
}

/** Node treats setTimeout delays above 2**31-1 ms as ~0, so an oversized
 *  duration would fire immediately instead of far in the future. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Seconds → ms for Node timers. Rejects a duration whose ms value is not
 *  finite or exceeds MAX_TIMER_MS as a usage error; 0 is valid and fires
 *  immediately. */
export function secondsToTimerMs(seconds: number): number {
  const ms = seconds * 1000;
  if (!Number.isFinite(ms) || ms > MAX_TIMER_MS) {
    throw new UsageError(
      `duration must be at most ${Math.floor(MAX_TIMER_MS / 1000)} seconds (got ${seconds})`,
    );
  }
  return ms;
}

/** Quiet-timer duration the stream driver must enforce for this condition;
 *  undefined for event-driven conditions. */
export function untilQuietMs(condition: UntilCondition): number | undefined {
  return condition.kind === "no-activity" ? condition.idleMs : undefined;
}

/** Whether the condition already holds at the subscribe seed. */
export function untilMetAtSeed(
  condition: UntilCondition,
  seed: AgentState,
): boolean {
  switch (condition.kind) {
    case "turn-end":
    case "idle":
      return !isBusy(seed);
    case "no-activity":
      return false;
  }
}

/** Whether this event satisfies the condition; `state` is post-fold. */
export function untilMetByEvent(
  condition: UntilCondition,
  event: SdkEvent,
  state: AgentState,
): boolean {
  switch (condition.kind) {
    case "turn-end":
      return event.kind === "sdkMessage" && event.message.type === "result";
    case "idle":
      return !isBusy(state);
    case "no-activity":
      return false;
  }
}
