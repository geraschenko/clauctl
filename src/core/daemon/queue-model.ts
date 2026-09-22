/**
 * The daemon's model of the CLI's user-message queue. The CLI's queue
 * operations are invisible on the live stream, but its placement behavior is
 * deterministic (echo-placement FINDINGS, Round 3), so this module tracks every
 * accepted message and decides which `userMessageQueued`/`userMessageDequeued`
 * events to emit and when. Pure state machine: the EventHub threads occurrences
 * through it and emits the returned events next to each triggering
 * occurrence.
 *
 * Daemon-only, unlike agent-state.ts: this is the *decider* that synthesizes
 * queue events from inference (`toolResultSeen`), while the fold's
 * `queuedMessages` is the *reconstruction* every observer derives from those
 * events. Merging the two would leak daemon inference into the protocol.
 */

import type { UUID } from "node:crypto";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { MessageDelivery, AgentEvent } from "../protocol.ts";

/** One accepted-but-not-yet-dequeued message in the modeled CLI queue. */
export interface QueuedMessage {
  uuid: UUID;
  message: SDKUserMessage;
  /** A tool_result has been observed since THIS message's acceptance. */
  toolResultSeen: boolean;
}

export interface QueueModelState {
  queued: QueuedMessage[];
  /** `message.id` of the last top-level `assistant` frame: the API response
   *  in progress (all its blocks share the id). A frame with another id
   *  opens the next response. */
  currentApiMessageId: string | undefined;
}

export const INITIAL_QUEUE_MODEL_STATE: QueueModelState = {
  queued: [],
  currentApiMessageId: undefined,
};

export interface QueueTransition {
  state: QueueModelState;
  /** Events to emit, in order, immediately after the triggering occurrence. */
  events: AgentEvent[];
}

/** An acceptance additionally names the message's uuid — the receipt the
 *  prompt response carries back to the submitting client. */
export interface AcceptTransition extends QueueTransition {
  uuid: UUID;
}

/** A `/command` prompt: the CLI never steers or merges one — it waits for
 *  a result and runs alone (docs/claude-agent-sdk.md, "Slash commands are
 *  turns of their own"). String content or any text block starting with
 *  `/` counts (an `--image` prompt carries its text as a block). */
function isSlashCommand(message: SDKUserMessage): boolean {
  const content = message.message.content;
  return typeof content === "string"
    ? content.startsWith("/")
    : content.some(
        (block) => block.type === "text" && block.text.startsWith("/"),
      );
}

/**
 * Subject to the demote fork: priority next/default, not a slash command.
 * Demotability also requires acceptance while not idle, but every entry
 * *resident* in the queue was accepted while not idle (idle acceptance
 * dequeues immediately), so for queued messages this is purely a function
 * of the message.
 */
