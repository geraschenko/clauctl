import type { AgentEvent } from "../protocol.ts";
import { pending } from "../stream-merge.ts";
import type { AgentState } from "./agent-state.ts";
import { observeOn } from "./observe-on.ts";
import {
  freshSessionState,
  type SessionState,
  withoutFile,
  withSession,
} from "./session-state.ts";
import { type TrackerAnomaly, withAnomalies } from "./tracker-anomaly.ts";

/** The follower moved: the old file's state is dropped and the new file's
 *  session (already announced by `querySessionChanged`, whose start node
 *  this resolves) becomes the tracked one — unless the move is a rescan
 *  of the same file, which keeps what the query side still knows (its
 *  pending observations with their exclusions, the leaf and usage
 *  evidence), forgets everything the log told us, and is a node of its
 *  own on `session`. */
export function foldSessionFileChanged(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sessionFileChanged" }>,
): AgentState {
  const sessionId = event.sessionId;
  const old =
    state.fileSessionId === undefined
      ? undefined
      : state.sessions[state.fileSessionId];
  const dropped = withoutFile(state, state.fileSessionId);
  if (old === undefined || sessionId !== state.fileSessionId) {
    const observation = observeOn(
      dropped.sessions[sessionId] ?? freshSessionState(),
      "session",
      sessionId,
      "sessionFileChanged",
      false,
    );
    return withAnomalies(
      {
        ...withSession(dropped, sessionId, observation.session),
        fileSessionId: sessionId,
      },
      observation.anomalies,
    );
  }
  let session: SessionState = {
    ...freshSessionState(),
    pendingLeaf: old.pendingLeaf,
    ...(old.lastUsage !== undefined && { lastUsage: old.lastUsage }),
    ...(old.model !== undefined && { model: old.model }),
  };
  const anomalies: TrackerAnomaly[] = [];
  for (const uuid of pending(old.merge, "query")) {
    const observation = observeOn(
      session,
      "query",
      uuid,
      "rescan",
      old.merge.nodes[uuid]?.excludedFrom.includes("session") === true,
    );
    session = observation.session;
    anomalies.push(...observation.anomalies);
  }
  const rescan = observeOn(
    session,
    "session",
    event.uuid ?? sessionId,
    "sessionFileChanged",
    true,
  );
  anomalies.push(...rescan.anomalies);
  return withAnomalies(
    {
      ...withSession(dropped, sessionId, rescan.session),
      fileSessionId: sessionId,
    },
    anomalies,
  );
}
