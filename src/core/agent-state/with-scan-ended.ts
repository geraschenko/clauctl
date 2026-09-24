import type { AgentState } from "../protocol/index.ts";
import { withSession } from "./with-session.ts";

/** `scanComplete`: the tracked file's scan exclusion ends. */
export function withScanEnded(state: AgentState): AgentState {
  const sessionId = state.fileSessionId;
  if (sessionId === undefined) return state;
  const trackedSession = state.sessions[sessionId];
  return trackedSession === undefined || !trackedSession.scanExcluded
    ? state
    : withSession(state, sessionId, { ...trackedSession, scanExcluded: false });
}
