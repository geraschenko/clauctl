import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "./agent-state.ts";
import { isQuerying } from "./selectors.ts";

export function foldUserMessageQueued(
  state: AgentState,
  id: number,
  message: SDKUserMessage,
): AgentState {
  const queuedMessages = [...state.queuedMessages, { id, message }];
  // Gated on activity, not isIdle: idle is the only activity a queued
  // message changes, and if the activity invariant were ever violated
  // (idle with querying messages queued), setting pending repairs it
  // where an isIdle gate would preserve the corruption.
  return isQuerying(message) && state.activity === "idle"
    ? { ...state, activity: "pending", queuedMessages }
    : { ...state, queuedMessages };
}
