/**
 * The observable state of an agent: a pure fold over the emitted SdkEvent
 * stream from a seed. The daemon maintains its state by running
 * `nextAgentState` over every event it emits, and a subscriber maintains its
 * own copy by seeding from the subscribe response and running the same fold
 * over the pushed stream — literally this code, so an observer's state always
 * matches the daemon's. (Two hand-rolled trackers — the daemon's and the
 * tui's — had already diverged in structure before this module unified them.)
 *
 * Activity model: there is no `idle` SDKStatus; activity is derived by the
 * fold. `pending` means *predicted* activity, not yet confirmed by SDK
 * evidence: a dequeued turn that has not shown output, or queued messages
 * awaiting their boundary. At a `result`, the bucket the CLI consumes next is
 * still in `queuedMessages` (its `userMessageDequeued` follows the `result`
 * on the stream), so remaining work is counted, not guessed — the fold never
 * passes through a transient `idle` between a busy turn and a queued turn
 * that runs next. Invariant: `activity === "idle"` ⇒ no querying messages
 * remain queued (messages with `shouldQuery === false` may sit across idle —
 * they run merged into the next querying message).
 *
 * Prompt-visibility invariant: every accepted turn/append prompt appears in
 * exactly one place — `queuedMessages` (accepted, not yet consumed by the
 * CLI), `deliveredMessages` (consumed, not yet confirmed by a later stream
 * emission), or the transcript at/before `lastTranscriptUuid` (confirmed; a
 * history read covers it). Each transition is one fold step, so no state can
 * catch a prompt in two places or in none. An attaching observer therefore
 * renders each prompt exactly once: history replay up to the boundary, then
 * `deliveredMessages`, then `queuedMessages` in the pending area — everything
 * past the boundary arrives on the live stream. The transcript leg rests on a
 * CLI ordering assumption the fold cannot verify: a consumed prompt's
 * transcript entry is written at consumption and entries land in file-append
 * order, so any later uuid-carrying emission confirms every prompt delivered
 * before it. Background: docs/user-message-tracking.md.
 */

import type {
  PermissionMode,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SdkEvent } from "./sdk-socket.ts";

export type AgentActivity = "idle" | "pending" | "working" | "compacting";

/**
 * A wire type: the subscribe response is a serialized AgentState, so
 * daemon-side and client-side values are the same kind of thing (which is why
 * `nextAgentState` is a free function, not a method). Readonly is shallow:
 * the fold never mutates its input; nested SDK payloads are treated as
 * immutable by convention. Excluded by design: rendering state, queue-model
 * inference state (daemon-internal), the persisted AgentRecord, and tty
 * attachment state. Arrays are always present (empty, not absent); optional
 * scalars mean "not yet observed".
 */
export interface AgentState {
  readonly activity: AgentActivity;
  readonly sessionId?: string;
  readonly model?: string;
  readonly permissionMode?: PermissionMode;
  /** Every mode observed this daemon lifetime, in first-observed order. */
  readonly observedPermissionModes: readonly PermissionMode[];
  readonly cwd?: string;
  /** Accepted, not yet consumed by the CLI. */
  readonly queuedMessages: readonly { id: number; message: SDKUserMessage }[];
  /** Consumed as turn/append, not yet confirmed by a later stream emission. */
  readonly deliveredMessages: readonly SDKUserMessage[];
  /** The attach boundary: uuid of the last user/assistant message emitted. */
  readonly lastTranscriptUuid?: string;
}

export const INITIAL_AGENT_STATE: AgentState = {
  activity: "idle",
  observedPermissionModes: [],
  queuedMessages: [],
  deliveredMessages: [],
};

/** `shouldQuery !== false` — whether this message predicts a future result. */
function isQuerying(message: SDKUserMessage): boolean {
  return message.shouldQuery !== false;
}

/** Queued messages that predict a future `result` ("Q" in the spec). */
function queryingCount(state: AgentState): number {
  return state.queuedMessages.filter((entry) => isQuerying(entry.message))
    .length;
}

/**
 * The activity invariant above makes the second clause redundant; the
 * defensive two-clause definition is kept in case the fold's beliefs and the
 * stream ever disagree.
 */
