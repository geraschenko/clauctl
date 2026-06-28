// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/*
 * The `--until` condition grammar and its generic fold checkers. This file is
 * repo-agnostic and consumed verbatim by the consuming repo's sync script: it
 * may import only other synced files (util.ts). Repo-specific judgments enter
 * through the UntilPredicates parameter; see until.ts for this repo's
 * instantiation and the concrete condition semantics.
 */

import { UsageError } from "./util.ts";

/** The CLI entry maps this to exit code 3. */
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

/** The two repo-specific judgments the checkers close over. */
export interface UntilPredicates<TEvent, TState> {
  isIdle(state: TState): boolean;
  isTurnEnd(event: TEvent): boolean;
}

export interface UntilCheckers<TEvent, TState> {
  /** Whether the condition already holds at the subscribe seed. `turn-end`
   *  is met at the seed only when idle: a pending queued message counts
   *  as a turn that must end. */
  untilMetAtSeed(condition: UntilCondition, seed: TState): boolean;
  /** Whether this event satisfies the condition; `state` is post-fold. */
  untilMetByEvent(
    condition: UntilCondition,
    event: TEvent,
    state: TState,
  ): boolean;
  /** Quiet-timer duration the stream driver must enforce for this condition;
   *  undefined for event-driven conditions. */
  untilQuietMs(condition: UntilCondition): number | undefined;
}

export function makeUntilCheckers<TEvent, TState>(
  predicates: UntilPredicates<TEvent, TState>,
): UntilCheckers<TEvent, TState> {
  return {
    untilMetAtSeed(condition: UntilCondition, seed: TState): boolean {
      switch (condition.kind) {
        case "turn-end":
        case "idle":
          return predicates.isIdle(seed);
        case "no-activity":
          return false;
      }
    },
    untilMetByEvent(
      condition: UntilCondition,
      event: TEvent,
      state: TState,
    ): boolean {
      switch (condition.kind) {
        case "turn-end":
          return predicates.isTurnEnd(event);
        case "idle":
          return predicates.isIdle(state);
        case "no-activity":
          return false;
      }
    },
    untilQuietMs(condition: UntilCondition): number | undefined {
      return condition.kind === "no-activity" ? condition.idleMs : undefined;
    },
  };
}
