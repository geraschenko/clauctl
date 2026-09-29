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
  | { kind: "state"; name: string }
  | { kind: "no-activity"; idleMs: number };

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

/** Repo-specific state conditions and turn-end judgment. */
export interface UntilPredicates<TEvent, TState> {
  /** `idle` is required: turn-end is met at the seed only when idle. */
  stateConditions: { idle(state: TState): boolean } & Record<
    string,
    (state: TState) => boolean
  >;
  isTurnEnd(event: TEvent): boolean;
}

export interface UntilCheckers<TEvent, TState> {
  /** Grammar and shell completions derived from the named state conditions. */
  usage: string;
  completions: readonly string[];
  /** Rejects unknown names with a UsageError naming this instance's grammar. */
  parse(value: string): UntilCondition;
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
  const { stateConditions } = predicates;
  const conditionNames = ["turn-end", ...Object.keys(stateConditions)];
  const usage = [...conditionNames, "no-activity:<secs>"].join("|");
  return {
    usage,
    completions: [...conditionNames, "no-activity:"],
    parse(value: string): UntilCondition {
      if (value === "turn-end") {
        return { kind: "turn-end" };
      }
      if (Object.hasOwn(stateConditions, value)) {
        return { kind: "state", name: value };
      }
      const noActivitySeconds = /^no-activity:(\d+(?:\.\d+)?)$/.exec(
        value,
      )?.[1];
      if (noActivitySeconds !== undefined) {
        return {
          kind: "no-activity",
          idleMs: secondsToTimerMs(Number(noActivitySeconds)),
        };
      }
      throw new UsageError(`--until must be ${usage} (got '${value}')`);
    },
    untilMetAtSeed(condition: UntilCondition, seed: TState): boolean {
      switch (condition.kind) {
        case "turn-end":
          return stateConditions.idle(seed);
        case "state":
          return stateConditions[condition.name]!(seed);
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
        case "state":
          return stateConditions[condition.name]!(state);
        case "no-activity":
          return false;
      }
    },
    untilQuietMs(condition: UntilCondition): number | undefined {
      return condition.kind === "no-activity" ? condition.idleMs : undefined;
    },
  };
}
