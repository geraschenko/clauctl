import {
  INITIAL_ASSISTANT_STATE,
  nextAssistantState,
  type AssistantState,
} from "../assistant-state.ts";
import { type SdkEvent } from "../sdk-socket.ts";

/**
 * The daemon's single mutation path for observable assistant state. `emit`
 * atomically serializes the event to every subscribed sink and folds it into
 * the state tracker, so state is a function of the emitted stream by
 * construction — an observer holding a StateSnapshot can always reconstruct
 * it by running the same fold. Nothing outside this class may update the
 * tracker: request handlers and the stream reader only have `emit`, making an
 * applied-but-never-emitted event unrepresentable.
 *
 * Events emitted while no subscriber is connected are observable only through
 * their effects (state snapshot, agent.json, session JSONL).
 */
export class EventBus {
  private state: AssistantState = INITIAL_ASSISTANT_STATE;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly sinks = new Set<(serializedEventRecord: string) => void>();

  get assistantState(): AssistantState {
    return this.state;
  }

  /** Attach a subscriber sink; returns the unsubscribe function. */
  subscribe(sink: (serializedEventRecord: string) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  emit(event: SdkEvent): void {
    // Serialized once as an SdkEventRecord line, written to every sink.
    const line = `${JSON.stringify({ event })}\n`;
    for (const sink of this.sinks) {
      sink(line);
    }
    this.state = nextAssistantState(this.state, event);
    if (this.state.activity === "idle") {
      for (const waiter of this.idleWaiters.splice(0)) {
        waiter();
      }
    }
  }

  /** Resolves once the assistant is Idle (immediately if it already is). */
  whenIdle(): Promise<void> {
    if (this.state.activity === "idle") {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
