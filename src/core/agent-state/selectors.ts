import type { UUID } from "node:crypto";
import type {
  NonNullableUsage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { pending } from "../stream-merge.ts";
import type { TreeNodeRef } from "../tree/nodes.ts";
import type { AgentState, SessionState } from "../protocol/index.ts";

export const querySession = (state: AgentState): SessionState | undefined =>
  state.querySessionId === undefined
    ? undefined
    : state.sessions[state.querySessionId];

/** The query-side leaf of the query file (merge model, Leaf); null
 *  without a file. */
export const leaf = (state: AgentState): TreeNodeRef | null => {
  const file = querySession(state);
  if (file === undefined) {
    return null;
  }
  return file.pendingLeaf === null ? file.treeLeaf : { uuid: file.pendingLeaf };
};

/** Usage of the last assistant message on the query file's context (its
 *  token counters approximate the current context size). */
export const lastUsage = (state: AgentState): NonNullableUsage | undefined =>
  querySession(state)?.lastUsage;

/** "The file has caught up to the query": no query observation awaits
 *  the log, except the session start itself (`sessionId`, pending until
 *  the file exists and is followed; it cannot lag a file that is not
 *  there) and what is queued behind it that the file never carries. */
export const sessionSettled = (file: SessionState, sessionId: UUID): boolean =>
  file.awaitingAnchors.length === 0 &&
  pending(file.merge, "query").every(
    (uuid) =>
      uuid === sessionId ||
      file.merge.nodes[uuid]!.excludedFrom.includes("session"),
  );

/** Vacuously true before the query has a session. */
export const settled = (state: AgentState): boolean => {
  const file = querySession(state);
  return (
    file === undefined ||
    state.querySessionId === undefined ||
    sessionSettled(file, state.querySessionId)
  );
};

/** Bound on any wait for settledness (the daemon's whenSettled, a client's
 *  `--until` completion): the log has had this long to catch up with the
 *  query stream. */
export const SETTLE_TIMEOUT_MS = 10_000;

/** What a file is still waiting on, for settle-timeout diagnostics. */
export const describeSession = (session: SessionState | undefined): string =>
  session === undefined
    ? "no such file"
    : `pending on query: [${pending(session.merge, "query").join(", ")}]; awaiting anchors: [${session.awaitingAnchors.join(", ")}]`;

/** `shouldQuery !== false` — whether this message predicts a future result. */
export function isQuerying(message: SDKUserMessage): boolean {
  return message.shouldQuery !== false;
}

/** Queued messages that predict a future `result` ("Q" in the spec). */
export function queryingCount(state: AgentState): number {
  return state.queuedMessages.filter((entry) => isQuerying(entry.message))
    .length;
}

/**
 * The activity invariant (next-agent-state.ts header) makes the second clause
 * redundant; the defensive two-clause definition is kept in case the fold's
 * beliefs and the stream ever disagree.
 */
export const isIdle = (state: AgentState): boolean =>
  state.activity === "idle" && queryingCount(state) === 0;
