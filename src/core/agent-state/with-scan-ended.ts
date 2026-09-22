import type { AgentState } from "./agent-state.ts";
import { withSession } from "./session-state.ts";

/** `scanComplete`: the tracked file's scan exclusion ends. */
export function withScanEnded(state: AgentState): AgentState {
  const sessionId = state.fileSessionId;
  if (sessionId === undefined) return state;
  const trackedSession = state.sessions[sessionId];
  return trackedSession === undefined || !trackedSession.scanExcluded
    ? state
    : withSession(state, sessionId, { ...trackedSession, scanExcluded: false });
}
