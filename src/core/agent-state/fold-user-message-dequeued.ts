import type { AgentEvent } from "../protocol.ts";
import type { AgentState } from "./agent-state.ts";
import { observeOn } from "./observe-on.ts";
import { freshSessionState, withSession } from "./session-state.ts";
import { withAnomalies } from "./tracker-anomaly.ts";

/** A dequeue is the `query` observation of the run key — the last uuid,
 * under which claude files a merged run's entry (a steer's key is the
 * `source_uuid` of the attachment it becomes). A turn/append entry is the
 * file's next leaf; a steer's attachment has its own uuid, so a steer
 * predicts no leaf. Activity is unchanged: a "turn" dequeue arrives after a
 * `result` that already set pending; "steer" and "append" have no activity
 * of their own. */
export function foldUserMessageDequeued(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "userMessageDequeued" }>,
): AgentState {
  const queuedMessages = state.queuedMessages.filter(
    (entry) => !event.uuids.includes(entry.uuid),
  );
  const nextState = { ...state, queuedMessages };
  const sessionId = state.querySessionId;
  if (sessionId === undefined) {
    // The daemon's first prompt: dequeued at acceptance, before any query
    // message named a session. Its entry, no longer awaiting a dequeue, is
    // excluded from `query` and resolves on arrival (fold-session-entry.ts).
    return nextState;
  }
  const session = state.sessions[sessionId] ?? freshSessionState();
  const runKey = event.uuids.at(-1)!;
  const excludeOther = false; // We expect a session entry.
  const observation = observeOn(
    event.delivery === "steer" ? session : { ...session, pendingLeaf: runKey },
    "query",
    runKey,
    "prompt",
    excludeOther,
  );
  return withAnomalies(
    withSession(nextState, sessionId, observation.session),
    observation.anomalies,
  );
}
