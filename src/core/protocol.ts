/**
 * The clauctl protocol (spoken over the agent's `socket` file) and its client:
 * newline-delimited JSON over a unix socket. Three record shapes flow daemon→client, distinguished structurally:
 * the hello (first line on connect, so clients can validate they are talking
 * to a clauctl daemon), responses (have an `id`), and pushed events (`{ event:
 * AgentEvent }`, only on connections that sent `subscribe`).
 */

import type { UUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type {
  EffortLevel,
  McpServerConfig,
  NonNullableUsage,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import {
  classOf,
  nextAgentState,
  type AgentState,
  type MergeStream,
  type TrackerAnomaly,
} from "./agent-state/agent-state.ts";
import { queuedCommandSourceUuid, type SessionEntry } from "./session/file.ts";
import { AsyncQueue } from "./generated/streaming/async-queue.ts";
import type {
  StreamEvent,
  StreamSubscription,
} from "./generated/streaming/driver.ts";
import type { TreeNodeRef } from "./tree/nodes.ts";
import { UUID_PATTERN } from "./uuid.ts";

export const PROTOCOL_NAME = "clauctl-protocol";
export const PROTOCOL_VERSION = 2;

export type MessageDelivery = "turn" | "steer" | "append";

/**
 * The augmented event stream (DECISION-6): every SDK message, plus the events
 * only the daemon can know about, serialized so an observer can follow what is
 * happening. This is protocol: the daemon's event hub writes exactly this
 * stream to every subscriber and folds its own state over the same stream
 * (agent-state.ts) — so daemon state is always reconstructible by an observer.
 *
 * The CLI's queue operations are invisible on the live stream, so the daemon
 * models the queue (queue-model.ts) and synthesizes the queued/dequeued pair:
 * `userMessageQueued` at acceptance, `userMessageDequeued` next to the SDK
 * message that triggered the dequeue: a steer's dequeue immediately before
 * the assistant frame that absorbed it (the file's order), a turn's or
 * append's immediately after the `result` that dequeued it. A message's
 * uuid is stamped by the daemon before delivery — the uuid its
 * session-file entry carries — so out-of-order dequeuing (a `next` cutting
 * ahead of a `later`) is unambiguous and a dequeue names the entry it
 * predicts. A run — the querying prefix of the top-priority bucket, or a
 * lone append (docs/claude-agent-sdk.md, "Queued prompts coalesce by run")
 * — dequeues as one event carrying all its uuids: it runs as a single turn
 * with a single `result`, filed under the last uuid. A steer and an append
 * are always a run of one (queue-model.ts); consumers need not special-case
 * them.
 *
 * Every event is a node of its session's stream merge (`eventUuid`), on
 * exactly one stream (`eventStream`): one whose payload carries no uuid is
 * stamped by the hub at emission — `uuid` beside an unmutated payload —
 * and observed on its stream, excluded from the other, so it resolves
 * right behind its stream predecessors and a subscriber can place it in
 * file order. `shutdown` is such a node on every live session.
 */
export type AgentEvent =
  // `uuid` is the event's own; `message.uuid` is the prompt's stamped uuid.
  | { kind: "userMessageQueued"; uuid: UUID; message: SDKUserMessage }
  | {
      kind: "userMessageDequeued";
      delivery: MessageDelivery;
      uuids: readonly [UUID, ...UUID[]];
    }
  | { kind: "compactSent"; uuid: UUID; message: SDKUserMessage } // /compact issued while Idle
  | { kind: "interruptSent"; uuid: UUID }
  | { kind: "controlApplied"; uuid: UUID; request: SdkControlApplied }
  // Emitted after the sessionEntry that completes a compact_boundary — the
  // boundary's own, or its anchor's when the block was deferred — whatever
  // wrote it (native compaction or set-context). `leaf` is the final
  // post-boundary context tip (null after a wipe).
  | {
      kind: "contextChanged";
      uuid: UUID;
      boundary: UUID;
      leaf: TreeNodeRef | null;
    }
  // `uuid` only when the message carries none (stream events, results,
  // system frames).
  | { kind: "sdkMessage"; message: SDKMessage; uuid?: UUID }
  // One per canonical log entry of the tracked file, in file order, emitted
  // as soon as the follower reads the line (never held for resolution:
  // subscribers run the same merge). `entry` is the complete entry for every
  // class; `uuid` only when the entry carries none. `expectsSdkMessage` is
  // the tracker's class decision (false = session-only; a prediction from
  // the table, not an observation): the fold reads it rather than
  // re-classifying, so daemon and subscribers cannot disagree. `leaf` is
  // the context tree's leaf after this entry and `lastAssistant` the
  // usage/model of the last non-excluded, non-sidechain assistant on
  // contextAt(leaf) (absent when none; each field independently optional)
  // — daemon-computed, so clients fold them without owning a tree.
  // `awaitingAnchors` lists the boundaries whose blocks are still deferred
  // (session tracker incomplete).
  | {
      kind: "sessionEntry";
      entry: SessionEntry;
      uuid?: UUID;
      expectsSdkMessage: boolean;
      leaf: TreeNodeRef | null;
      lastAssistant?: { usage?: NonNullableUsage; model?: string };
      awaitingAnchors: readonly UUID[];
    }
  // The head of a session's query chain, node `sessionId`: emitted before
  // the first query message carrying it (for the daemon's seeded id, at hub
  // construction). It resolves with the `sessionFileChanged` that starts
  // the same session on the file side, so the session's query messages
  // stay pending until its file is followed.
  | { kind: "querySessionChanged"; sessionId: UUID }
  // The follower moved to `sessionId`: the old file's SessionState is dropped
  // and the new file is about to be scanned.
  | {
      kind: "sessionFileChanged";
      sessionId: UUID;
      /** Absent for a session start: its node is `sessionId`, the same
       *  node `querySessionChanged` observes on `query`, so the session's
       *  two chains meet at their heads. A same-file rescan re-announces a
       *  session whose id already heads its `session` chain, and an id may
       *  appear only once per stream, so it carries a fresh node of its own,
       *  excluded from `query`. */
      uuid?: UUID;
    }
  // The follower's start() has returned for the tracked file: every entry
  // the file held when it was opened has been folded.
  | { kind: "scanComplete"; uuid: UUID }
  // The daemon appended an entry to the query file itself (set-context):
  // its query-stream form, one event per entry in file order, emitted
  // before the drain that delivers the entries — the echo the CLI would
  // have produced had it written them.
  | { kind: "sessionAppended"; message: SDKMessage }
  // An anomaly the daemon detected — by its fold (merge errors,
  // head-mismatch: reported right after the event whose fold raised it)
  // or by its tracker (follower failure, malformed line, classification at
  // the dedup site, awaiting-anchor) — with the diagnostic bundle it wrote.
  // Clients react to this event; the fold only observes its node.
  | {
      kind: "trackerAnomaly";
      uuid: UUID;
      stream: MergeStream;
      anomaly: TrackerAnomaly;
      bundlePath: string;
    }
  // Emitted by the daemon before any teardown, so subscribers can distinguish
  // a deliberate shutdown (archive → SIGTERM, stream end) from a crash (socket
  // close with no announcement). Delivery is best-effort: process exit races
  // kernel buffers, so a lost line degrades to an unannounced close.
  | { kind: "shutdown"; uuid: UUID; reason: string };

/** An event as its emitter hands it to the hub: without the uuid the hub
 *  stamps (optional payload-side uuids are the emitter's to set). */
export type Unstamped<E> = E extends { uuid: UUID }
  ? Omit<E, "uuid" | "bundlePath">
  : E;

/** The event's merge nodes in stream order, its identity last — the
 *  payload's uuid when it carries one (an SDK message's, an entry's, a
 *  dequeue's run key, a session start's session id), else the stamped
 *  `uuid`. A `queued_command` attachment entry first observes the steered
 *  prompt's `source_uuid` (the dequeue's `query` node it meets), so the
 *  attachment's own node, a `session`-only one, resolves only behind the
 *  steer it records: never before its dequeue. */
export function eventNodes(event: AgentEvent): readonly [UUID, ...UUID[]] {
  switch (event.kind) {
    case "userMessageDequeued":
      return [event.uuids[event.uuids.length - 1]!];
    case "sdkMessage":
      return [(event.message.uuid as UUID | undefined) ?? event.uuid!];
    case "sessionEntry": {
      const sourceUuid = queuedCommandSourceUuid(event.entry);
      return sourceUuid === undefined
        ? [event.entry.uuid ?? event.uuid!]
        : [sourceUuid, event.entry.uuid!];
    }
    case "sessionAppended":
      return [event.message.uuid as UUID];
    case "querySessionChanged":
      return [event.sessionId];
    case "sessionFileChanged":
      return [event.uuid ?? event.sessionId];
    case "userMessageQueued":
    case "compactSent":
    case "interruptSent":
    case "controlApplied":
    case "contextChanged":
    case "scanComplete":
    case "trackerAnomaly":
    case "shutdown":
      return [event.uuid];
  }
}

/** The event's identity: the last of `eventNodes(event)`. */
export function eventUuid(event: AgentEvent): UUID {
  return eventNodes(event).at(-1)!;
}

/** For anomaly details: `classOf` of the SDK message or entry the event
 *  carries, `"prompt"` for a dequeue, the kind otherwise. */
export function eventClass(event: AgentEvent): string {
  switch (event.kind) {
    case "userMessageDequeued":
      return "prompt";
    case "sdkMessage":
    case "sessionAppended":
      return classOf(event.message);
    case "sessionEntry":
      return classOf(event.entry);
    case "userMessageQueued":
    case "compactSent":
    case "interruptSent":
    case "controlApplied":
    case "contextChanged":
    case "querySessionChanged":
    case "sessionFileChanged":
    case "scanComplete":
    case "trackerAnomaly":
    case "shutdown":
      return event.kind;
  }
}

/** The one stream the event is a node of — what its position is
 *  synchronized with, not where it originated: `session` when the
 *  event's place is fixed relative to the file's append order, `query`
 *  when it is fixed relative to the SDK message sequence
 *  (docs/protocol.md, "The event stream"). */
export function eventStream(event: AgentEvent): MergeStream {
  switch (event.kind) {
    case "sessionEntry":
    case "sessionFileChanged":
    case "scanComplete":
    case "contextChanged":
      return "session";
    case "trackerAnomaly":
      return event.stream;
    case "userMessageQueued":
    case "userMessageDequeued":
    case "compactSent":
    case "interruptSent":
    case "controlApplied":
    case "sdkMessage":
    case "querySessionChanged":
    case "sessionAppended":
    case "shutdown":
      return "query";
  }
}

/** The SDKMessage an event carries: the CLI's own frame, or the daemon's
 *  echo of an entry it appended. Both are what the fold observes on
 *  `query`, so a client's pending list and its transcript treat them
 *  alike. */
export function sdkMessageOf(event: AgentEvent): SDKMessage | undefined {
  switch (event.kind) {
    case "sdkMessage":
    case "sessionAppended":
      return event.message;
    default:
      return undefined;
  }
}

export type TurnPriority = "now" | "next" | "later";

/**
 * `subscribe`'s optional self-identification: attachers send it so the daemon
 * can track them in `record.attachments` and audit attach/detach; observers
 * like `tail` subscribe bare and stay invisible.
 */
export interface SubscribeAttachment {
  pid: number;
  client: string;
}

/**
 * The `applyFlagSettings` payload: `null` clears a key, a value replaces it
 * (the SDK method's own parameter shape). effortLevel is widened beyond
 * Settings' type: the Settings file schema omits "max", but the CLI runtime
 * accepts and applies it (verified 2026-07-21 via CLAUDE_EFFORT on a live
 * session).
 */
export type FlagSettings = Omit<
  { [K in keyof Settings]?: Settings[K] | null },
  "effortLevel"
> & { effortLevel?: EffortLevel | null };

/**
 * Query mutations except interrupt; each maps 1:1 to a Query method and emits
 * `controlApplied` on success. The mutation/read split classifies each method
 * by its documented semantics in sdk.d.ts; a misclassification costs a missing
 * or superfluous event, nothing worse.
 */
export type SdkControlMutation =
  | { type: "set-permission-mode"; mode: PermissionMode }
  | {
      type: "set-mcp-permission-mode-override";
      serverName: string;
      mode: "default" | "auto" | null;
    }
  | { type: "set-model"; model?: string }
  | {
      type: "set-max-thinking-tokens";
      maxThinkingTokens: number | null;
      thinkingDisplay?: "summarized" | "omitted" | "highlights" | null;
    }
  | { type: "apply-flag-settings"; settings: FlagSettings }
  // Writes a settings FILE through the CLI's own writer and live-applies it;
  // the SDK accepts only an explicit key allowlist per file (localSettings:
  // outputStyle; userSettings: effortLevel).
  | {
      type: "update-settings";
      source: "localSettings" | "userSettings";
      settings: Record<string, unknown>;
    }
  | { type: "set-mcp-servers"; servers: Record<string, McpServerConfig> }
  | { type: "toggle-mcp-server"; serverName: string; enabled: boolean }
  | { type: "reconnect-mcp-server"; serverName: string }
  | { type: "stop-task"; taskId: string }
  | { type: "background-tasks"; toolUseId?: string }
  | { type: "rewind-files"; userMessageId: string; dryRun?: boolean }
  | { type: "seed-read-state"; path: string; mtime: number }
  // holdOnCacheImpact: apply nothing when the reload would change the tool
  // list the prompt cache depends on; the response then carries `held: true`.
  | { type: "reload-plugins"; holdOnCacheImpact?: boolean }
  | { type: "reload-skills" }
  | { type: "reload-output-styles" };

/**
 * The mutation as broadcast on `controlApplied`: the request as received,
 * except an apply-flag-settings `effortLevel: null`. That null clears the
 * flag-tier value, but the level the next query will use is still something
 * concrete, and the client-side fold (agent-state.ts) is pure and cannot run
 * the settings cascade — so the daemon resolves the post-clear level at
 * emission (spawn `--effort`, else the settings cascade) and emits it in
 * place of the null; null survives only when neither tier specifies a level.
 */
export type SdkControlApplied = SdkControlMutation;

/** Query reads; the response `data` is the method's return value. */
export type SdkControlRead =
  | { type: "initialization-result" }
  | { type: "supported-commands" }
  | { type: "supported-models" }
  | { type: "supported-agents" }
  | { type: "mcp-server-status" }
  // "full" (default) counts each category with the token-count API;
  // "summary" answers from the last response's usage and local estimates.
  | { type: "get-context-usage"; detail?: "summary" | "full" }
  // skipBehaviors: leave the response's `behaviors` null instead of scanning
  // local transcripts for it.
  | { type: "usage"; skipBehaviors?: boolean }
  | { type: "account-info" }
  | {
      type: "read-file";
      path: string;
      maxBytes?: number;
      encoding?: "utf-8" | "base64";
    }
  // An MCP Apps `ui://` resource from a connected server (alpha SDK method;
  // the contents are untrusted third-party HTML).
  | { type: "read-mcp-resource"; serverName: string; uri: string };
/** Exactly one of `uuids` / `rewindTo`. */
export type SetContextRequest =
  // Append a compact_boundary (+ optional summary) to the session jsonl and
  // restart the Query so the listed messages become the effective context.
  | {
      type: "set-context";
      /** Ordered; becomes compactMetadata.preservedMessages.uuids (and allUuids). */
      uuids: UUID[];
      /** Omitted → no summary entry is written. Present → up_to shape:
       *  summary first, then uuids. */
      summaryText?: string;
    }
  // Syntactic sugar for uuids = (the assistant context at rewindTo, followed by
  // `append`).
  | {
      type: "set-context";
      rewindTo: TreeNodeRef;
      /** Appended after the context at rewindTo; the whole list then goes
       *  through normalizePreservedUuids. */
      append?: UUID[];
    };

/** Response data for set-context. summaryUuid absent whenever no summary
 *  entry was written. */
export interface SetContextResponse {
  boundaryUuid: UUID;
  summaryUuid?: UUID;
  /** Uuids normalization inserted into the preserved list (omitted when
   *  nothing was added). */
  added?: UUID[];
}

/** What a read of entries carries back: identities only (no file read),
 *  or the complete entries (readEntriesAt over their ranges). */
export type EntryPayload = "uuids" | "full";

export const ENTRY_PAYLOADS: readonly EntryPayload[] = ["uuids", "full"];

/** get-entries response. `entries` is present for `payload: "full"`: the
 *  complete entries in file order, one per uuid. */
export interface GetEntriesResponse {
  uuids: UUID[];
  entries?: SessionEntry[];
  /** The current-leaf occurrence — where the next turn attaches. Null
   *  when the session has no chain entries. */
  leaf: TreeNodeRef | null;
}

/** get-context response: the context as occurrences in context order;
 *  `entries` (same order) present for `payload: "full"`. */
export interface GetContextResponse {
  refs: TreeNodeRef[];
  entries?: SessionEntry[];
}

function assertUuid(value: unknown, label: string): UUID {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a uuid, got ${JSON.stringify(value)}`);
  }
  return value as UUID;
}

/** A {uuid, viaBoundary?} record from untrusted JSON; throws naming
 *  `label` on any other shape. */
export function parseWireTreeNodeRef(
  value: unknown,
  label: string,
): TreeNodeRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a {uuid, viaBoundary?} object`);
  }
  // Fields stay unknown so assertUuid is the only way to a UUID.
  const ref = value as { uuid?: unknown; viaBoundary?: unknown };
  return {
    uuid: assertUuid(ref.uuid, `${label}.uuid`),
    ...(ref.viaBoundary !== undefined && {
      viaBoundary: assertUuid(ref.viaBoundary, `${label}.viaBoundary`),
    }),
  };
}

