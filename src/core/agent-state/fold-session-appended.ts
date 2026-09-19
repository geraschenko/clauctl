import type { UUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "./agent-state.ts";
import { classOf } from "./classification.ts";
import { observeOn } from "./observe-on.ts";
import { freshSessionState, withSession } from "./session-state.ts";
import { withAnomalies } from "./tracker-anomaly.ts";

/** A daemon-appended entry (set-context) is a query action item on the
 *  query file; its log entry resolves it. */
export function foldSessionAppended(
  state: AgentState,
  message: SDKMessage,
): AgentState {
  const sessionId = state.querySessionId;
  if (sessionId === undefined || message.uuid === undefined) return state;
  const observation = observeOn(
    state.sessions[sessionId] ?? freshSessionState(),
    "query",
    message.uuid as UUID,
    classOf(message),
    false,
  );
  return withAnomalies(
    withSession(state, sessionId, observation.session),
    observation.anomalies,
  );
}
