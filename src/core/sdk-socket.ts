/**
 * The minimal Phase-1 `sdk.sock` protocol and its client: newline-delimited
 * JSON request/response over a unix socket. No stream fan-out — the daemon's
 * SDKMessage stream is observed via daemon.log until Phase 2 grows this into
 * the full protocol.
 * TDC: Ok, I understand. This is why you had to use applyEvent the way you did in src/core/daemon.ts. Let's make sure we fix it in phase 2.
 *
 * The daemon sends a hello record on connect so clients can validate they are
 * talking to a clauctl daemon (and, in Phase 2, negotiate the protocol).
 */

import { connect, type Socket } from "node:net";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export const SDK_SOCKET_PROTOCOL = "clauctl-sdk-socket";
export const SDK_SOCKET_VERSION = 1;

// TDC: shouldn't SdkEvent be in this file? That is logically part of the protocol this file is defining.

export type SdkRequest =
  | { type: "query"; text: string; priority?: "now" | "next" | "later" }
  | { type: "interrupt" }
  | { type: "set-model"; model?: string }
  | { type: "set-permission-mode"; mode: PermissionMode }
  // Resolves once the assistant is Idle; the polite-stop path (archive) waits
  // on this instead of polling.
  | { type: "wait-idle" };

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

  private dispatchLine(line: string): void {
    let record: { id?: string };
    try {
      record = JSON.parse(line) as { id?: string };
    } catch {
      return;
    }
    const pending =
      record.id === undefined ? undefined : this.pending.get(record.id);
    if (pending) {
      this.pending.delete(record.id!);
      pending.resolve(record as SdkResponse);
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
  // TDC: should this ultimately exist as an rpc request? My feeling is that waiting for idle is something that should just involve _monitoring_ the event stream, rather than sending requests. On the other hand, I guess we do have to send a request to get the current state, and then watch the event stream to do state updates until it becomes idle. And the way this rpc request is implemented is effectively delegating all that work to the daemon (including maintaining the assistant state, so literally _nothing_ needs to be sent to the claude process itself). That makes me think this is indeed the correct design, but I'd like to hear your thoughts. Should we implement the same approach in pictl? Right now we make an actual get-state request in waitIdle in pictl.
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
