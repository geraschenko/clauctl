import { connect, type Socket } from "node:net";
import { nextAgentState } from "../agent-state/index.ts";
import { AsyncQueue } from "../generated/streaming/async-queue.ts";
import type {
  StreamEvent,
  StreamSubscription,
} from "../generated/streaming/driver.ts";
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type AgentEvent,
  type AgentState,
  type ProtocolRequest,
  type ProtocolResponse,
  type SubscribeAttachment,
} from "../protocol/index.ts";

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

  /** Connect and consume the hello record; rejects on a non-clauctl socket
   *  or a daemon speaking another protocol version. */
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
            const helloError = validateHello(line);
            if (helloError === undefined) {
              resolveHello();
            } else {
              socket.destroy();
              rejectHello(helloError);
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

/** The error that makes connect() reject; undefined for a matching hello.
 *  A version mismatch is fatal: the daemon and client builds differ, so
 *  request and snapshot shapes may not line up. */
function validateHello(line: string): Error | undefined {
  try {
    const hello = JSON.parse(line) as {
      type?: string;
      protocol?: string;
      version?: number;
    };
    if (hello.type !== "hello" || hello.protocol !== PROTOCOL_NAME) {
      return new Error(
        `not a clauctl agent socket (got ${line.slice(0, 100)})`,
      );
    }
    if (hello.version !== PROTOCOL_VERSION) {
      return new Error(
        `clauctl protocol version ${hello.version}, expected ${PROTOCOL_VERSION} — daemon and client builds differ; revive or re-spawn the agent`,
      );
    }
    return undefined;
  } catch {
    return new Error("first record on agent socket was not valid JSON");
  }
}
