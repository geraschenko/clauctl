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
 * Prompt-visibility invariant: every accepted prompt appears in exactly
 * one place — `queuedMessages` (accepted, not yet consumed by the CLI),
 * pending on `query` in the query session's merge (its dequeue observed
 * under its stamped uuid, its file entry not yet), or resolved into the
 * file (a history read covers it). The daemon stamps each prompt's uuid
 * before delivery and the CLI files the entry under it (a merged run under
 * its last member's, a steer as a `queued_command` attachment naming it as
 * `source_uuid`), so the dequeue and the entry meet in the merge like any
 * other twin. Each transition is one fold step, so no state can catch a
 * prompt in two places or in none. Background: docs/user-message-tracking.md.
 */

import type { UUID } from "node:crypto";
import type { AgentEvent, AgentState } from "../protocol/index.ts";
import { foldSdkMessage } from "./fold-sdk-message.ts";
import {
  foldSessionEntry,
  withScanExclusionEnded,
} from "./fold-session-entry.ts";
import { observeEvent } from "./observe-event/index.ts";
import { withObservedPermissionMode } from "./observed-permission-mode.ts";
import { withPendingLeaf } from "./query-message.ts";
import { withQuerySessionAnnounced } from "./with-query-session-announced.ts";
import { withQueueDrained } from "./with-queue-drained.ts";
import { withQueuedMessage } from "./with-queued-message.ts";
import { withScanEnded } from "./with-scan-ended.ts";
import { withTrackedFile } from "./with-tracked-file.ts";

/** Per-agent fields only, no session: `sessions` is empty and both session
 *  ids undefined. The query session enters through the hub's
 *  `querySessionChanged`, the seed file, when it exists, through the
 *  `sessionFileChanged` that `TrackedSessionLog.start` emits. daemon.ts
 *  spreads the settings cascade (`model`, `permissionMode`, `effortLevel`,
 *  `cwd`) over it. */
export function initialAgentState(): AgentState {
  return {
    activity: "idle",
    observedPermissionModes: [],
    queuedMessages: [],
    sessions: {},
  };
}

/** `anomaly` and every session's `resolved` describe the event just
 *  folded, so every fold starts from a state without them. */
export function nextAgentState(
  state: AgentState,
  event: AgentEvent,
): AgentState {
  return foldEvent(clearedForFold(state), event);
}

/** Identity when there is nothing to clear: pass-through folds return
 *  their input, and callers rely on that reference equality. */
function clearedForFold(state: AgentState): AgentState {
  const sessionsToClear = Object.entries(state.sessions).filter(
    ([, session]) => session.resolved.length > 0,
  );
  if (state.anomaly === undefined && sessionsToClear.length === 0) {
    return state;
  }
  const { anomaly: _anomaly, ...cleared } = state;
  const sessions = { ...state.sessions };
  for (const [sessionId, session] of sessionsToClear) {
    sessions[sessionId as UUID] = { ...session, resolved: [] };
  }
  return { ...cleared, sessions };
}

/** Every event is observed here, by `observeEvent` (observe-event/), the
 *  only path to a session's merge. A kind's own effects are `with<Effect>`
 *  helpers before the observation and `fold<Kind>` helpers after it; the
 *  kinds with no other effect are pure observations. `shutdown` is a
 *  stamped query node of every session: what it implies beyond that (the
 *  process is going away) is outside the observable agent state. */
function foldEvent(state: AgentState, event: AgentEvent): AgentState {
  switch (event.kind) {
    case "userMessageQueued":
      return observeEvent(
        withQueuedMessage(state, event.message.uuid as UUID, event.message),
        event,
      );
    case "userMessageDequeued":
      return observeEvent(withQueueDrained(state, event), event);
    case "compactSent":
      return observeEvent({ ...state, activity: "compacting" }, event);
    // Activity is unchanged when the interrupt is *sent*; the transition
    // happens at the terminating `result` (its subtype alone does not flag
    // the interrupt — the interruptSent event on the stream is the record).
    case "interruptSent":
    case "shutdown":
    case "sessionAppended":
      return observeEvent(state, event);
    case "sessionEntry":
      return foldSessionEntry(
        observeEvent(withScanExclusionEnded(state, event), event),
        event,
      );
    case "querySessionChanged":
      return observeEvent(withQuerySessionAnnounced(state, event), event);
    case "sessionFileChanged":
      return observeEvent(withTrackedFile(state, event), event);
    case "scanComplete":
      return observeEvent(withScanEnded(state), event);
    // The daemon's report of an anomaly already detected (by a fold or the
    // tracker): `anomaly` stays clear even when the report's own node
    // cannot be merged (its stream has no session yet), so the field means
    // "this fold detected one" and the hub reports each anomaly exactly
    // once instead of reporting its own report.
    case "trackerAnomaly": {
      const { anomaly: _anomaly, ...observed } = observeEvent(state, event);
      return observed;
    }
    // The tip it announces is already folded from the sessionEntry that
    // completed the boundary (SessionState.treeLeaf).
    case "contextChanged":
      return observeEvent(state, event);
    case "controlApplied":
      return observeEvent(withControlApplied(state, event), event);
    case "sdkMessage":
      return foldSdkMessage(
        observeEvent(withPendingLeaf(state, event), event),
        event,
      );
  }
}

function withControlApplied(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "controlApplied" }>,
): AgentState {
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
