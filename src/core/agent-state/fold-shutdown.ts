import type { UUID } from "node:crypto";
import type { AgentEvent } from "../protocol.ts";
import type { AgentState } from "./agent-state.ts";
import { observeOn } from "./observe-on.ts";
import { withSession } from "./session-state.ts";
import { type TrackerAnomaly, withAnomalies } from "./tracker-anomaly.ts";

/** The daemon's farewell is a stamped query node of every session: it
 *  resolves right behind each query tail and leaves session-pending ids
 *  alone (a node seen on both streams would assert the file had caught
 *  up). Everything else it implies (the process is going away) is outside
 *  the observable agent state. */
export function foldShutdown(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "shutdown" }>,
): AgentState {
  let next = state;
  const anomalies: TrackerAnomaly[] = [];
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    const observation = observeOn(
      session,
      "query",
      event.uuid,
      event.kind,
      true,
    );
    anomalies.push(...observation.anomalies);
    next = withSession(next, sessionId as UUID, observation.session);
  }
  return withAnomalies(next, anomalies);
}
