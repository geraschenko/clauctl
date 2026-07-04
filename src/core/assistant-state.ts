/**
 * The 4-state assistant-state model (spec: Phase 1, "Assistant state").
 *
 * There is no `idle` SDKStatus; the daemon derives the assistant's state.
 * `activity` and `queueDepth` are independent and must not be conflated:
 * `activity` is SDK evidence, `queueDepth` is our own echo bookkeeping (the
 * SDK never echoes user turns back).
 *
 * `queueDepth` counts every accepted-but-not-completed runnable unit —
 * including the one currently in flight and a pending compaction. That is the
 * only reading under which the spec's `result` rule (decrement, then Pending
 * iff queueDepth > 0) predicts a surviving queued turn correctly, and it
 * yields the invariant `activity === 'idle' ⇒ queueDepth === 0`.
 */

import type { SdkEvent } from "./sdk-socket.ts";

export type AssistantActivity = "idle" | "pending" | "working" | "compacting";

export interface AssistantState {
  activity: AssistantActivity;
  queueDepth: number;
}

export const INITIAL_ASSISTANT_STATE: AssistantState = {
  activity: "idle",
  queueDepth: 0,
};

/**
 * The invariant above makes the second clause redundant; the defensive
 * two-clause definition is kept in case the tracker's beliefs and the stream
 * ever disagree.
 */
export const isBusy = (state: AssistantState): boolean =>
  state.activity !== "idle" || state.queueDepth > 0;

export function nextAssistantState(
  state: AssistantState,
  event: SdkEvent,
): AssistantState {
  switch (event.kind) {
    case "turnAccepted": {
      if (state.activity === "idle") {
        return { activity: "pending", queueDepth: state.queueDepth + 1 };
      }
      // While busy, only `now` and a queued `later` will run as their own
      // turn; a default/`next` is demoted by the CLI to an in-turn
      // `<system-reminder>` steer with no `result` of its own, so counting it
      // would leak queueDepth (echo-placement FINDINGS, Round 3 + "Silent
      // demotions leak queue depth").
      //
      // A `now` does NOT clear the queue: it aborts the in-flight inference
      // (whose terminating `result` still arrives, decrementing) and runs as
      // its own turn, while queued `later`s survive and run after — FINDINGS
      // `c_perm`: [CHARLIE:next, ALPHA:later, BRAVO:now] executed
      // BRAVO → CHARLIE → ALPHA.
      if (event.priority === "now" || event.priority === "later") {
        return { ...state, queueDepth: state.queueDepth + 1 };
      }
      return state;
    }
    case "compactSent":
      return { activity: "compacting", queueDepth: state.queueDepth + 1 };
    // State is unchanged when the interrupt is *sent*; the transition happens
    // at the terminating `result` (its subtype alone does not flag the
    // interrupt — the daemon remembers it sent one).
    case "interruptSent":
      return state;
    case "sdkMessage": {
      const message = event.message;
      // Top-level assistant output confirms the turn started. Compacting is
      // exited by the subsequent `result`, not by assistant output or the
      // compact-boundary message (which arrives when compaction *finishes*).
      if (message.type === "assistant" && state.activity !== "compacting") {
        return { ...state, activity: "working" };
      }
      if (message.type === "result") {
        const queueDepth = Math.max(0, state.queueDepth - 1);
        return queueDepth > 0
          ? // A surviving queued turn is predicted to run next, but the SDK
            // has not confirmed it started.
            { activity: "pending", queueDepth }
          : { activity: "idle", queueDepth };
      }
      return state;
    }
  }
}
