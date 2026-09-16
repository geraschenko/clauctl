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
 */

import type { UUID } from "node:crypto";
import type {
  EffortLevel,
  NonNullableUsage,
  PermissionMode,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Result } from "neverthrow";
import type { AgentEvent } from "./protocol.ts";
import type { SessionEntry } from "./session/file.ts";
import {
  createMerge,
  excludeFrom,
  hasPending,
  type MergeError,
  type MergeState,
  type MergeStep,
  observe,
  pending,
  type Resolved,
} from "./stream-merge.ts";
import { isToolResultEntry } from "./tree/loader.ts";
import type { TreeNodeRef } from "./tree/nodes.ts";

export type AgentActivity = "idle" | "pending" | "working" | "compacting";

export type MergeStream = "query" | "session";

export interface TrackerAnomaly {
  readonly kind:
    | "merge-error"
    | "head-mismatch"
    | "classification"
    | "awaiting-anchor"
    | "malformed-line"
    | "follower-failure";
  /** Names the ids, streams and classes involved, the boundary (anchor),
   *  the line's byte range (malformed), or the error (follower). */
  readonly detail: string;
}

/** The fold's view of one session: the merge of its query stream and its
 *  file, and what has been observed on it. Fields that mirror a top-level
 *  `AgentState` field (`model`) are observed evidence; the top-level one is
 *  the prediction for the next query. */
export interface SessionState {
  readonly merge: MergeState<UUID, MergeStream>;
  /** The context tree's leaf, folded from sessionEntry.leaf; null before
   *  any entry and after a wipe. */
  readonly treeLeaf: TreeNodeRef | null;
  /** The last leaf-eligible query observation still pending on `query`;
   *  null once the log has it. */
  readonly pendingLeaf: UUID | null;
  /** Boundaries whose preserved blocks are deferred behind anchors not
   *  yet in the log; the session tracker is incomplete while non-empty. */
  readonly awaitingAnchors: readonly UUID[];
  /** Usage/model observed on the last assistant message of the context
   *  (from the query stream while unsettled, from the file once settled). */
  readonly lastUsage?: NonNullableUsage;
  readonly model?: string;
  /** While true, session observations are excluded from `query`: the
   *  scan has not yet met an id the query stream reported. */
  readonly scanExcluded: boolean;
}

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

export const querySession = (state: AgentState): SessionState | undefined =>
  state.querySessionId === undefined
    ? undefined
    : state.sessions[state.querySessionId];

/** The query-side leaf of the query file (merge model, Leaf); null
 *  without a file. */
export const leaf = (state: AgentState): TreeNodeRef | null => {
  const file = querySession(state);
  if (file === undefined) {
    return null;
  }
  return file.pendingLeaf === null ? file.treeLeaf : { uuid: file.pendingLeaf };
};

/** Usage of the last assistant message on the query file's context (its
 *  token counters approximate the current context size). */
export const lastUsage = (state: AgentState): NonNullableUsage | undefined =>
  querySession(state)?.lastUsage;

export const sessionSettled = (file: SessionState): boolean =>
  !hasPending(file.merge, "query") && file.awaitingAnchors.length === 0;

/** "The file has caught up to the query"; vacuously true before the
 *  query has a file (nothing has happened that could be pending). */
export const settled = (state: AgentState): boolean => {
  const file = querySession(state);
  return file === undefined || sessionSettled(file);
};

/** Bound on any wait for settledness (the daemon's whenSettled, a client's
 *  `--until` completion): the log has had this long to catch up with the
 *  query stream. */
export const SETTLE_TIMEOUT_MS = 10_000;

/** What a file is still waiting on, for settle-timeout diagnostics. */
export const describeSession = (session: SessionState | undefined): string =>
  session === undefined
    ? "no such file"
    : `pending on query: [${pending(session.merge, "query").join(", ")}]; awaiting anchors: [${session.awaitingAnchors.join(", ")}]`;

const MERGE_STREAMS: readonly MergeStream[] = ["query", "session"];

const EMPTY_MERGE: MergeState<UUID, MergeStream> = createMerge<
  UUID,
  MergeStream
>(MERGE_STREAMS).match(
  (merge) => merge,
  (error) => {
    throw new Error(error.message);
  },
);

/** A file the fold has not seen a log entry of yet: the scan exclusion
 *  holds until a session observation meets a query-reported id. */
export function freshSessionState(): SessionState {
  return {
    merge: EMPTY_MERGE,
    treeLeaf: null,
    pendingLeaf: null,
    awaitingAnchors: [],
    scanExcluded: true,
  };
}

const otherStream = (stream: MergeStream): MergeStream =>
  stream === "query" ? "session" : "query";