/** The socket casts untrusted JSON, so the one destructive command is parsed
 *  explicitly before any teardown. Throws with a descriptive message on:
 *  both or neither of uuids/rewindTo, non-array or non-uuid-string uuids or
 *  append, a rewindTo that is not a {uuid, viaBoundary?} record of uuids,
 *  append without rewindTo, non-string or empty summaryText. An empty uuids
 *  array passes — an explicit empty list on the wire is a deliberate
 *  context reset; the fat-finger guard lives in the CLI (--empty). */
export function parseSetContextRequest(
  raw: Record<string, unknown>,
): SetContextRequest {
  const { uuids, rewindTo, summaryText, append } = raw;
  const parseUuidList = (value: unknown, label: string): UUID[] => {
    if (!Array.isArray(value)) {
      throw new Error(`set-context: ${label} must be an array`);
    }
    return value.map((uuid) => assertUuid(uuid, `${label} entry`));
  };
  if (rewindTo !== undefined) {
    if (uuids !== undefined || summaryText !== undefined) {
      throw new Error(
        "set-context: rewindTo is mutually exclusive with uuids/summaryText",
      );
    }
    return {
      type: "set-context",
      rewindTo: parseWireTreeNodeRef(rewindTo, "set-context: rewindTo"),
      ...(append !== undefined && { append: parseUuidList(append, "append") }),
    };
  }
  if (uuids === undefined) {
    throw new Error("set-context: exactly one of uuids/rewindTo is required");
  }
  if (append !== undefined) {
    throw new Error("set-context: append requires rewindTo");
  }
  const parsedUuids = parseUuidList(uuids, "uuids");
  if (summaryText !== undefined) {
    if (typeof summaryText !== "string" || summaryText === "") {
      throw new Error("set-context: summaryText must be a non-empty string");
    }
  }
  return {
    type: "set-context",
    uuids: parsedUuids,
    ...(summaryText !== undefined && { summaryText }),
  };
}

