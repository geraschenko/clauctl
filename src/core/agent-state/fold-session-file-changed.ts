import type { UUID } from "node:crypto";
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

/** The follower moved: the old file's state is dropped, unless the move
 *  is a rescan of the same file, which keeps what the query side still
 *  knows (its pending observations with their exclusions, the leaf and
 *  usage evidence) and forgets everything the log told us. */
export function foldSessionFileChanged(
  state: AgentState,
  sessionId: UUID,
): AgentState {
  const old =
    state.fileSessionId === undefined
      ? undefined
      : state.sessions[state.fileSessionId];
  const dropped = withoutFile(state, state.fileSessionId);
  if (old === undefined || sessionId !== state.fileSessionId) {
    return {
      ...withSession(
        dropped,
        sessionId,
        dropped.sessions[sessionId] ?? freshSessionState(),
      ),
      fileSessionId: sessionId,
    };
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
  return withAnomalies(
    { ...withSession(dropped, sessionId, session), fileSessionId: sessionId },
    anomalies,
  );
}
