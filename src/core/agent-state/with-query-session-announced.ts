import type { AgentEvent, AgentState } from "../protocol/index.ts";
import { freshSessionState } from "./session-state.ts";
import { withSession } from "./with-session.ts";

/** The query moved to `event.sessionId`: its SessionState exists from
 *  here on. `foldEvent` then observes the session-start node on `query`,
 *  which the file side's `sessionFileChanged` for the same id resolves. */
export function withQuerySessionAnnounced(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "querySessionChanged" }>,
): AgentState {
  const sessionId = event.sessionId;
  return withSession(
    { ...state, querySessionId: sessionId },
    sessionId,
    state.sessions[sessionId] ?? freshSessionState(),
  );
}
