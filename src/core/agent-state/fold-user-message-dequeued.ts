import type { AgentEvent } from "../protocol.ts";
import type { AgentState } from "./agent-state.ts";

// Activity is unchanged: a "turn" dequeue arrives after a `result` that
// already set pending; "steer" and "append" have no activity of their own.
export function foldUserMessageDequeued(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "userMessageDequeued" }>,
): AgentState {
  const queuedMessages = state.queuedMessages.filter(
    (entry) => !event.ids.includes(entry.id),
  );
  if (event.delivery === "steer") {
    // Steered messages must not enter deliveredMessages: a steered
    // message's transcript record is its queued_command attachment
    // entry, which the session stream and the history fetch both
    // deliver — holding it here would show it twice.
    return { ...state, queuedMessages };
  }
  const byId = new Map(
    state.queuedMessages.map((entry) => [entry.id, entry.message]),
  );
  const delivered = event.ids
    .map((id) => byId.get(id))
    .filter((message) => message !== undefined);
  return {
    ...state,
    queuedMessages,
    deliveredMessages: [...state.deliveredMessages, ...delivered],
  };
}
