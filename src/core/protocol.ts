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
  nextAgentState,
  type AgentState,
  type TrackerAnomaly,
} from "./agent-state.ts";
import type { SessionEntry } from "./session/file.ts";
import { AsyncQueue } from "./generated/streaming/async-queue.ts";
import type {
  StreamEvent,
  StreamSubscription,
} from "./generated/streaming/driver.ts";
import type { TreeNodeRef } from "./tree/nodes.ts";
import { UUID_PATTERN } from "./uuid.ts";

export const PROTOCOL_NAME = "clauctl-protocol";
export const PROTOCOL_VERSION = 1;

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
 * `userMessageQueued` at acceptance, `userMessageDequeued` immediately after
 * the SDK message that triggered the dequeue. Dequeues reference
 * daemon-assigned ids, so out-of-order dequeuing (a `next` cutting ahead of a
 * `later`) is unambiguous. A merged same-priority bucket dequeues as one event
 * carrying all its ids — the whole bucket runs as a single turn with a single
 * `result`.
 */
export type AgentEvent =
  | { kind: "userMessageQueued"; id: number; message: SDKUserMessage }
  | { kind: "userMessageDequeued"; delivery: MessageDelivery; ids: number[] }
  | { kind: "compactSent"; message: SDKUserMessage } // /compact issued while Idle
  | { kind: "interruptSent" }
  | { kind: "controlApplied"; request: SdkControlApplied }
  // Emitted after the sessionEntry that completes a compact_boundary — the
  // boundary's own, or its anchor's when the block was deferred — whatever
  // wrote it (native compaction or set-context). `leaf` is the final
  // post-boundary context tip (null after a wipe).
  | { kind: "contextChanged"; boundary: UUID; leaf: TreeNodeRef | null }
  | { kind: "sdkMessage"; message: SDKMessage }
  // One per canonical log entry of the tracked file, in file order, emitted
  // as soon as the follower reads the line (never held for resolution:
  // subscribers run the same merge). `entry` is the complete entry when its
  // class is session-only, else `structuralEntry(entry)`: the subscriber
  // already holds the payload from the `sdkMessage` twin. `expectsSdkMessage`
  // is that class decision (false = session-only; a prediction from the
  // table, not an observation), made by the tracker on the
  // complete entry: the fold reads it rather than re-classifying, because
  // the `<local-command-stdout>` rule reads `message.content`, a payload
  // leaf the projection empties. `leaf` is the context tree's leaf after
  // this entry and `lastAssistant` the usage/model of the last
  // non-excluded, non-sidechain assistant on contextAt(leaf) (absent when
  // none; each field independently optional) — daemon-computed, so clients
  // fold them without owning a tree. `awaitingAnchors` lists the boundaries
  // whose blocks are still deferred (session tracker incomplete).
  | {
      kind: "sessionEntry";
      entry: SessionEntry;
      expectsSdkMessage: boolean;
      leaf: TreeNodeRef | null;
      lastAssistant?: { usage?: NonNullableUsage; model?: string };
      awaitingAnchors: readonly UUID[];
    }
  // The follower moved to `sessionId`: the old file's SessionState is dropped
  // and the new file is about to be scanned.
  | { kind: "sessionFileChanged"; sessionId: UUID }
  // The follower's start() has returned for the tracked file: every entry
  // the file held when it was opened has been folded.
  | { kind: "scanComplete" }
  // The daemon appended these uuid-bearing entries to the query file
  // (set-context); emitted before the drain that delivers them.
  | { kind: "sessionAppended"; uuids: readonly UUID[] }
  // A daemon-detected anomaly (follower failure, malformed line,
  // classification at the dedup site, awaiting-anchor); the fold sets
  // `anomaly`. Fold-detected ones (merge errors, head-mismatch) need no
  // event: every fold computes them.
  | { kind: "trackerAnomaly"; anomaly: TrackerAnomaly }
  // Emitted by the daemon before any teardown, so subscribers can distinguish
  // a deliberate shutdown (archive → SIGTERM, stream end) from a crash (socket
  // close with no announcement). Delivery is best-effort: process exit races
  // kernel buffers, so a lost line degrades to an unannounced close.
  | { kind: "shutdown"; reason: string };

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
      thinkingDisplay?: "summarized" | "omitted" | null;
    }
  | { type: "apply-flag-settings"; settings: FlagSettings }
  // Writes a settings FILE through the CLI's own writer and live-applies it;
  // the SDK accepts only an explicit key allowlist (outputStyle today) with
  // string values, and only the project's local settings file as target.
  | {
      type: "update-settings";
      source: "localSettings";
      settings: Record<string, unknown>;
    }
  | { type: "set-mcp-servers"; servers: Record<string, McpServerConfig> }
  | { type: "toggle-mcp-server"; serverName: string; enabled: boolean }
  | { type: "reconnect-mcp-server"; serverName: string }
  | { type: "stop-task"; taskId: string }
  | { type: "background-tasks"; toolUseId?: string }
  | { type: "rewind-files"; userMessageId: string; dryRun?: boolean }
  | { type: "seed-read-state"; path: string; mtime: number }
  | { type: "reload-plugins" }
  | { type: "reload-skills" };

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
  | { type: "usage" }
  | { type: "account-info" }
  | {
      type: "read-file";
      path: string;
      maxBytes?: number;
      encoding?: "utf-8" | "base64";
    };
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
