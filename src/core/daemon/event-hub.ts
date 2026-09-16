import type { UUID } from "node:crypto";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  describeSession,
  isIdle,
  nextAgentState,
  SETTLE_TIMEOUT_MS,
  sessionSettled,
  settled,
  type AgentState,
} from "../agent-state.ts";
import type { AgentEvent } from "../protocol.ts";
import type { AnomalyRecorder } from "./anomaly-bundle.ts";
import * as QueueModel from "./queue-model.ts";
import type { SessionTracker } from "./session-tracker.ts";

export interface EventHubOptions {
  /**
   * The state before the first event — the same seed-then-fold contract
   * subscribers follow. The daemon composes it from initialAgentState() and
   * the options/settings cascade (daemon.ts). Must be quiescent — idle with
   * empty queuedMessages/deliveredMessages — because the hub's queue model
   * always starts fresh; the constructor asserts this rather than silently
   * overwriting, so a disagreeing seed is a loud bug.
   */
  seed: AgentState;
  /**
   * Hands an accepted message to the SDK (wired to turnQueue.push). Called by
   * deliverUserMessage before the queued events are emitted, preserving the
   * push-before-emit order. Must not throw: the hub emits the queued events
   * assuming the push succeeded, so a throw after the side effect would leave
   * a delivered-but-unmodeled message (TurnQueue.push is non-throwing).
   */
  deliver: (message: SDKUserMessage) => void;
  /** The tracked file's tracker, read only at the dedup site. */
  tracker: () => SessionTracker | undefined;
  log: (message: string) => void;
  anomalies: AnomalyRecorder;
}

/** A pending settle wait: re-checked after every fold, rejected by its
 *  timer with `describe(state)` naming what is still pending. */
interface SettleWaiter {
  readonly condition: (state: AgentState) => boolean;
  readonly describe: (state: AgentState) => string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * The daemon's only mutable object for observable state — the single point
 * where every occurrence becomes an ordered event and its effects (broadcast,
 * state fold, queue model) are applied in one synchronous step. The heavy
 * logic lives in pure modules (agent-state.ts's fold, queue-model.ts's
 * decider); the hub is the atomic composition point: broadcast + fold + queue
 * model are one object because the emit/fold atomicity and model/queue
 * lockstep invariants need a single owner. State is a function of the
 * emitted stream by construction — an observer seeded with `agentState` can
 * always reconstruct it by running the same fold.
 *
 * The public surface keeps the invariants out of callers' hands: user/SDK
 * messages go through deliverUserMessage/observeSdkMessage so the queue
 * model sees them (the SDK never reports when a user message enters
 * context); everything else — daemon actions and session entries alike —
 * goes through `emit`; the constructor asserts a quiescent seed, so the
 * state and the fresh queue model cannot start in disagreement; the deliver
 * callback runs inside `deliverUserMessage`, so a delivered-but-unmodeled
 * (or modeled-but-undelivered) message cannot exist. The residue is
 * convention: `agentState` is shallow-readonly (nested SDK payloads are
 * immutable by convention — agent-state.ts), and the deliver and sink
 * callbacks carry the behavioral contracts documented on them.
 *
 * Anomaly reporting lives here, not in the fold: a fold whose state carries
 * `anomaly` is logged at error and written as a diagnostic bundle.
 *
 * Events emitted while no subscriber is connected are observable only through
 * their effects (agent state, agent.json, session JSONL).
 */
export class EventHub {
  private state: AgentState;
  private queueModel: QueueModel.QueueModelState =
    QueueModel.INITIAL_QUEUE_MODEL_STATE;
  private readonly deliver: (message: SDKUserMessage) => void;
  private readonly tracker: () => SessionTracker | undefined;
  private readonly log: (message: string) => void;
  private readonly anomalies: AnomalyRecorder;
  private readonly sinks = new Set<(event: AgentEvent) => void>();
  private readonly waiters = new Set<SettleWaiter>();

  constructor(options: EventHubOptions) {
    this.deliver = options.deliver;
    this.tracker = options.tracker;
    this.log = options.log;
    this.anomalies = options.anomalies;
    const seed = options.seed;
    if (
      seed.activity !== "idle" ||
      seed.queuedMessages.length > 0 ||
      seed.deliveredMessages.length > 0
    ) {
      throw new Error(
        "EventHub seed must be quiescent (idle, empty queues): the fresh queue model would disagree with it",
      );
    }
    this.state = seed;
  }

  get agentState(): AgentState {
    return this.state;
  }

