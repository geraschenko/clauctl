import { type AgentEvent, eventUuid } from "../protocol.ts";
import type { AgentState } from "./agent-state.ts";
import { observeOn } from "./observe-on.ts";
import {
  freshSessionState,
  type MergeStream,
  withSession,
} from "./session-state.ts";
import { type TrackerAnomaly, withAnomalies } from "./tracker-anomaly.ts";

/** The rule for a stamped event: observed on `stream`'s session under its
 *  uuid, excluded from the other stream, so it resolves right behind its
 *  stream predecessors. A stream without a session is a daemon bug (the
 *  hub announces every session before anything on it) and is reported. */
export function observeStamped(
  state: AgentState,
  event: AgentEvent,
  stream: MergeStream,
): { state: AgentState; anomalies: readonly TrackerAnomaly[] } {
  const uuid = eventUuid(event);
  const sessionId =
    stream === "query" ? state.querySessionId : state.fileSessionId;
  if (sessionId === undefined) {
    return {
      state,
      anomalies: [
        {
          kind: "merge-error",
          detail: `${event.kind} ${uuid} on ${stream}: no ${stream} session`,
        },
      ],
    };
  }
  const observation = observeOn(
    state.sessions[sessionId] ?? freshSessionState(),
    stream,
    uuid,
    event.kind,
    true,
  );
  return {
    state: withSession(state, sessionId, observation.session),
    anomalies: observation.anomalies,
  };
}

export function foldStamped(
  state: AgentState,
  event: AgentEvent,
  stream: MergeStream,
): AgentState {
  const observed = observeStamped(state, event, stream);
  return withAnomalies(observed.state, observed.anomalies);
}
