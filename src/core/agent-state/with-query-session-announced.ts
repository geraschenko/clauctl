import type { AgentEvent } from "../protocol.ts";
import type { AgentState } from "./agent-state.ts";
import { freshSessionState, withSession } from "./session-state.ts";

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