export interface GetEntriesSnapshotRequest {
  type: "get-entries";
  payload: EntryPayload;
  since?: UUID;
}

/** Payload lookup for known uuids: no snapshot, no payload selector. */
export interface GetEntriesByUuidsRequest {
  type: "get-entries";
  uuids: UUID[];
}

export const isGetEntriesByUuids = (
  request: ProtocolRequest,
): request is GetEntriesByUuidsRequest =>
  request.type === "get-entries" && "uuids" in request;

export type ProtocolRequest =
  | {
      type: "prompt";
      content: string | ContentBlockParam[];
      priority?: TurnPriority;
      shouldQuery?: false;
    }
  | { type: "interrupt" }
  // Response data is the daemon's current AgentState; every event emitted
  // after it follows as an AgentEventRecord line until the connection closes.
  // No history replay — a subscriber starts at "now" and folds from there
  // (agent-state.ts).
  | { type: "subscribe"; attachment?: SubscribeAttachment }
  // Response data: GetContextResponse — the assistant context at `at` (an
  // occurrence of the context tree), or at the current leaf when absent;
  // empty with no session or a null leaf. Derived from the tracked file via
  // the context tree, not from the Query, so it is not an SdkControlRead.
  | { type: "get-context"; at?: TreeNodeRef; payload: EntryPayload }
  // Response data: GetEntriesResponse — every canonical entry of the current
  // session (after the `since` cursor when given; an unknown cursor is an
  // error) plus the current-leaf occurrence. Clients build the tree locally
  // (build-tree.ts); a nested wire representation would overflow
  // JSON.stringify on long sessions.
  | GetEntriesSnapshotRequest
  // Response data: SessionEntry[] — these entries complete, in requested
  // order; an unknown uuid is an error.
  | GetEntriesByUuidsRequest
  // Response data: SetContextResponse.
  | SetContextRequest
  | SdkControlMutation
  | SdkControlRead;

