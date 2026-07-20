/**
 * The `sdk.sock` protocol and its client: newline-delimited JSON over a unix
 * socket. Three record shapes flow daemon→client, distinguished structurally:
 * the hello (first line on connect, so clients can validate they are talking
 * to a clauctl daemon), responses (have an `id`), and pushed events (`{ event:
 * SdkEvent }`, only on connections that sent `subscribe`).
 */

import type { UUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type {
  EffortLevel,
  McpServerConfig,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "./agent-state.ts";
import type { TreeNodeRef } from "./tree.ts";

export const SDK_SOCKET_PROTOCOL = "clauctl-sdk-socket";
export const SDK_SOCKET_VERSION = 1;

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
export type SdkEvent =
  | { kind: "userMessageQueued"; id: number; message: SDKUserMessage }
  | { kind: "userMessageDequeued"; delivery: MessageDelivery; ids: number[] }
  | { kind: "compactSent"; message: SDKUserMessage } // /compact issued while Idle
  | { kind: "interruptSent" }
  | { kind: "controlApplied"; request: SdkControlApplied }
  // Broadcast after every successful set-context (both modes, including
  // no-write rewinds), and also when the session file was mutated but the
  // subsequent Query restart failed — watchers track file truth. Deliberately
  // NOT an SdkControlMutation: that type is reserved for controls the real
  // SDK supports, while set-context is a method we wish the SDK had.
  // `leaf` is the post-change context tip — the value get-tree's leaf
  // computation reports after the change (null after an empty-context
  // reset); observers fold it into leafTreeNodeRef (agent-state.ts).
  | {
      kind: "contextChanged";
      request: SetContextRequest;
      leaf: TreeNodeRef | null;
    }
  | { kind: "sdkMessage"; message: SDKMessage };

export type TurnPriority = "now" | "next" | "later";

/** The `applyFlagSettings` payload: `null` clears a key, a value replaces it
 *  (the SDK method's own parameter shape). */
export type FlagSettings = { [K in keyof Settings]?: Settings[K] | null };

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
 * The range widens to the full EffortLevel because the spawn flag admits
 * "max", which the Settings file schema does not.
 */
export type SdkControlApplied =
  | Exclude<SdkControlMutation, { type: "apply-flag-settings" }>
  | {
      type: "apply-flag-settings";
      settings: Omit<FlagSettings, "effortLevel"> & {
        effortLevel?: EffortLevel | null;
      };
    };

/** Query reads; the response `data` is the method's return value. */
export type SdkControlRead =
  | { type: "initialization-result" }
  | { type: "supported-commands" }
  | { type: "supported-models" }
  | { type: "supported-agents" }
  | { type: "mcp-server-status" }
  | { type: "get-context-usage" }
  | { type: "usage" }
  | { type: "account-info" }
  | {
      type: "read-file";
      path: string;
      maxBytes?: number;
      encoding?: "utf-8" | "base64";
    };

/** Exactly one of `uuids` / `rewindTo` selects the mode. */
export type SetContextRequest =
  // Boundary mode: append a compact_boundary (+ optional summary) to the
  // session jsonl and restart the Query so the listed messages become the
  // effective context.
  | {
      type: "set-context";
      /** Ordered; becomes compactMetadata.preservedMessages.uuids (and allUuids). */
      uuids: UUID[];
      /** Omitted → no summary entry is written and anchor is forced to "boundary". */
      summaryText?: string;
      /** "summary" (default): summary first, then uuids (up_to shape).
       *  "boundary": uuids first, then summary (from shape). */
      anchor?: "summary" | "boundary";
    }
  // Rewind mode: the target is a tree-node occurrence whose entry is the
  // final transcript entry of an assistant API message. viaBoundary absent:
  // context = what it was when that message first appeared (the loader's
  // view of the file truncated just after the target). viaBoundary present
  // (a pick inside that boundary's relinked context): context = the prefix,
  // ending at uuid, of the chain that boundary installed. Uses
  // resumeSessionAt when the desired chain truncates the active chain, a
  // no-summary boundary otherwise.
  | { type: "set-context"; rewindTo: TreeNodeRef };

/** Response data for set-context. boundaryUuid absent when a rewind needed no
 *  boundary; summaryUuid absent whenever no summary entry was written. */
export interface SetContextResult {
  boundaryUuid?: UUID;
  summaryUuid?: UUID;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: unknown, label: string): UUID {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a uuid, got ${JSON.stringify(value)}`);
  }
  return value as UUID;
}

/** The socket casts untrusted JSON, so the one destructive command is parsed
 *  explicitly before any teardown. Throws with a descriptive message on:
 *  both or neither of uuids/rewindTo, non-array or non-uuid-string uuids,
 *  a rewindTo that is not a {uuid, viaBoundary?} record of uuids, unknown
 *  anchor, non-string or empty summaryText. An empty uuids array passes —
 *  an explicit empty list on the wire is a deliberate context reset; the
 *  fat-finger guard lives in the CLI (--empty). */
export function parseSetContextRequest(
  raw: Record<string, unknown>,
): SetContextRequest {
  const { uuids, rewindTo, summaryText, anchor } = raw;
  if (rewindTo !== undefined) {
    if (
      uuids !== undefined ||
      summaryText !== undefined ||
      anchor !== undefined
    ) {
      throw new Error(
        "set-context: rewindTo is mutually exclusive with uuids/summaryText/anchor",
      );
    }
    if (
      typeof rewindTo !== "object" ||
      rewindTo === null ||
      Array.isArray(rewindTo)
    ) {
      throw new Error(
        "set-context: rewindTo must be a {uuid, viaBoundary?} object",
      );
    }
    const ref = rewindTo as { uuid?: unknown; viaBoundary?: unknown };
    return {
      type: "set-context",
      rewindTo: {
        uuid: assertUuid(ref.uuid, "rewindTo.uuid"),
        ...(ref.viaBoundary !== undefined && {
          viaBoundary: assertUuid(ref.viaBoundary, "rewindTo.viaBoundary"),
        }),
      },
    };
  }
  if (uuids === undefined) {
    throw new Error("set-context: exactly one of uuids/rewindTo is required");
  }
  if (!Array.isArray(uuids)) {
    throw new Error("set-context: uuids must be an array");
  }
  const parsedUuids = uuids.map((uuid) => assertUuid(uuid, "uuids entry"));
  if (summaryText !== undefined) {
    if (typeof summaryText !== "string" || summaryText === "") {
      throw new Error("set-context: summaryText must be a non-empty string");
    }
  }
  if (anchor !== undefined && anchor !== "summary" && anchor !== "boundary") {
    throw new Error(
      `set-context: anchor must be "summary" or "boundary", got ${JSON.stringify(anchor)}`,
    );
  }
  return {
    type: "set-context",
    uuids: parsedUuids,
    ...(summaryText !== undefined && { summaryText }),
    ...(anchor !== undefined && { anchor }),
  };
}

export type SdkRequest =
  | {
      type: "query";
      content: string | ContentBlockParam[];
      priority?: TurnPriority;
      shouldQuery?: false;
    }
  | { type: "interrupt" }
  // Response data is the daemon's current AgentState; every event emitted
  // after it follows as an SdkEventRecord line until the connection closes.
  // No history replay — a subscriber starts at "now" and folds from there
  // (agent-state.ts).
  | { type: "subscribe" }
  // Response data is SessionMessage[] — the transcript segment since the last
  // compaction, verbatim from getSessionMessages. Reads the transcript file,
  // not the Query, so it is not an SdkControlRead.
  | { type: "get-messages" }
  // Response data: SessionEntry[] — every jsonl line of the current session,
  // verbatim.
  | { type: "get-entries" }
  // Response data: SessionTree — the session as a forest plus the
  // current-leaf occurrence (build-tree.ts).
  | { type: "get-tree" }
  // Response data: SetContextResult.
  | SetContextRequest
  | SdkControlMutation
  | SdkControlRead;

/** A pushed stream event on a subscribed connection; no `id`, unlike responses. */
export interface SdkEventRecord {
  event: SdkEvent;
}

export type SdkRequestRecord = SdkRequest & { id: string };

export type SdkResponse =
  | { id: string; ok: true; data?: unknown }
  | { id: string; ok: false; error: string };

interface PendingRequest {
  resolve: (response: SdkResponse) => void;
  reject: (error: Error) => void;
}

export class SdkSocketClient {
  private readonly socket: Socket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closedPromise: Promise<void>;
  private requestCounter = 0;
  private closed = false;
  private onEvent: ((event: SdkEvent) => void) | undefined;

  private constructor(socket: Socket) {
    this.socket = socket;
    this.closedPromise = new Promise((resolve) => {
      socket.on("close", () => {
        this.closed = true;
        const error = new Error("sdk socket closed");
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();
        resolve();
      });
    });
  }

  /** Connect and consume the hello record; rejects on a non-clauctl socket. */
  static async connect(socketPath: string): Promise<SdkSocketClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(socketPath);
      s.once("connect", () => {
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", reject);
    });

    const client = new SdkSocketClient(socket);
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
            const error = validateHello(line);
            if (error) {
              socket.destroy();
              rejectHello(error);
            } else {
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
        rejectHello(new Error("sdk socket closed before hello"));
      }
    });

    await helloPromise;
    return client;
  }

  // Routes structurally: records with an `id` resolve pending requests,
  // records with an `event` go to onEvent — so onEvent never sees responses.
  private dispatchLine(line: string): void {
    let record: { id?: string; event?: SdkEvent };
    try {
      record = JSON.parse(line) as { id?: string; event?: SdkEvent };
    } catch {
      return;
    }
    if (record.event !== undefined) {
      this.onEvent?.(record.event);
      return;
    }
    const pending =
      record.id === undefined ? undefined : this.pending.get(record.id);
    if (pending) {
      this.pending.delete(record.id!);
      pending.resolve(record as unknown as SdkResponse);
    }
  }

  /** Send a request; resolves with the response data, throws on daemon error. */
  async request(request: SdkRequest): Promise<unknown> {
    if (this.closed) {
      throw new Error("sdk socket closed");
    }
    const id = `clauctl-${++this.requestCounter}`;
    const response = await new Promise<SdkResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ ...request, id })}\n`);
    });
    if (!response.ok) {
      throw new Error(`daemon rejected ${request.type}: ${response.error}`);
    }
    return response.data;
  }

  /**
   * Turn this connection into a subscriber: onEvent fires for every
   * SdkEventRecord the daemon pushes after the returned seed state. A
   * stateful subscriber folds the events into the seed with `nextAgentState`
   * — the same fold the daemon runs, so its state always matches the
   * daemon's. Single-use per client; requests may still be sent on a
   * subscribed connection.
   *
   * The daemon writes the seed response before any event line, but response
   * resolution is a microtask while onEvent is called synchronously from the
   * data handler — so onEvent may fire before the returned promise settles.
   * Every delivered event is post-seed regardless; a caller that needs
   * strict output ordering (tail) gates on the seed itself.
   */
  async subscribe(onEvent: (event: SdkEvent) => void): Promise<AgentState> {
    if (this.onEvent !== undefined) {
      throw new Error("sdk socket client is already subscribed");
    }
    this.onEvent = onEvent;
    const data = await this.request({ type: "subscribe" });
    return data as AgentState;
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

function validateHello(line: string): Error | undefined {
  try {
    const hello = JSON.parse(line) as {
      type?: string;
      protocol?: string;
      version?: number;
    };
    if (hello.type !== "hello" || hello.protocol !== SDK_SOCKET_PROTOCOL) {
      return new Error(`not a clauctl sdk socket (got ${line.slice(0, 100)})`);
    }
    if (hello.version !== SDK_SOCKET_VERSION) {
      process.stderr.write(
        `clauctl: warning: sdk socket protocol version ${hello.version}, expected ${SDK_SOCKET_VERSION}\n`,
      );
    }
    return undefined;
  } catch {
    return new Error("first record on sdk socket was not valid JSON");
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
): Promise<SdkSocketClient> {
  const deadline = Date.now() + deadlineMs;
  let delay = 50;
  while (true) {
    try {
      return await SdkSocketClient.connect(socketPath);
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
