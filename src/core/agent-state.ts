/**
 * The observable state of an agent: a pure fold over the emitted SdkEvent
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
 * emission), or the transcript at/before `leafTreeNodeRef` (confirmed; a
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

import type { UUID } from "node:crypto";
import type {
  EffortLevel,
  NonNullableUsage,
  PermissionMode,
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SdkEvent } from "./sdk-socket.ts";
import type { TreeNodeRef } from "./tree.ts";

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
  /** API usage of the last assistant message (per-message, not cumulative);
   *  its token counters approximate the current context size. */
  readonly lastUsage?: NonNullableUsage;
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
  /** The attach boundary: the current leaf occurrence of the session tree.
   *  Stream user/assistant messages fold it as a raw ref; a contextChanged
   *  event folds its post-change `leaf` (possibly a viaBoundary occurrence,
   *  null unsets). */
  readonly leafTreeNodeRef?: TreeNodeRef;
}

export const INITIAL_AGENT_STATE: AgentState = {
  activity: "idle",
  observedPermissionModes: [],
  queuedMessages: [],
  deliveredMessages: [],
};

/**
 * The API's usage object with nulls removed, as NonNullableUsage promises:
 * the numeric token counters are defaulted to 0 (arithmetic over them never
 * sees a hole); other null fields are dropped rather than given made-up
 * non-null values. Also used to coerce usage objects read back from session
 * file entries (effective-chain.ts seedFromEntries).
 */
export function toNonNullableUsage(
  usage: SDKAssistantMessage["message"]["usage"],
): NonNullableUsage {
  return {
    ...Object.fromEntries(
      Object.entries(usage).filter(([, value]) => value !== null),
    ),
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  } as NonNullableUsage;
}

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
      // Gated on activity, not !isBusy: idle is the only activity a queued
      // message changes, and if the activity invariant were ever violated
      // (idle with querying messages queued), setting pending repairs it
      // where an isBusy gate would preserve the corruption.
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
    // The effective context lives in the session file; the fold tracks only
    // its tip, which the event carries.
    case "contextChanged": {
      if (event.leaf === null) {
        const { leafTreeNodeRef: _leafTreeNodeRef, ...withoutLeaf } = state;
        return withoutLeaf;
      }
      return { ...state, leafTreeNodeRef: event.leaf };
    }
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
        next = { ...next, leafTreeNodeRef: { uuid: message.uuid as UUID } };
        if (next.deliveredMessages.length > 0) {
          next = { ...next, deliveredMessages: [] };
        }
      }
      if (message.type === "conversation_reset") {
        // SDK 0.3.211 emits this before the new conversation's init. Despite
        // its name, new_conversation_id is not the transcript session_id
        // announced by that init (verified live), so clear session identity
        // until the authoritative init while discarding old-context evidence.
        // Queued future turns still belong to the running process.
        const {
          sessionId: _sessionId,
          leafTreeNodeRef: _leafTreeNodeRef,
          lastUsage: _lastUsage,
          ...withoutOldContext
        } = next;
        return { ...withoutOldContext, deliveredMessages: [] };
      }
      if (message.type === "system" && message.subtype === "init") {
        // The leaf must belong to the announced session's file: history reads
        // gate on the leaf uuid appearing in that file, and a resumed session
        // can fork — init then announces a new id whose file never contains
        // the leaf seeded from the resumed file. Drop the leaf on an id
        // change; stream messages repopulate it. (conversation_reset enforces
        // the same coupling by clearing both.)
        if (
          next.leafTreeNodeRef !== undefined &&
          next.sessionId !== message.session_id
        ) {
          const { leafTreeNodeRef: _leafTreeNodeRef, ...withoutLeaf } = next;
          next = withoutLeaf;
        }
        return withObservedPermissionMode(
          {
            ...next,
            sessionId: message.session_id,
            model: message.model,
            cwd: message.cwd,
            claudeCodeVersion: message.claude_code_version,
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
      if (message.type === "assistant") {
        next = {
          ...next,
          lastUsage: toNonNullableUsage(message.message.usage),
        };
        // Top-level assistant output confirms the turn started. Compacting is
        // exited by the subsequent `result`, not by assistant output or the
        // compact-boundary message (which arrives when compaction *finishes*).
        if (next.activity !== "compacting") {
          return { ...next, activity: "working" };
        }
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
