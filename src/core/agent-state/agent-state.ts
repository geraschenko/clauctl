/**
 * The observable state of an agent: a pure fold over the emitted AgentEvent
 * stream from a seed. The daemon maintains its state by running
 * `nextAgentState` over every event it emits, and a subscriber maintains its
 * own copy by seeding from the subscribe response and running the same fold
 * over the pushed stream — literally this code, so an observer's state always
 * matches the daemon's.
 *
 * Activity model: there is no `idle` SDKStatus; activity is derived by the
 * fold. `pending` means activity is *predicted*, not yet confirmed by SDK
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
 * emission), or the transcript at/before `leaf` (confirmed; a
 * history read covers it). Each transition is one fold step, so no state can
 * catch a prompt in two places or in none. An attaching observer therefore
 * renders each prompt exactly once: history replay up to the boundary, then
 * `deliveredMessages`, then `queuedMessages` in the pending area — everything
 * past the boundary arrives on the live stream. The transcript leg rests on a
 * CLI ordering assumption the fold cannot verify: a consumed prompt's
 * transcript entry is written at consumption and entries land in file-append
 * order, so any later uuid-carrying emission confirms every prompt delivered
 * before it. Background: docs/user-message-tracking.md.
 *
 * This file is the directory's only import surface (eslint
 * `no-restricted-imports`); the siblings are implementation.
 */

import type { UUID } from "node:crypto";
import type {
  EffortLevel,
  PermissionMode,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "../protocol.ts";
import { foldScanComplete } from "./fold-scan-complete.ts";
import { foldSdkMessage } from "./fold-sdk-message.ts";
import { foldSessionAppended } from "./fold-session-appended.ts";
import { foldSessionEntry } from "./fold-session-entry.ts";
import { foldSessionFileChanged } from "./fold-session-file-changed.ts";
import { foldUserMessageDequeued } from "./fold-user-message-dequeued.ts";
import { foldUserMessageQueued } from "./fold-user-message-queued.ts";
import { withObservedPermissionMode } from "./observed-permission-mode.ts";
import type { SessionState } from "./session-state.ts";
import type { TrackerAnomaly } from "./tracker-anomaly.ts";

export {
  classOf,
  excludedFromQuery,
  excludedFromSession,
} from "./classification.ts";
export {
  describeSession,
  isIdle,
  lastUsage,
  leaf,
  querySession,
  SETTLE_TIMEOUT_MS,
  sessionSettled,
  settled,
} from "./selectors.ts";
export {
  freshSessionState,
  type MergeStream,
  type SessionState,
} from "./session-state.ts";
export { toNonNullableUsage } from "./to-non-nullable-usage.ts";
export type { TrackerAnomaly } from "./tracker-anomaly.ts";

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
  /** Predictive: what the next query will use (seeded from settings, folded
   *  from init/set-model), as opposed to the per-session observed `model`. */
  readonly model?: string;
  /** Predictive, like `model`; observed only through the query stream. */
  readonly permissionMode?: PermissionMode;
  /** The reasoning effort the next query will use. Seeded by the daemon
   *  (spawn `--effort` flag, else resolved settings), folded from
   *  apply-flag-settings. */
  readonly effortLevel?: EffortLevel;
  /** The CLI version announced by the session's claude child. */
  readonly claudeCodeVersion?: string;
  /** Every mode observed this daemon lifetime, in first-observed order. */
  readonly observedPermissionModes: readonly PermissionMode[];
  readonly cwd?: string;
  /** Accepted, not yet consumed by the CLI. */
  readonly queuedMessages: readonly { id: number; message: SDKUserMessage }[];
  /** Consumed as turn/append, not yet confirmed by a later stream emission. */
  readonly deliveredMessages: readonly SDKUserMessage[];
  /** Plain record (it crosses the wire in `subscribe`). */
  readonly sessions: Readonly<Record<UUID, SessionState>>;
  /** The query file: the latest query message's `session_id`; undefined
   *  on a fresh spawn until the first `system/init`. */
  readonly querySessionId?: UUID;
  /** The tracked file; trails `querySessionId` until the switch;
   *  undefined until the first file exists. */
  readonly fileSessionId?: UUID;
  /** Set by the fold that detected it, absent on every other state:
   *  "the event just folded was anomalous". History lives in the log
   *  and the bundles. */
  readonly anomaly?: TrackerAnomaly;
}

/** Per-agent fields only, no file: `sessions` is empty and both session ids
 *  undefined. The seed file, when it exists, enters through the
 *  `sessionFileChanged` that `TrackedSessionLog.start` emits. daemon.ts
 *  spreads the settings cascade (`model`, `permissionMode`, `effortLevel`,
 *  `cwd`) over it. */
export function initialAgentState(): AgentState {
  return {
    activity: "idle",
    observedPermissionModes: [],
    queuedMessages: [],
    deliveredMessages: [],
    sessions: {},
  };
}

/** `anomaly` describes the event just folded, so every fold starts from
 *  a state without one. */
export function nextAgentState(
  state: AgentState,
  event: AgentEvent,
): AgentState {
  if (state.anomaly === undefined) return foldEvent(state, event);
  const { anomaly: _anomaly, ...cleared } = state;
  return foldEvent(cleared, event);
}

function foldEvent(state: AgentState, event: AgentEvent): AgentState {
  switch (event.kind) {
    case "userMessageQueued":
      return foldUserMessageQueued(state, event.id, event.message);
    case "userMessageDequeued":
      return foldUserMessageDequeued(state, event);
    case "compactSent":
      return { ...state, activity: "compacting" };
    // State is unchanged when the interrupt is *sent*; the transition happens
    // at the terminating `result` (its subtype alone does not flag the
    // interrupt — the interruptSent event on the stream is the record).
    case "interruptSent":
      return state;
    // The daemon's farewell: everything it implies (the process is going
    // away) is outside the observable agent state, so the fold passes it
    // through — consumers react to the event itself, not to a state change.
    case "shutdown":
      return state;
    case "sessionEntry":
      return foldSessionEntry(state, event);
    case "sessionFileChanged":
      return foldSessionFileChanged(state, event.sessionId);
    case "scanComplete":
      return foldScanComplete(state);
    case "sessionAppended":
      return foldSessionAppended(state, event.uuids);
    case "trackerAnomaly":
      return { ...state, anomaly: event.anomaly };
    // The tip it announces is already folded from the sessionEntry that
    // completed the boundary (SessionState.treeLeaf).
    case "contextChanged":
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
      if (request.type === "apply-flag-settings") {
        const effortLevel = request.settings.effortLevel;
        if (effortLevel === undefined) {
          return state;
        }
        if (effortLevel === null) {
          // The daemon resolves a flag-tier clear to a concrete level before
          // emitting (SdkControlApplied); null survives only when neither
          // the spawn --effort flag nor the settings cascade specifies one,
          // so the next query uses the CLI's model-dependent default —
          // unknown here, tracked as unset.
          const { effortLevel: _effortLevel, ...withoutEffort } = state;
          return withoutEffort;
        }
        return { ...state, effortLevel };
      }
      return state;
    }
    case "sdkMessage":
      return foldSdkMessage(state, event.message);
  }
}
