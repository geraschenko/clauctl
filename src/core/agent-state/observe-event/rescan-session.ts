import { pending } from "../../stream-merge.ts";
import { freshSessionState, type SessionState } from "../session-state.ts";
import type { TrackerAnomaly } from "../tracker-anomaly.ts";
import { type Observation, observeOn } from "./observe-on.ts";

/** The tracked file's session rebuilt for a same-file rescan: fresh
 *  merge, the old session's pending query ids re-observed on `query`
 *  with their `session` exclusions, `pendingLeaf` and usage/model
 *  evidence kept; everything the log told us forgotten. */
export function rescanSession(trackedSession: SessionState): Observation {
  let session: SessionState = {
    ...freshSessionState(),
    pendingLeaf: trackedSession.pendingLeaf,
    ...(trackedSession.lastUsage !== undefined && {
      lastUsage: trackedSession.lastUsage,
    }),
    ...(trackedSession.model !== undefined && { model: trackedSession.model }),
  };
  const anomalies: TrackerAnomaly[] = [];
  for (const uuid of pending(trackedSession.merge, "query")) {
    const observation = observeOn(
      session,
      "query",
      uuid,
      "rescan",
      trackedSession.merge.nodes[uuid]!.excludedFrom.includes("session"),
    );
    session = observation.session;
    anomalies.push(...observation.anomalies);
  }
  return { session, anomalies };
}
