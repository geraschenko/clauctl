import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isBusy, nextAgentState, type AgentState } from "../agent-state.ts";
import * as QueueModel from "./queue-model.ts";
import { type SdkEvent } from "../sdk-socket.ts";

export interface EventHubOptions {
  /**
   * The state before the first event — the same seed-then-fold contract
   * subscribers follow. The daemon composes it from INITIAL_AGENT_STATE, the
   * session file, and the options/settings cascade (daemon.ts). Must be
   * quiescent — idle with empty queuedMessages/deliveredMessages — because
   * the hub's queue model always starts fresh; the constructor asserts this
   * rather than silently overwriting, so a disagreeing seed is a loud bug.
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
}

/**
 * The daemon's only mutable object for observable state — the single point
 * where every occurrence becomes an ordered event and its effects (broadcast,
 * state fold, queue model, waiter wakeup) are applied in one synchronous
 * step. The heavy logic lives in pure modules (agent-state.ts's fold,
 * queue-model.ts's decider); the hub is the atomic composition point:
 * broadcast + fold + queue model are one object because the emit/fold
 * atomicity and model/queue lockstep invariants need a single owner. State is
 * a function of the emitted stream by construction — an observer seeded with
 * `agentState` can always reconstruct it by running the same fold.
 *
 * The public surface keeps the invariants out of callers' hands: `emit` is
 * typed to the simple-event subset, so raw sdkMessage or queued/dequeued
 * events cannot bypass the queue model; the constructor asserts a quiescent
 * seed, so the state and the fresh queue model cannot start in disagreement;
 * the deliver callback runs inside `deliverUserMessage`, so a
 * delivered-but-unmodeled (or modeled-but-undelivered) message cannot exist.
 * The residue is convention: `agentState` is shallow-readonly (nested SDK
 * payloads are immutable by convention — agent-state.ts), and the deliver
 * and sink callbacks carry the behavioral contracts documented on them.
 *
 * Events emitted while no subscriber is connected are observable only through
 * their effects (agent state, agent.json, session JSONL).
 */
export class EventHub {
  private state: AgentState;
  private queueModel: QueueModel.QueueModelState =
    QueueModel.INITIAL_QUEUE_MODEL_STATE;
  private readonly deliver: (message: SDKUserMessage) => void;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly sinks = new Set<(serializedEventRecord: string) => void>();

  constructor(options: EventHubOptions) {
    this.deliver = options.deliver;
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
   * Attach a subscriber sink; returns the unsubscribe function. Sinks must
   * not throw (the only production sink is sdk-server's guarded
   * connection.write) — a throwing sink would starve later sinks and idle
   * waiters after the state has already folded. Sinks must not call back
   * into the hub either: a reentrant delivery would interleave between an
   * sdkMessage and the dequeues it implies.
   */
  subscribe(sink: (serializedEventRecord: string) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /**
   * Events with no queue-model involvement. Anything else must go through
   * deliverUserMessage/observeSdkMessage.
   */
  emit(
    event: Extract<
      SdkEvent,
      {
        kind:
          "interruptSent" | "compactSent" | "controlApplied" | "contextChanged";
      }
    >,
  ): void {
    this.applyEvent(event);
  }

  /**
   * Deliver a user message to the SDK (via the deliver callback) and advance
   * the queue model, emitting the queued/dequeued events — one atomic step,
   * so the model/queue lockstep is owned here, not by calling convention.
   */
  deliverUserMessage(message: SDKUserMessage): void {
    this.deliver(message);
    this.applyTransition(
      QueueModel.acceptUserMessage(
        this.queueModel,
        message,
        isBusy(this.state),
      ),
    );
  }

  /** Emit the sdkMessage event plus any dequeues the queue model implies. */
  observeSdkMessage(message: SDKMessage): void {
    this.applyEvent({ kind: "sdkMessage", message });
    // Dequeues follow their trigger: the model observes the message after its
    // own sdkMessage event is on the stream, so any userMessageDequeued it
    // implies lands immediately after.
    this.applyTransition(
      QueueModel.observeSdkMessage(this.queueModel, message),
    );
  }

  /** Resolves once activity is idle (immediately if it already is). */
  whenIdle(): Promise<void> {
    if (this.state.activity === "idle") {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private applyTransition(transition: QueueModel.QueueTransition): void {
    this.queueModel = transition.state;
    for (const event of transition.events) {
      this.applyEvent(event);
    }
  }

  // Per-event ordering: fold state, then write sinks, then wake idle waiters
  // — any synchronous observer (a sink, a woken waiter) sees post-event state.
  private applyEvent(event: SdkEvent): void {
    this.state = nextAgentState(this.state, event);
    const line = `${JSON.stringify({ event })}\n`;
    for (const sink of this.sinks) {
      sink(line);
    }
    if (this.state.activity === "idle") {
      for (const waiter of this.idleWaiters.splice(0)) {
        waiter();
      }
    }
  }
}
