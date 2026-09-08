import type { UUID } from "node:crypto";
import {
  type AgentEvent,
  eventNodes,
  eventUuid,
  type AgentState,
  type TrackerAnomaly,
} from "../../protocol/index.ts";
import {
  eventClass,
  eventStream,
  excludedFromOther,
} from "../classification.ts";
import { withSession } from "../with-session.ts";
import { withAnomalies } from "../tracker-anomaly.ts";
import { observeOn } from "./observe-on.ts";

/** The sessions the event is observed on: both start events their own
 *  `sessionId`, `shutdown` every session, otherwise the session of
 *  `eventStream(event)` (`querySessionId` / `fileSessionId`) — empty
 *  while that is undefined. */
export function observedSessions(
  state: AgentState,
  event: AgentEvent,
): readonly UUID[] {
  switch (event.kind) {
    case "querySessionChanged":
    case "sessionFileChanged":
      return [event.sessionId];
    case "shutdown":
      return Object.keys(state.sessions) as UUID[];
    case "userMessageQueued":
    case "userMessageDequeued":
    case "compactSent":
    case "interruptSent":
    case "controlApplied":
    case "contextChanged":
    case "sdkMessage":
    case "sessionEntry":
    case "scanComplete":
    case "sessionAppended":
    case "permissionRequested":
    case "permissionResolved":
    case "trackerAnomaly": {
      const sessionId =
        eventStream(event) === "query"
          ? state.querySessionId
          : state.fileSessionId;
      return sessionId === undefined ? [] : [sessionId];
    }
  }
}

/** The one merge call site for events: every node of `eventNodes(event)`
 *  observed on `eventStream(event)` in every `observedSessions` session,
 *  a first observation excluded from the other stream per
 *  `excludedFromOther`. Anomalies (`merge-error`, no observation): no
 *  session for the stream; a session id in `observedSessions` without a
 *  `SessionState`; an `sdkMessage` whose `session_id` is not
 *  `querySessionId`. */
export function observeEvent(state: AgentState, event: AgentEvent): AgentState {
  const stream = eventStream(event);
  const nodes = eventNodes(event);
  const className = eventClass(event);
  const sessionIds = observedSessions(state, event);
  const anomaly = (detail: string): AgentState =>
    withAnomalies(state, [
      {
        kind: "merge-error",
        detail: `${className} ${eventUuid(event)} on ${stream}: ${detail}`,
      },
    ]);
  if (
    event.kind === "sdkMessage" &&
    event.message.session_id !== state.querySessionId
  ) {
    return anomaly(`session ${event.message.session_id} not announced`);
  }
  if (sessionIds.length === 0 && event.kind !== "shutdown") {
    return anomaly("no session");
  }
  let nextState = state;
  const anomalies: TrackerAnomaly[] = [];
  for (const sessionId of sessionIds) {
    let session = nextState.sessions[sessionId];
    if (session === undefined) {
      anomalies.push({
        kind: "merge-error",
        detail: `${className} ${eventUuid(event)} on ${stream}: session ${sessionId} has no state`,
      });
      continue;
    }
    for (const node of nodes) {
      // The table answers for a first observation only. An existing node
      // with a `true` answer is normal, not an anomaly: a prompt entry or
      // a steer's `source_uuid` after its dequeue is already on `query`,
      // and the merge does not record that it got there by a dequeue.
      const excludeOther =
        !Object.hasOwn(session.merge.nodes, node) &&
        excludedFromOther(event, node, state, session);
      const observation = observeOn(
        session,
        stream,
        node,
        className,
        excludeOther,
      );
      session = observation.session;
      anomalies.push(...observation.anomalies);
    }
    nextState = withSession(nextState, sessionId, session);
  }
  return withAnomalies(nextState, anomalies);
}