export const isBusy = (state: AgentState): boolean =>
  state.activity !== "idle" || queryingCount(state) > 0;

function withObservedPermissionMode(
  state: AgentState,
  mode: PermissionMode,
): AgentState {
  return {
    ...state,
    permissionMode: mode,
    observedPermissionModes: state.observedPermissionModes.includes(mode)
      ? state.observedPermissionModes
      : [...state.observedPermissionModes, mode],
  };
}

export function nextAgentState(state: AgentState, event: SdkEvent): AgentState {
  switch (event.kind) {
    case "userMessageQueued": {
      const queuedMessages = [
        ...state.queuedMessages,
        { id: event.id, message: event.message },
      ];
      return isQuerying(event.message) && state.activity === "idle"
        ? { ...state, activity: "pending", queuedMessages }
        : { ...state, queuedMessages };
    }
    // Activity is unchanged: a "turn" dequeue arrives after a `result` that
    // already set pending; "steer" and "append" have no activity of their own.
    case "userMessageDequeued": {
      const queuedMessages = state.queuedMessages.filter(
        (entry) => !event.ids.includes(entry.id),
      );
      if (event.delivery === "steer") {
        // Steered messages must not enter deliveredMessages: a steered
        // message's only transcript record is a queued_command attachment,
        // which getSessionMessages never returns, so no history read could
        // take over from the hold.
        return { ...state, queuedMessages };
      }
      const byId = new Map(
        state.queuedMessages.map((entry) => [entry.id, entry.message]),
      );
      const delivered = event.ids
        .map((id) => byId.get(id))
        .filter((message) => message !== undefined);
      return {
        ...state,
        queuedMessages,
        deliveredMessages: [...state.deliveredMessages, ...delivered],
      };
    }
    case "compactSent":
      return { ...state, activity: "compacting" };
    // State is unchanged when the interrupt is *sent*; the transition happens
    // at the terminating `result` (its subtype alone does not flag the
    // interrupt — the interruptSent event on the stream is the record).
    case "interruptSent":
      return state;
    case "controlApplied": {
      const request = event.request;
      if (request.type === "set-model") {
        // undefined model → the SDK's default; tracked as unset.
        return { ...state, model: request.model };
      }
      if (request.type === "set-permission-mode") {
        return withObservedPermissionMode(state, request.mode);
      }
      return state;
    }
    case "sdkMessage": {
      const message = event.message;
      let next = state;
      if (
        (message.type === "user" || message.type === "assistant") &&
        message.uuid !== undefined
      ) {
        // The uuid guard is for the type only: stream user/assistant messages
        // always carry the transcript uuid (verified in the CLI binary; the
        // optional uuid on SDKUserMessage is for host-pushed input). Boundary
        // advance and deliveredMessages clear happen in the same fold step —
        // that is the prompt-visibility bookkeeping (header comment).
        next = { ...next, lastTranscriptUuid: message.uuid };
        if (next.deliveredMessages.length > 0) {
          next = { ...next, deliveredMessages: [] };
        }
      }
      if (message.type === "system" && message.subtype === "init") {
        return withObservedPermissionMode(
          {
            ...next,
            sessionId: message.session_id,
            model: message.model,
            cwd: message.cwd,
          },
          message.permissionMode,
        );
      }
      if (
        message.type === "system" &&
        message.subtype === "status" &&
        message.permissionMode !== undefined
      ) {
        // Mode changes not initiated over sdk.sock (e.g. plan-mode
        // transitions).
        return withObservedPermissionMode(next, message.permissionMode);
      }
      // Top-level assistant output confirms the turn started. Compacting is
      // exited by the subsequent `result`, not by assistant output or the
      // compact-boundary message (which arrives when compaction *finishes*).
      if (message.type === "assistant" && next.activity !== "compacting") {
        return { ...next, activity: "working" };
      }
      if (message.type === "result") {
        // The about-to-run bucket (if any) is still in queuedMessages — its
        // dequeue event follows this result — so pending-vs-idle is decided
        // here.
        return {
          ...next,
          activity: queryingCount(next) > 0 ? "pending" : "idle",
        };
      }
      return next;
    }
  }
}