  /**
   * Attach a subscriber sink; returns the unsubscribe function. Sinks receive
   * every event, post-fold, in order. Sinks must not throw
   * (the only production sink is protocol-server's guarded connection.write) — a
   * throwing sink would starve later sinks after the state has already
   * folded. Sinks must not call back into the hub either: a reentrant
   * delivery would interleave between an sdkMessage and the dequeues it
   * implies.
   */
  subscribe(sink: (event: AgentEvent) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /**
   * Events with no queue-model involvement, session entries included.
   * Anything else must go through deliverUserMessage/observeSdkMessage.
   */
  emit(
    event: Extract<
      AgentEvent,
      {
        kind:
          | "interruptSent"
          | "compactSent"
          | "controlApplied"
          | "shutdown"
          | "sessionEntry"
          | "contextChanged"
          | "sessionFileChanged"
          | "scanComplete"
          | "sessionAppended"
          | "trackerAnomaly";
      }
    >,
  ): void {
    this.applyEvent(event);
  }

  /**
   * Deliver a user message to the SDK (via the deliver callback) and advance
   * the queue model, emitting the queued/dequeued events — one atomic step,
   * so the model/queue lockstep is owned here, not by calling convention.
   * Returns the queue-model id the acceptance assigned — the receipt that
   * lets the submitter recognize its own dequeue on the event stream.
   */
  deliverUserMessage(message: SDKUserMessage): number {
    this.deliver(message);
    const transition = QueueModel.acceptUserMessage(
      this.queueModel,
      message,
      isIdle(this.state),
    );
    this.applyTransition(transition);
    return transition.id;
  }

  /** Dedup first (merge model, Query-stream duplicates): a repeat of a
   *  uuid the tracked file's index holds and the merge has resolved is
   *  dropped — silently for a shared class, as a `classification`
   *  anomaly for a session-only one (the table said the query stream
   *  would not carry it). Otherwise emit the sdkMessage event plus any
   *  dequeues the queue model implies. */
  observeSdkMessage(message: SDKMessage): void {
    if (message.uuid !== undefined) {
      const uuid = message.uuid as UUID;
      const sessionId = message.session_id as UUID;
      const indexed =
        sessionId === this.state.fileSessionId
          ? this.tracker()?.index.get(uuid)
          : undefined;
      if (
        indexed !== undefined &&
        !Object.hasOwn(this.state.sessions[sessionId]?.merge.nodes ?? {}, uuid)
      ) {
        if (!indexed.expectsSdkMessage) {
          this.applyEvent({
            kind: "trackerAnomaly",
            anomaly: {
              kind: "classification",
              detail: `${message.type} ${uuid} on query: classified session-only, but the query stream carried it`,
            },
          });
        }
        return;
      }
    }
    this.applyEvent({ kind: "sdkMessage", message });
    // Dequeues follow their trigger: the model observes the message after its
    // own sdkMessage event is on the stream, so any userMessageDequeued it
    // implies lands immediately after.
    this.applyTransition(
      QueueModel.observeSdkMessage(this.queueModel, message),
    );
  }

  /** Resolves when settled(agentState) — immediately if already; rejects
   *  after SETTLE_TIMEOUT_MS naming the query file's pending("query"). */
  whenSettled(): Promise<void> {
    return this.awaitState(settled, (state) =>
      state.querySessionId === undefined
        ? "no query file"
        : `query file ${state.querySessionId}: ${describeSession(state.sessions[state.querySessionId])}`,
    );
  }

  /** Resolves when `sessionSettled(sessions[sessionId])` (the switch's wait on
   *  the old file); same bound as whenSettled. */
  whenFileSettled(sessionId: UUID): Promise<void> {
    return this.awaitState(
      (state) => {
        const session = state.sessions[sessionId];
        return session !== undefined && sessionSettled(session);
      },
      (state) =>
        `file ${sessionId}: ${describeSession(state.sessions[sessionId])}`,
    );
  }

  private awaitState(
    condition: (state: AgentState) => boolean,
    describe: (state: AgentState) => string,
  ): Promise<void> {
    if (condition(this.state)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: SettleWaiter = {
        condition,
        describe,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new Error(
              `not settled after ${SETTLE_TIMEOUT_MS} ms; ${describe(this.state)}`,
            ),
          );
        }, SETTLE_TIMEOUT_MS).unref(),
      };
      this.waiters.add(waiter);
    });
  }

  private applyTransition(transition: QueueModel.QueueTransition): void {
    this.queueModel = transition.state;
    for (const event of transition.events) {
      this.applyEvent(event);
    }
  }

  // Per-event ordering: fold state, report an anomaly, write sinks, then
  // settle waiters — a synchronous sink sees post-event state. The anomaly
  // needs no event of its own: sinks fold the same event and compute it
  // (spec, Anomalies); daemon-detected ones arrive here as trackerAnomaly.
  private applyEvent(event: AgentEvent): void {
    const before = this.state;
    this.state = nextAgentState(before, event);
    this.anomalies.record(event);
    if (this.state.anomaly !== undefined) {
      const bundle = this.anomalies.write(
        this.state.anomaly,
        before,
        this.state,
      );
      this.log(
        `error: tracker anomaly ${this.state.anomaly.kind}: ${this.state.anomaly.detail} (bundle: ${bundle})`,
      );
    }
    for (const sink of this.sinks) {
      sink(event);
    }
    for (const waiter of this.waiters) {
      if (waiter.condition(this.state)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
}
