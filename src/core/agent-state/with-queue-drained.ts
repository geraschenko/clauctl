import type { AgentEvent, AgentState } from "../protocol/index.ts";
import { withSession } from "./with-session.ts";

/** The dequeued messages leave the queue; a turn's run key — the last
 *  uuid, under which claude files a merged run's entry (a steer's key is
 *  the attachment's `source_uuid`, met by `eventNodes`) — becomes the
 *  query session's `pendingLeaf`. The run key's `query` observation is
 *  `foldEvent`'s. */
export function withQueueDrained(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "userMessageDequeued" }>,
): AgentState {
  const stateWithQueueDrained = {
    ...state,
    queuedMessages: state.queuedMessages.filter(
      (queued) => !event.uuids.includes(queued.uuid),
    ),
  };
  const sessionId = state.querySessionId;
  const querySessionState =
    sessionId === undefined ? undefined : state.sessions[sessionId];
  return sessionId === undefined ||
    querySessionState === undefined ||
    event.delivery === "steer"
    ? stateWithQueueDrained
    : withSession(stateWithQueueDrained, sessionId, {
        ...querySessionState,
        pendingLeaf: event.uuids.at(-1)!,
      });
}