/** `type/subtype` of a query message or log entry, for anomaly details
 *  and event annotations. */
export function classOf(item: { type?: string; subtype?: string }): string {
  return item.subtype === undefined
    ? (item.type ?? "?")
    : `${item.type}/${item.subtype}`;
}

interface Observation {
  readonly session: SessionState;
  readonly anomalies: readonly TrackerAnomaly[];
}

/** One merge observation on `file`. `excludeOther` is the caller's
 *  classification of a FIRST observation (an existing node is evidence
 *  the other stream carries the id); a failing merge call leaves the
 *  merge as it was and is reported. Resolutions clear `pendingLeaf`; a
 *  resolved node a stream skipped is a head-mismatch. */
function observeOn(
  session: SessionState,
  stream: MergeStream,
  uuid: UUID,
  className: string,
  excludeOther: boolean,
): Observation {
  const anomalies: TrackerAnomaly[] = [];
  const resolved: Resolved<UUID, MergeStream>[] = [];
  let merge = session.merge;
  const apply = (
    result: Result<MergeStep<UUID, MergeStream>, MergeError>,
  ): void =>
    result.match(
      (step) => {
        merge = step.state;
        resolved.push(...step.resolved);
      },
      (error) => {
        anomalies.push({
          kind:
            error.kind === "excluded-observed"
              ? "classification"
              : "merge-error",
          detail: `${className} ${uuid} on ${stream}: ${error.message}`,
        });
      },
    );
  if (excludeOther) apply(excludeFrom(merge, [otherStream(stream)], uuid));
  apply(observe(merge, stream, uuid));
  const skipped = resolved.flatMap((node) => {
    const missing = MERGE_STREAMS.filter(
      (name) =>
        !node.seenOn.includes(name) && !node.excludedFrom.includes(name),
    );
    return missing.length === 0
      ? []
      : [
          `${node.id} seen on ${node.seenOn.join(",")}, skipped by ${missing.join(",")}`,
        ];
  });
  if (skipped.length > 0) {
    anomalies.push({ kind: "head-mismatch", detail: skipped.join("; ") });
  }
  const pendingLeaf = resolved.some((node) => node.id === session.pendingLeaf)
    ? null
    : session.pendingLeaf;
  return { session: { ...session, merge, pendingLeaf }, anomalies };
}

const ANOMALY_PRECEDENCE: readonly TrackerAnomaly["kind"][] = [
  "merge-error",
  "classification",
  "head-mismatch",
];

/** At most one anomaly per fold: the kind by precedence, the detail
 *  naming every condition that fired. */
function withAnomalies(
  state: AgentState,
  anomalies: readonly TrackerAnomaly[],
): AgentState {
  if (anomalies.length === 0) return state;
  const kind =
    ANOMALY_PRECEDENCE.find((candidate) =>
      anomalies.some((anomaly) => anomaly.kind === candidate),
    ) ?? anomalies[0]!.kind;
  const detail = anomalies
    .map((anomaly) => `${anomaly.kind}: ${anomaly.detail}`)
    .join("; ");
  return { ...state, anomaly: { kind, detail } };
}

function withSession(
  state: AgentState,
  sessionId: UUID,
  session: SessionState,
): AgentState {
  return { ...state, sessions: { ...state.sessions, [sessionId]: session } };
}

function withoutFile(
  state: AgentState,
  sessionId: UUID | undefined,
): AgentState {
  if (sessionId === undefined || !(sessionId in state.sessions)) return state;
  const { [sessionId]: _dropped, ...sessions } = state.sessions;
  return { ...state, sessions };
}

/** A leaf-eligible query message: the file entry it becomes is a tree
 *  row (user/assistant with a uuid; subagent traffic is filtered before
 *  the fold reaches here). */
function isLeafEligible(message: SDKMessage): boolean {
  return (
    (message.type === "user" || message.type === "assistant") &&
    message.uuid !== undefined
  );
}

/** A query message's merge rule on its `session_id` file (spec, Fold rules,
 *  sdkMessage): observe on `query`, first observations excluded from
 *  `session` per the classification; per-file usage/model evidence. */
function foldQueryMessage(state: AgentState, message: SDKMessage): AgentState {
  const sessionId = message.session_id as UUID;
  let session = state.sessions[sessionId] ?? freshSessionState();
  let anomalies: readonly TrackerAnomaly[] = [];
  if (message.uuid !== undefined) {
    const uuid = message.uuid as UUID;
    if (isLeafEligible(message)) session = { ...session, pendingLeaf: uuid };
    const first = !Object.hasOwn(session.merge.nodes, uuid);
    ({ session, anomalies } = observeOn(
      session,
      "query",
      uuid,
      classOf(message),
      first && excludedFromSession(message),
    ));
  }
  if (message.type === "assistant") {
    session = {
      ...session,
      lastUsage: toNonNullableUsage(message.message.usage),
      model: message.message.model,
    };
  }
  if (message.type === "system" && message.subtype === "compact_boundary") {
    session = withPostTokens(session, message.compact_metadata.post_tokens);
  }
  return withAnomalies(
    withSession({ ...state, querySessionId: sessionId }, sessionId, session),
    anomalies,
  );
}

