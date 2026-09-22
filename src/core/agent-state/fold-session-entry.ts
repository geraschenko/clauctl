import type { AgentEvent } from "../protocol.ts";
import type { AgentState } from "./agent-state.ts";
import { sessionSettled } from "./selectors.ts";
import { withSession } from "./session-state.ts";

/** Before the observation: an entry whose uuid the query stream already
 *  reported ends the tracked file's scan exclusion (`excludedFromOther`
 *  reads it). */
export function withScanExclusionEnded(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sessionEntry" }>,
): AgentState {
  const sessionId = state.fileSessionId;
  const entryUuid = event.entry.uuid;
  if (sessionId === undefined || entryUuid === undefined) return state;
  const trackedSession = state.sessions[sessionId];
  return trackedSession === undefined ||
    !trackedSession.scanExcluded ||
    !Object.hasOwn(trackedSession.merge.nodes, entryUuid)
    ? state
    : withSession(state, sessionId, { ...trackedSession, scanExcluded: false });
}

/** After the observation: the log's leaf and anchors always, its
 *  usage/model/version only once the file is settled (the query side
 *  leads while it is not). */
export function foldSessionEntry(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sessionEntry" }>,
): AgentState {
  const sessionId = state.fileSessionId;
  if (sessionId === undefined) return state;
  const trackedSession = state.sessions[sessionId];
  if (trackedSession === undefined) return state;
  let session = {
    ...trackedSession,
    treeLeaf: event.leaf,
    awaitingAnchors: event.awaitingAnchors,
  };
  let nextState = state;
  if (sessionSettled(session, sessionId)) {
    const { lastUsage: _lastUsage, model: _model, ...evidenceless } = session;
    const usage = event.lastAssistant?.usage;
    const model = event.lastAssistant?.model;
    session = {
      ...evidenceless,
      ...(usage !== undefined && { lastUsage: usage }),
      ...(model !== undefined && { model }),
    };
    if (typeof event.entry.version === "string") {
      nextState = { ...nextState, claudeCodeVersion: event.entry.version };
    }
  }
  return withSession(nextState, sessionId, session);
}
