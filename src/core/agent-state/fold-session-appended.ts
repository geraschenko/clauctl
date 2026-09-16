import type { UUID } from "node:crypto";
import type { AgentState } from "./agent-state.ts";
import { observeOn } from "./observe-on.ts";
import { freshSessionState, withSession } from "./session-state.ts";
import { type TrackerAnomaly, withAnomalies } from "./tracker-anomaly.ts";

/** Daemon-appended entries (set-context) are query action items on the
 *  query file; their log entries resolve them. */
export function foldSessionAppended(
  state: AgentState,
  uuids: readonly UUID[],
): AgentState {
  const sessionId = state.querySessionId;
  if (sessionId === undefined) return state;
  let session = state.sessions[sessionId] ?? freshSessionState();
  const anomalies: TrackerAnomaly[] = [];
  for (const uuid of uuids) {
    const observation = observeOn(session, "query", uuid, "appended", false);
    session = observation.session;
    anomalies.push(...observation.anomalies);
  }
  return withAnomalies(withSession(state, sessionId, session), anomalies);
}
