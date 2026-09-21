import type { UUID } from "node:crypto";
import type { AgentState } from "./agent-state.ts";
import { observeOn } from "./observe-on.ts";
import { freshSessionState, withSession } from "./session-state.ts";
import { withAnomalies } from "./tracker-anomaly.ts";

/** The query moved to `sessionId`: its SessionState exists from here on,
 *  headed on `query` by the session-start node, which the file side's
 *  `sessionFileChanged` for the same id resolves. */
export function foldQuerySessionChanged(
  state: AgentState,
  sessionId: UUID,
): AgentState {
  const observation = observeOn(
    state.sessions[sessionId] ?? freshSessionState(),
    "query",
    sessionId,
    "querySessionChanged",
    false,
  );
  return withAnomalies(
    withSession(
      { ...state, querySessionId: sessionId },
      sessionId,
      observation.session,
    ),
    observation.anomalies,
  );
}
