import type { AgentState } from "./agent-state.ts";
import { withSession } from "./session-state.ts";

export function foldScanComplete(state: AgentState): AgentState {
  const sessionId = state.fileSessionId;
  if (sessionId === undefined) return state;
  const session = state.sessions[sessionId];
  return session === undefined || !session.scanExcluded
    ? state
    : withSession(state, sessionId, { ...session, scanExcluded: false });
}