/** post_tokens is the compacted context size; represented as a pure
 *  input_tokens usage so consumers summing the input-side counters
 *  (footer, set-context's preTokensOf) read back exactly post_tokens.
 *  Without it the old lastUsage describes the superseded context, so it
 *  is dropped rather than kept wrong. */
function withPostTokens(
  session: SessionState,
  postTokens: number | undefined,
): SessionState {
  if (postTokens === undefined) {
    const { lastUsage: _lastUsage, ...withoutUsage } = session;
    return withoutUsage;
  }
  return {
    ...session,
    lastUsage: {
      input_tokens: postTokens,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as NonNullableUsage,
  };
}

/** A log entry's merge rule on the tracked file (spec, Fold rules,
 *  sessionEntry): observe on `session`, first observations excluded from
 *  `query` when the tracker's classification or the scan exclusion says so;
 *  the log's leaf and anchors always, its usage/model/version only once the
 *  file is settled (the query side leads while it is not). */
function foldSessionEntry(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sessionEntry" }>,
): AgentState {
  const sessionId = state.fileSessionId;
  if (sessionId === undefined) return state;
  let session = state.sessions[sessionId] ?? freshSessionState();
  let anomalies: readonly TrackerAnomaly[] = [];
  const uuid = event.entry.uuid;
  if (uuid !== undefined) {
    const first = !Object.hasOwn(session.merge.nodes, uuid);
    if (!first && session.scanExcluded)
      session = { ...session, scanExcluded: false };
    ({ session, anomalies } = observeOn(
      session,
      "session",
      uuid,
      classOf(event.entry),
      first && (!event.expectsSdkMessage || session.scanExcluded),
    ));
  }
  session = {
    ...session,
    treeLeaf: event.leaf,
    awaitingAnchors: event.awaitingAnchors,
  };
  let next = state;
  if (sessionSettled(session)) {
    const { lastUsage: _lastUsage, model: _model, ...evidenceless } = session;
    const usage = event.lastAssistant?.usage;
    const model = event.lastAssistant?.model;
    session = {
      ...evidenceless,
      ...(usage !== undefined && { lastUsage: usage }),
      ...(model !== undefined && { model }),
    };
    if (typeof event.entry.version === "string") {
      next = { ...next, claudeCodeVersion: event.entry.version };
    }
  }
  return withAnomalies(withSession(next, sessionId, session), anomalies);
}

/** The follower moved: the old file's state is dropped, unless the move
 *  is a rescan of the same file, which keeps what the query side still
 *  knows (its pending observations with their exclusions, the leaf and
 *  usage evidence) and forgets everything the log told us. */
function foldSessionFileChanged(
  state: AgentState,
  sessionId: UUID,
): AgentState {
  const old =
    state.fileSessionId === undefined
      ? undefined
      : state.sessions[state.fileSessionId];
  const dropped = withoutFile(state, state.fileSessionId);
  if (old === undefined || sessionId !== state.fileSessionId) {
    return {
      ...withSession(
        dropped,
        sessionId,
        dropped.sessions[sessionId] ?? freshSessionState(),
      ),
      fileSessionId: sessionId,
    };
  }
  let session: SessionState = {
    ...freshSessionState(),
    pendingLeaf: old.pendingLeaf,
    ...(old.lastUsage !== undefined && { lastUsage: old.lastUsage }),
    ...(old.model !== undefined && { model: old.model }),
  };
  const anomalies: TrackerAnomaly[] = [];
  for (const uuid of pending(old.merge, "query")) {
    const observation = observeOn(
      session,
      "query",
      uuid,
      "rescan",
      old.merge.nodes[uuid]?.excludedFrom.includes("session") === true,
    );
    session = observation.session;
    anomalies.push(...observation.anomalies);
  }
  return withAnomalies(
    { ...withSession(dropped, sessionId, session), fileSessionId: sessionId },
    anomalies,
  );
}

/** Daemon-appended entries (set-context) are query action items on the
 *  query file; their log entries resolve them. */
function foldSessionAppended(
  state: AgentState,
  uuids: readonly UUID[],
): AgentState {
  const sessionId = state.querySessionId;
  if (sessionId === undefined) return state;
  let session = state.sessions[sessionId] ?? freshSessionState();
  const anomalies: TrackerAnomaly[] = [];
  for (const uuid of uuids) {
    const observation = observeOn(session, "query", uuid, "appended", false);
    session = observation.session;
    anomalies.push(...observation.anomalies);
  }
  return withAnomalies(withSession(state, sessionId, session), anomalies);
}

function foldScanComplete(state: AgentState): AgentState {
  const sessionId = state.fileSessionId;
  if (sessionId === undefined) return state;
  const session = state.sessions[sessionId];
  return session === undefined || !session.scanExcluded
    ? state
    : withSession(state, sessionId, { ...session, scanExcluded: false });
}

/** The classification table, one function per side: whether the other
 *  stream never carries this occurrence. Uuid-less occurrences are not
 *  asked. `excludedFromQuery` needs the complete entry (it reads
 *  `message.content`), so the tracker calls it once per entry and
 *  publishes the answer as the event's `expectsSdkMessage`; the fold reads
 *  that. */
export function excludedFromSession(message: SDKMessage): boolean {
  switch (message.type) {
    case "assistant":
    case "user":
      return false;
    case "system":
      return message.subtype !== "compact_boundary";
    default:
      return true;
  }
}
export function excludedFromQuery(entry: SessionEntry): boolean {
  switch (entry.type) {
    case "assistant":
      return false;
    case "user":
      return !(
        isToolResultEntry(entry) ||
        entry.isCompactSummary === true ||
        isLocalCommandStdout(entry)
      );
    case "system":
      return (
        entry.subtype !== "compact_boundary" &&
        entry.subtype !== "local_command"
      );
    default:
      return true;
  }
}

/** A slash command's output logged as a `user` entry, which the query
 *  stream replays (`isReplay`) — the shared `user` class that has no
 *  `tool_result` block (classification table). */
function isLocalCommandStdout(entry: SessionEntry): boolean {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return (
    typeof content === "string" && content.startsWith("<local-command-stdout>")
  );
}

/**
 * The API's usage object with nulls removed, as NonNullableUsage promises:
 * the numeric token counters are defaulted to 0 (arithmetic over them never
 * sees a hole); other null fields are dropped rather than given made-up
 * non-null values. Also used to coerce usage objects read back from session
 * file entries (tree/context-tree.ts).
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
export const isIdle = (state: AgentState): boolean =>
  state.activity === "idle" && queryingCount(state) === 0;

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
    case "userMessageQueued": {
      const queuedMessages = [
        ...state.queuedMessages,
        { id: event.id, message: event.message },
      ];
      // Gated on activity, not isIdle: idle is the only activity a queued
      // message changes, and if the activity invariant were ever violated
      // (idle with querying messages queued), setting pending repairs it
      // where an isIdle gate would preserve the corruption.
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
        // message's transcript record is its queued_command attachment
        // entry, which the session stream and the history fetch both
        // deliver — holding it here would show it twice.
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
    case "sdkMessage": {
      const message = event.message;
      if (
        (message.type === "user" || message.type === "assistant") &&
        typeof message.parent_tool_use_id === "string"
      ) {
        // Subagent traffic: its usage describes the subagent's own context,
        // not this agent's, and its transcript entries are sidechain entries
        // the leaf must never point at (session-seed applies the same
        // eligibility filter).
        return state;
      }
      let next = foldQueryMessage(state, message);
      if (
        (message.type === "user" || message.type === "assistant") &&
        message.uuid !== undefined
      ) {
        // The uuid guard is for the type only: stream user/assistant messages
        // always carry the transcript uuid (verified in the CLI binary; the
        // optional uuid on SDKUserMessage is for host-pushed input). The
        // boundary advance (foldQueryMessage's pendingLeaf) and the
        // deliveredMessages clear happen in the same fold step — that is the
        // prompt-visibility bookkeeping (header comment).
        if (next.deliveredMessages.length > 0) {
          next = { ...next, deliveredMessages: [] };
        }
      }
      if (message.type === "conversation_reset") {
        // SDK 0.3.250 emits this before the new conversation's init. Despite
        // its name, new_conversation_id is not the transcript session_id
        // announced by that init (verified live); the old context's evidence
        // stays with its file. Queued future turns still belong to the
        // running process.
        return { ...next, deliveredMessages: [] };
      }
      if (message.type === "system" && message.subtype === "init") {
        return withObservedPermissionMode(
          {
            ...next,
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
        // Mode changes not initiated over socket (e.g. plan-mode
        // transitions).
        return withObservedPermissionMode(next, message.permissionMode);
      }
      if (message.type === "assistant") {
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