/** A pushed stream event on a subscribed connection; no `id`, unlike responses. */
export interface AgentEventRecord {
  event: AgentEvent;
}

export type ProtocolRequestRecord = ProtocolRequest & { id: string };

export type ProtocolResponse =
  | { id: string; ok: true; data?: unknown }
  | { id: string; ok: false; error: string };

/** A response paired with the subscription queue's pushed count at its
 *  line. Events and responses share one wire, so the response is a cut of
 *  the event stream: the first `eventsBefore` events precede it. */
interface PositionedResponse {
  response: ProtocolResponse;
  eventsBefore: number;
}

interface PendingRequest {
  resolve: (response: PositionedResponse) => void;
  reject: (error: Error) => void;
}

/** What `subscribe` hands the stream driver: the state before any delivered
 *  event, plus the queue of (event, post-fold state) pairs. */
export type AgentEventSubscription = StreamSubscription<AgentEvent, AgentState>;

export class ProtocolClient {
  private readonly socket: Socket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closedPromise: Promise<void>;
  private requestCounter = 0;
  private closed = false;
  // Installed by subscribe(), before the request goes out; until then event
  // lines have nowhere to go. Doubles as the single-subscription guard.
  private events: AsyncQueue<StreamEvent<AgentEvent, AgentState>> | undefined;
  // The client-owned fold: seeded from the subscribe response at dispatch,
  // advanced by nextAgentState per event line. undefined until subscribed.
  private foldedState: AgentState | undefined;
  private subscribeRequestId: string | undefined;
  // Set by connect() from the hello record; private so only the static
  // factory writes it.
  private helloVersionWarning: string | undefined;

