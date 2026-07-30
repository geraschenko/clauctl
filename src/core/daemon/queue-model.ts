/**
 * The daemon's model of the CLI's user-message queue. The CLI's queue
 * operations are invisible on the live stream, but its placement behavior is
 * deterministic (echo-placement FINDINGS, Round 3), so this module tracks every
 * accepted message and decides which `userMessageQueued`/`userMessageDequeued`
 * events to emit and when. Pure state machine: the EventHub threads occurrences
 * through it and emits the returned events immediately after each triggering
 * occurrence.
 *
 * Daemon-only, unlike agent-state.ts: this is the *decider* that synthesizes
 * queue events from inference (`toolResultSeen`), while the fold's
 * `queuedMessages` is the *reconstruction* every observer derives from those
 * events. Merging the two would leak daemon inference into the protocol.
 */

import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { MessageDelivery, SdkEvent } from "../sdk-socket.ts";

/** One accepted-but-not-yet-dequeued message in the modeled CLI queue. */
export interface QueuedMessage {
  id: number;
  message: SDKUserMessage;
  /** A tool_result has been observed since THIS message's acceptance. */
  toolResultSeen: boolean;
}

export interface QueueModelState {
  nextId: number;
  queued: QueuedMessage[];
}

export const INITIAL_QUEUE_MODEL_STATE: QueueModelState = {
  nextId: 1,
  queued: [],
};

export interface QueueTransition {
  state: QueueModelState;
  /** Events to emit, in order, immediately after the triggering occurrence. */
  events: SdkEvent[];
}

/** An acceptance additionally names the id it assigned — the receipt the
 *  prompt response carries back to the submitting client. */
export interface AcceptTransition extends QueueTransition {
  id: number;
}

/**
 * Subject to the demote fork: priority next/default. Demotability also
 * requires acceptance while not idle, but every entry *resident* in the queue
 * was accepted while not idle (idle acceptance dequeues immediately), so for
 * queued messages this is purely a function of priority.
 */
function isDemotable(message: SDKUserMessage): boolean {
  return message.priority === undefined || message.priority === "next";
}

/** `shouldQuery !== false` — whether this message predicts a future result. */
function isQuerying(message: SDKUserMessage): boolean {
  return message.shouldQuery !== false;
}

/** Dequeue order at a `result`: highest-priority bucket present drains first. */
function priorityRank(message: SDKUserMessage): number {
  switch (message.priority) {
    case "now":
      return 0;
    case "later":
      return 2;
    // "next" and default share a bucket: while not idle both are demotable, and
    // at a result they merge into the same turn.
    default:
      return 1;
  }
}

function dequeued(delivery: MessageDelivery, ids: number[]): SdkEvent {
  return { kind: "userMessageDequeued", delivery, ids };
}

/**
 * Accept a turn from a client; emits `userMessageQueued` (plus the immediate
 * dequeue when idle — the message runs, or is appended, right away).
 */
export function acceptUserMessage(
  state: QueueModelState,
  message: SDKUserMessage,
  isIdle: boolean,
): AcceptTransition {
  const id = state.nextId;
  const queuedEvent: SdkEvent = { kind: "userMessageQueued", id, message };
  if (isIdle) {
    return {
      id,
      state: { ...state, nextId: id + 1 },
      events: [
        queuedEvent,
        dequeued(isQuerying(message) ? "turn" : "append", [id]),
      ],
    };
  }
  return {
    id,
    state: {
      nextId: id + 1,
      queued: [...state.queued, { id, message, toolResultSeen: false }],
    },
    events: [queuedEvent],
  };
}

function hasToolResult(message: SDKUserMessage): boolean {
  const content = message.message.content;
  return (
    Array.isArray(content) &&
    content.some((block) => block.type === "tool_result")
  );
}

/**
 * Fold an observed SDK message into the model; emits any dequeues it implies.
 * The daemon emits the message's own `sdkMessage` event first, then these —
 * dequeues follow their trigger on the stream.
 */
export function observeSdkMessage(
  state: QueueModelState,
  message: SDKMessage,
): QueueTransition {
  // A tool_result block marks every currently queued demotable message: the
  // FINDINGS rule is "what follows the first tool_result AFTER acceptance",
  // so the marker is per message, not global — a straggler accepted between a
  // tool_result and the following assistant activity waits for its own
  // boundary.
  if (message.type === "user" && hasToolResult(message)) {
    return {
      state: {
        ...state,
        queued: state.queued.map((entry) =>
          isDemotable(entry.message) && !entry.toolResultSeen
            ? { ...entry, toolResultSeen: true }
            : entry,
        ),
      },
      events: [],
    };
  }

  // Assistant activity after a tool_result: the CLI removed the marked
  // demotable messages from its queue and delivered them as
  // <system-reminder>s inside that tool result; they never run as turns.
  if (message.type === "assistant" || message.type === "stream_event") {
    const steered = state.queued.filter(
      (entry) => isDemotable(entry.message) && entry.toolResultSeen,
    );
    if (steered.length === 0) {
      return { state, events: [] };
    }
    return {
      state: {
        ...state,
        queued: state.queued.filter((entry) => !steered.includes(entry)),
      },
      events: [
        dequeued(
          "steer",
          steered.map((entry) => entry.id),
        ),
      ],
    };
  }

  // A result ends the running turn; the CLI consumes the highest-priority
  // bucket present, all of it, as one merged turn with one future result
  // (FINDINGS: same-priority executing messages merge FIFO into a single
  // turn). A bucket of only shouldQuery:false messages enters the transcript
  // with no turn of its own.
  if (message.type === "result" && state.queued.length > 0) {
    const topRank = Math.min(
      ...state.queued.map((entry) => priorityRank(entry.message)),
    );
    const bucket = state.queued.filter(
      (entry) => priorityRank(entry.message) === topRank,
    );
    return {
      state: {
        ...state,
        queued: state.queued.filter((entry) => !bucket.includes(entry)),
      },
      events: [
        dequeued(
          bucket.some((entry) => isQuerying(entry.message)) ? "turn" : "append",
          bucket.map((entry) => entry.id),
        ),
      ],
    };
  }

  return { state, events: [] };
}