function isDemotable(message: SDKUserMessage): boolean {
  return (
    (message.priority === undefined || message.priority === "next") &&
    !isSlashCommand(message)
  );
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

function dequeued(
  delivery: MessageDelivery,
  uuids: readonly [UUID, ...UUID[]],
): AgentEvent {
  return { kind: "userMessageDequeued", delivery, uuids };
}

/**
 * Accept a turn from a client; emits `userMessageQueued` (plus the immediate
 * dequeue when idle — the message runs, or is appended, right away).
 * `message.uuid` is the prompt's uuid: the hub stamps it before delivery,
 * so the delivered message and the modeled one are the same object; an
 * unstamped message is a daemon bug. `eventUuid` is the queued event's
 * own merge node, distinct from the prompt's (which the dequeue observes).
 */
export function acceptUserMessage(
  state: QueueModelState,
  message: SDKUserMessage,
  isIdle: boolean,
  eventUuid: UUID,
): AcceptTransition {
  const uuid = message.uuid;
  if (uuid === undefined) {
    throw new Error("acceptUserMessage: message has no uuid");
  }
  const queuedEvent: AgentEvent = {
    kind: "userMessageQueued",
    uuid: eventUuid,
    message,
  };
  if (isIdle) {
    return {
      uuid,
      state,
      events: [
        queuedEvent,
        dequeued(isQuerying(message) ? "turn" : "append", [uuid]),
      ],
    };
  }
  return {
    uuid,
    state: {
      ...state,
      queued: [...state.queued, { uuid, message, toolResultSeen: false }],
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

/** Subagent traffic (`parent_tool_use_id` a string) never marks or steers:
 *  a steer bundles with the next outgoing API request of the agent it is
 *  directed at, the main agent, so a subagent's requests and results
 *  cannot absorb it — only the top-level response that follows the
 *  subagent's `Task` result can. */
function isTopLevel(message: SDKMessage): boolean {
  return "parent_tool_use_id" in message && message.parent_tool_use_id === null;
}

/**
 * Fold an observed SDK message into the model; emits any dequeues it implies
 * (at most one). Where the hub places it relative to the message's own
 * `sdkMessage` event is the hub's protocol commitment: a steer precedes its
 * trigger, a turn/append follows its result.
 */
export function observeSdkMessage(
  state: QueueModelState,
  message: SDKMessage,
): QueueTransition {
  // A tool_result block marks every currently queued demotable message: the
  // FINDINGS rule is "what follows the first tool_result AFTER acceptance",
  // so the marker is per message, not global — a straggler accepted between a
  // tool_result and the following response waits for its own boundary.
  if (
    message.type === "user" &&
    isTopLevel(message) &&
    hasToolResult(message)
  ) {
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

  // The next API response after a tool_result: the CLI removed the marked
  // demotable messages from its queue and delivered them as
  // <system-reminder>s with the LAST tool result of the response that issued
  // the calls; they never run as turns. Each gets its own attachment entry
  // (filed before the next response's first entry), so each is its own
  // dequeue. Later blocks of the same response (same `message.id`) are not
  // a boundary: their tool results are still to come.
  if (message.type === "assistant" && isTopLevel(message)) {
    if (message.message.id === state.currentApiMessageId) {
      return { state, events: [] };
    }
    const steered = state.queued.filter(
      (entry) => isDemotable(entry.message) && entry.toolResultSeen,
    );
    return {
      state: {
        ...state,
        queued: state.queued.filter((entry) => !steered.includes(entry)),
        currentApiMessageId: message.message.id,
      },
      events: steered.map((entry) => dequeued("steer", [entry.uuid])),
    };
  }

  // A result ends the running turn; the CLI dequeues one run of the
  // highest-priority bucket present (docs/claude-agent-sdk.md, "Queued
  // prompts coalesce by run"): an append (shouldQuery:false) at the head is
  // a run of its own, entering the transcript with no turn; a slash command
  // at the head is a run of its own turn; otherwise the head's maximal
  // prefix of querying non-command members merges into one turn with one
  // future result. The rest of the bucket waits for that result, and the
  // bucket is recomputed then — a higher priority accepted meanwhile cuts
  // ahead.
  if (message.type === "result" && state.queued.length > 0) {
    const topRank = Math.min(
      ...state.queued.map((entry) => priorityRank(entry.message)),
    );
    const bucket = state.queued.filter(
      (entry) => priorityRank(entry.message) === topRank,
    );
    const [head, ...tail] = bucket as [QueuedMessage, ...QueuedMessage[]];
    const run = nextRun(head, tail);
    return {
      state: {
        ...state,
        queued: state.queued.filter((entry) => !run.includes(entry)),
      },
      events: [
        dequeued(isQuerying(head.message) ? "turn" : "append", [
          head.uuid,
          ...run.slice(1).map((entry) => entry.uuid),
        ]),
      ],
    };
  }

  return { state, events: [] };
}

/** Whether a queued message merges with its querying neighbours. */
function isMergeable(message: SDKUserMessage): boolean {
  return isQuerying(message) && !isSlashCommand(message);
}

/** The run at the head of a bucket: an append or a slash command alone,
 *  otherwise the maximal prefix of mergeable members. */
function nextRun(head: QueuedMessage, tail: QueuedMessage[]): QueuedMessage[] {
  if (!isMergeable(head.message)) {
    return [head];
  }
  const firstCut = tail.findIndex((entry) => !isMergeable(entry.message));
  return [head, ...(firstCut === -1 ? tail : tail.slice(0, firstCut))];
}