  /** Set when the daemon announced a different protocol version — its build
   *  differs from this client's, so request/response shapes may not line up.
   *  The consumer decides how to surface it (stderr for CLI commands, a
   *  transcript banner for the TUI). */
  get versionWarning(): string | undefined {
    return this.helloVersionWarning;
  }

  private constructor(socket: Socket) {
    this.socket = socket;
    this.closedPromise = new Promise((resolve) => {
      socket.on("close", () => {
        this.closed = true;
        const error = new Error("agent socket closed");
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();
        // close, not cancel: the daemon is gone, but events already received
        // are still real and a consumer must see them.
        this.events?.close();
        resolve();
      });
    });
  }

  /** Connect and consume the hello record; rejects on a non-clauctl socket. */
  static async connect(socketPath: string): Promise<ProtocolClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(socketPath);
      s.once("connect", () => {
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", reject);
    });

    const client = new ProtocolClient(socket);
    socket.on("error", () => socket.destroy());

    let helloSeen = false;
    let resolveHello!: () => void;
    let rejectHello!: (error: Error) => void;
    const helloPromise = new Promise<void>((resolve, reject) => {
      resolveHello = resolve;
      rejectHello = reject;
    });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() !== "") {
          if (!helloSeen) {
            helloSeen = true;
            const hello = validateHello(line);
            if (hello.error) {
              socket.destroy();
              rejectHello(hello.error);
            } else {
              client.helloVersionWarning = hello.versionWarning;
              resolveHello();
            }
          } else {
            client.dispatchLine(line);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });

    socket.on("close", () => {
      if (!helloSeen) {
        rejectHello(new Error("agent socket closed before hello"));
      }
    });

    await helloPromise;
    return client;
  }

  // Routes structurally: records with an `id` resolve pending requests,
  // records with an `event` fold and go to the event queue — so a subscriber
  // never sees responses. Lines dispatch synchronously in wire order, so the
  // fold seeds at the subscribe response's line, strictly before any event
  // line (the daemon writes the seed response before attaching the event
  // sink).
  private dispatchLine(line: string): void {
    let record: { id?: string; event?: AgentEvent };
    try {
      record = JSON.parse(line) as { id?: string; event?: AgentEvent };
    } catch {
      return;
    }
    if (record.event !== undefined) {
      // Pre-seed events would violate the daemon protocol; drop rather than
      // fold into nothing.
      if (this.foldedState !== undefined) {
        this.foldedState = nextAgentState(this.foldedState, record.event);
        this.events?.push({ event: record.event, state: this.foldedState });
      }
      return;
    }
    const pending =
      record.id === undefined ? undefined : this.pending.get(record.id);
    if (pending) {
      this.pending.delete(record.id!);
      const response = record as unknown as ProtocolResponse;
      if (record.id === this.subscribeRequestId && response.ok) {
        this.foldedState = response.data as AgentState;
      }
      pending.resolve({
        response,
        eventsBefore: this.events?.pushedCount ?? 0,
      });
    }
  }

  /** Send a request; resolves with the response data, throws on daemon error. */
  async request(request: ProtocolRequest): Promise<unknown> {
    return (await this.requestWithEventCount(request)).data;
  }

  /** request() plus how many subscription events were queued before the
   *  response line — the snapshot handoff point (spec Data flow 6): a
   *  subscriber that fetched a snapshot after subscribing knows the first
   *  `eventsBefore` queued events are in the snapshot and later ones are
   *  not. Zero when not subscribed. */
  async requestWithEventCount(
    request: ProtocolRequest,
  ): Promise<{ data: unknown; eventsBefore: number }> {
    const { response, eventsBefore } = await this.sendRequest(request).response;
    if (!response.ok) {
      throw new Error(`daemon rejected ${request.type}: ${response.error}`);
    }
    return { data: response.data, eventsBefore };
  }

  private sendRequest(request: ProtocolRequest): {
    id: string;
    response: Promise<PositionedResponse>;
  } {
    if (this.closed) {
      throw new Error("agent socket closed");
    }
    const id = `clauctl-${++this.requestCounter}`;
    const response = new Promise<PositionedResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ ...request, id })}\n`);
    });
    return { id, response };
  }

  /**
   * Turn this connection into a subscriber: the client owns the fold. It
   * seeds its state from the subscribe response and folds every subsequent
   * event through `nextAgentState` — the same fold the daemon runs, so its
   * state always matches the daemon's — queueing each event together with
   * the state after folding it. The (event, state) pair keeps a consumer's
   * view aligned with the event it is processing even when the client's live
   * state runs ahead. Single-use per client; requests may still be sent on a
   * subscribed connection.
   *
   * The returned seed is the state before any queued event, not the live
   * folded state: events are queued synchronously from the data handler while
   * this promise settles on a microtask, so events can already be queued when
   * it resolves, and a consumer that needs strict output ordering (tail)
   * reports the seed those events advanced from first.
   */
  async subscribe(
    attachment?: SubscribeAttachment,
  ): Promise<AgentEventSubscription> {
    if (this.events !== undefined) {
      throw new Error("protocol client is already subscribed");
    }
    const events = new AsyncQueue<StreamEvent<AgentEvent, AgentState>>();
    this.events = events;
    const { id, response } = this.sendRequest({
      type: "subscribe",
      ...(attachment !== undefined && { attachment }),
    });
    this.subscribeRequestId = id;
    let result: ProtocolResponse;
    try {
      ({ response: result } = await response);
    } catch (error) {
      // Pending requests reject with the generic close error; without a seed
      // there is no subscription to hand back, so name that specifically.
      throw this.closed
        ? new Error("agent socket closed before the subscribe seed")
        : error;
    }
    if (!result.ok) {
      throw new Error(`daemon rejected subscribe: ${result.error}`);
    }
    return { seed: result.data as AgentState, events };
  }

  /** Resolves when the daemon closes the socket. */
  waitClosed(): Promise<void> {
    return this.closedPromise;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.socket.destroy();
  }
}

function validateHello(line: string): {
  error?: Error;
  versionWarning?: string;
} {
  try {
    const hello = JSON.parse(line) as {
      type?: string;
      protocol?: string;
      version?: number;
    };
    if (hello.type !== "hello" || hello.protocol !== PROTOCOL_NAME) {
      return {
        error: new Error(
          `not a clauctl agent socket (got ${line.slice(0, 100)})`,
        ),
      };
    }
    if (hello.version !== PROTOCOL_VERSION) {
      return {
        versionWarning: `clauctl protocol version ${hello.version}, expected ${PROTOCOL_VERSION} — daemon and client builds differ`,
      };
    }
    return {};
  } catch {
    return {
      error: new Error("first record on agent socket was not valid JSON"),
    };
  }
}

/**
 * Connect, retrying while the socket does not exist yet or refuses connections
 * (daemon still starting, or a stale socket file). Backoff doubles from 50ms,
 * capped at 500ms; there is no event to await for "the daemon has bound its
 * socket", so bounded retry is the fallback.
 */
export async function connectWithRetry(
  socketPath: string,
  deadlineMs: number,
): Promise<ProtocolClient> {
  const deadline = Date.now() + deadlineMs;
  let delay = 50;
  while (true) {
    try {
      const client = await ProtocolClient.connect(socketPath);
      // CLI consumers all connect through here; the TUI connects directly
      // and banners the warning instead (stderr would land under its
      // alternate screen).
      if (client.versionWarning !== undefined) {
        process.stderr.write(`clauctl: warning: ${client.versionWarning}\n`);
      }
      return client;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "ENOENT" || code === "ECONNREFUSED";
      if (!retryable || Date.now() + delay > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 500);
    }
  }
}
