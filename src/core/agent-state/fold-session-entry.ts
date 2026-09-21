import type { AgentEvent } from "../protocol.ts";
import { queuedCommandSourceUuid } from "../session/file.ts";
import type { AgentState } from "./agent-state.ts";
import { classOf } from "./classification.ts";
import { observeOn } from "./observe-on.ts";
import { sessionSettled } from "./selectors.ts";
import { freshSessionState, withSession } from "./session-state.ts";
import { type TrackerAnomaly, withAnomalies } from "./tracker-anomaly.ts";

/** A log entry's merge rule on the tracked file (spec, Fold rules,
 *  sessionEntry): observe on `session`, first observations excluded from
 *  `query` when the tracker's classification or the scan exclusion says
 *  so — never for a prompt still in `queuedMessages`, whose `query`
 *  observation is its dequeue still to come. A `queued_command`
 *  attachment also observes its `source_uuid`, the steered prompt's
 *  stamped uuid, under the same rule. The log's leaf and anchors always,
 *  its usage/model/version only once the file is settled (the query side
 *  leads while it is not). */
export function foldSessionEntry(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sessionEntry" }>,
): AgentState {
  const sessionId = state.fileSessionId;
  if (sessionId === undefined) return state;
  let session = state.sessions[sessionId] ?? freshSessionState();
  const anomalies: TrackerAnomaly[] = [];
  const awaitsDequeue = (uuid: string): boolean =>
    state.queuedMessages.some((entry) => entry.uuid === uuid);
  const uuid = event.entry.uuid;
  if (uuid !== undefined) {
    const appearedInQuery = Object.hasOwn(session.merge.nodes, uuid);
    if (session.scanExcluded && appearedInQuery) {
      session = { ...session, scanExcluded: false };
    }
    const excludeOther =
      !appearedInQuery &&
      !awaitsDequeue(uuid) &&
      (!event.expectsSdkMessage || session.scanExcluded);
    const observation = observeOn(
      session,
      "session",
      uuid,
      classOf(event.entry),
      excludeOther,
    );
    session = observation.session;
    anomalies.push(...observation.anomalies);
  }
  const sourceUuid = queuedCommandSourceUuid(event.entry);
  if (sourceUuid !== undefined) {
    const sourceAppearedInQuery = Object.hasOwn(
      session.merge.nodes,
      sourceUuid,
    );
    const excludeOther = !sourceAppearedInQuery && !awaitsDequeue(sourceUuid);
    const observation = observeOn(
      session,
      "session",
      sourceUuid,
      "prompt",
      excludeOther,
    );
    session = observation.session;
    anomalies.push(...observation.anomalies);
  }
  session = {
    ...session,
    treeLeaf: event.leaf,
    awaitingAnchors: event.awaitingAnchors,
  };
  let next = state;
  if (sessionSettled(session)) {
    const { lastUsage: _lastUsage, model: _model, ...evidenceless } = session;
    const usage = event.lastAssistant?.usage;
    const model = event.lastAssistant?.model;
    session = {
      ...evidenceless,
      ...(usage !== undefined && { lastUsage: usage }),
      ...(model !== undefined && { model }),
    };
    if (typeof event.entry.version === "string") {
      next = { ...next, claudeCodeVersion: event.entry.version };
    }
  }
  return withAnomalies(withSession(next, sessionId, session), anomalies);
}
