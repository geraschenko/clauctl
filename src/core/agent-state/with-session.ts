import type { UUID } from "node:crypto";
import type { AgentState, SessionState } from "../protocol/index.ts";

export function withSession(
  state: AgentState,
  sessionId: UUID,
  session: SessionState,
): AgentState {
  return { ...state, sessions: { ...state.sessions, [sessionId]: session } };
}

export function withoutFile(
  state: AgentState,
  sessionId: UUID | undefined,
): AgentState {
  if (sessionId === undefined || !(sessionId in state.sessions)) return state;
  const { [sessionId]: _dropped, ...sessions } = state.sessions;
  return { ...state, sessions };
}
