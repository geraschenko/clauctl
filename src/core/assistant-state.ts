/**
 * The 4-state assistant-state model (spec: Phase 2, "Assistant-state fold").
 *
 * There is no `idle` SDKStatus; the daemon derives the assistant's state by
 * folding over the emitted event stream — so any observer holding a snapshot
 * can reconstruct it by running the same fold. `pending` means *predicted*
 * activity, not yet confirmed by SDK evidence: a dequeued turn that has not
 * shown output, or queued messages awaiting their boundary.
 *
 * At a `result`, the bucket the CLI consumes next is still in this fold's
 * queue (its `userMessageDequeued` follows the `result` on the stream), so
 * remaining work is counted, not guessed — the fold never passes through a
 * transient `idle` between a busy turn and a queued turn that runs next.
 * Invariant: `activity === "idle"` ⇒ no querying entries remain queued
 * (entries with `shouldQuery === false` may sit across idle — they run merged
 * into the next querying message).
 */

import type { SdkEvent } from "./sdk-socket.ts";

export type AssistantActivity = "idle" | "pending" | "working" | "compacting";

/** An accepted-but-not-yet-dequeued message, as the fold tracks it. */
export interface QueuedEntry {
  id: number;
  /** Normalized SDK field (`shouldQuery !== false`) — whether this message predicts a future result. */
  shouldQuery: boolean;
}

export interface AssistantState {
  activity: AssistantActivity;
  queued: QueuedEntry[];
}

export const INITIAL_ASSISTANT_STATE: AssistantState = {
  activity: "idle",
  queued: [],
};

/** Queued entries that predict a future `result` ("Q" in the spec). */
function queryingCount(state: AssistantState): number {
  return state.queued.filter((entry) => entry.shouldQuery).length;
}

/**
 * The invariant above makes the second clause redundant; the defensive
 * two-clause definition is kept in case the tracker's beliefs and the stream
 * ever disagree.
 */
export const isBusy = (state: AssistantState): boolean =>
  state.activity !== "idle" || queryingCount(state) > 0;

export function nextAssistantState(
  state: AssistantState,
  event: SdkEvent,
): AssistantState {
  switch (event.kind) {
    case "userMessageQueued": {
      const entry = {
        id: event.id,
        shouldQuery: event.message.shouldQuery !== false,
      };
      const queued = [...state.queued, entry];
      return entry.shouldQuery && state.activity === "idle"
        ? { activity: "pending", queued }
        : { ...state, queued };
    }
    // Activity is unchanged: a "turn" dequeue arrives after a `result` that
    // already set pending; "steer" and "append" have no activity of their own.
    case "userMessageDequeued":
      return {
        ...state,
        queued: state.queued.filter((entry) => !event.ids.includes(entry.id)),
      };
    case "compactSent":
      return { ...state, activity: "compacting" };
    // State is unchanged when the interrupt is *sent*; the transition happens
    // at the terminating `result` (its subtype alone does not flag the
    // interrupt — the daemon remembers it sent one).
    case "interruptSent":
    case "controlApplied":
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
        // The about-to-run bucket (if any) is still in `queued` — its dequeue
        // event follows this result — so pending-vs-idle is decided here.
        return {
          ...state,
          activity: queryingCount(state) > 0 ? "pending" : "idle",
        };
      }
      return state;
    }
  }
}
