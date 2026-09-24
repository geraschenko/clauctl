import type { UUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "../protocol/index.ts";
import { isQuerying } from "./selectors.ts";

export function withQueuedMessage(
  state: AgentState,
  uuid: UUID,
  message: SDKUserMessage,
): AgentState {
  const queuedMessages = [...state.queuedMessages, { uuid, message }];
  // Gated on activity, not isIdle: idle is the only activity a queued
  // message changes, and if the activity invariant were ever violated
  // (idle with querying messages queued), setting pending repairs it
  // where an isIdle gate would preserve the corruption.
  const activity =
    isQuerying(message) && state.activity === "idle"
      ? "pending"
      : state.activity;
  return { ...state, activity, queuedMessages };
}
