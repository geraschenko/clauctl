import type { AgentEvent, AgentState } from "../protocol/index.ts";
import { rescanSession } from "./observe-event/index.ts";
import { freshSessionState } from "./session-state.ts";
import { withoutFile, withSession } from "./with-session.ts";
import { withAnomalies } from "./tracker-anomaly.ts";

/** The follower moved: the old file's state is dropped and the new file's
 *  session (already announced by `querySessionChanged`, whose start node
 *  `foldEvent`'s observation of this event resolves) becomes the tracked
 *  one — unless the move is a rescan of the same file, which keeps what
 *  the query side still knows (`rescanSession`). */
export function withTrackedFile(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sessionFileChanged" }>,
): AgentState {
  const sessionId = event.sessionId;
  const trackedSession =
    state.fileSessionId === undefined
      ? undefined
      : state.sessions[state.fileSessionId];
  const stateWithoutOldFile = {
    ...withoutFile(state, state.fileSessionId),
    fileSessionId: sessionId,
  };
  if (trackedSession === undefined || sessionId !== state.fileSessionId) {
    return withSession(
      stateWithoutOldFile,
      sessionId,
      stateWithoutOldFile.sessions[sessionId] ?? freshSessionState(),
    );
  }
  const rescanObservation = rescanSession(trackedSession);
  return withAnomalies(
    withSession(stateWithoutOldFile, sessionId, rescanObservation.session),
    rescanObservation.anomalies,
  );
}
