/**
 * The `sdk.sock` protocol and its client: newline-delimited JSON over a unix
 * socket. Three record shapes flow daemon→client, distinguished structurally:
 * the hello (first line on connect, so clients can validate they are talking
 * to a clauctl daemon), responses (have an `id`), and pushed events (`{ event:
 * SdkEvent }`, only on connections that sent `subscribe`).
 */

import { connect, type Socket } from "node:net";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type {
  McpServerConfig,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { AssistantState } from "./assistant-state.ts";

export const SDK_SOCKET_PROTOCOL = "clauctl-sdk-socket";
export const SDK_SOCKET_VERSION = 1;

export type MessageDelivery = "turn" | "steer" | "append";

/**
 * The augmented event stream (DECISION-6): every SDK message, plus the events
 * only the daemon can know about, serialized so an observer can follow what is
 * happening. This is protocol: the daemon's event bus writes exactly this
 * stream to every subscriber, and the assistant-state tracker folds over the
 * same stream — so daemon state is always reconstructible by an observer.
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
  | { kind: "controlApplied"; request: SdkControlMutation }
  | { kind: "sdkMessage"; message: SDKMessage };

export type TurnPriority = "now" | "next" | "later";

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
  | {
      type: "apply-flag-settings";
      settings: { [K in keyof Settings]?: Settings[K] | null };
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

export type SdkRequest =
  | {
      type: "query";
      content: string | ContentBlockParam[];
      priority?: TurnPriority;
      shouldQuery?: false;
    }
  | { type: "interrupt" }
  // Resolves once the assistant is Idle; the polite-stop path (archive) waits
  // on this instead of polling.
  | { type: "wait-idle" }
  // Response data is a StateSnapshot; every event emitted after it follows as
  // an SdkEventRecord line until the connection closes. No history replay — a
  // subscriber starts at "now".
  | { type: "subscribe" }
  // Response data is SessionMessage[] — the transcript segment since the last
  // compaction, verbatim from getSessionMessages. Reads the transcript file,
  // not the Query, so it is not an SdkControlRead.
  | { type: "get-messages" }
  | SdkControlMutation
  | SdkControlRead;

/** A pushed stream event on a subscribed connection; no `id`, unlike responses. */
export interface SdkEventRecord {
  event: SdkEvent;
}

/** What a subscriber starts from; no history replay. */
export interface StateSnapshot {
  assistantState: AssistantState;
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  observedPermissionModes?: PermissionMode[];
  cwd?: string;
  /**
   * Queued-but-undelivered messages (present when non-empty). These live only
   * in the daemon's queue model — not in the transcript — so the snapshot is
   * the only way an attaching observer learns their content.
   */
  queuedMessages?: { id: number; message: SDKUserMessage }[];
  /**
   * The attach boundary: uuid of the last user/assistant sdkMessage emitted
   * this daemon lifetime (absent if none). Transcript entries at/before it
   * were emitted before this snapshot — the subscriber never saw them;
   * everything after arrives on the live stream. History replay renders up
   * to the boundary and no further, making the overlap window render-once
   * without any dedupe.
   */
  lastTranscriptUuid?: string;
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
   * SdkEventRecord the daemon pushes after the snapshot. Single-use per
   * client; requests may still be sent on a subscribed connection.
   *
   * The daemon writes the snapshot response before any event line, but
   * response resolution is a microtask while onEvent is called synchronously
   * from the data handler — so onEvent may fire before the returned promise
   * settles. Every delivered event is post-snapshot regardless; a caller that
   * needs strict output ordering (tail) gates on the snapshot itself.
   */
  async subscribe(onEvent: (event: SdkEvent) => void): Promise<StateSnapshot> {
    if (this.onEvent !== undefined) {
      throw new Error("sdk socket client is already subscribed");
    }
    this.onEvent = onEvent;
    const data = await this.request({ type: "subscribe" });
    return data as StateSnapshot;
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

export class IdleTimeoutError extends Error {}

/**
 * Wait until the assistant is Idle via the daemon's wait-idle request. The
 * daemon responds when idle; the timeout is enforced client-side.
 */
export async function waitIdle(
  client: SdkSocketClient,
  timeoutMs: number | undefined,
): Promise<void> {
  // Waiting is delegated to the daemon rather than monitored client-side: the
  // daemon owns the state fold, so its whenIdle is an atomic check-or-enqueue
  // with no gap between "read current state" and "watch for transitions" —
  // the race a subscribe-then-fold client would have to close itself. Nothing
  // is sent to the claude process either way.
  const idle = client.request({ type: "wait-idle" });
  if (timeoutMs === undefined) {
    await idle;
    return;
  }
  // The timer must be cleared after the race: a pending timer is an active
  // handle that keeps node's event loop (and thus the CLI process) alive
  // until it fires, even though the losing promise is discarded.
  let timeoutTimer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const winner = await Promise.race([
    idle.then(() => "idle" as const),
    timeout,
  ]);
  clearTimeout(timeoutTimer);
  if (winner === "timeout") {
    throw new IdleTimeoutError();
  }
}
