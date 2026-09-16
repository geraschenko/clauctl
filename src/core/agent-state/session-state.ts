import type { UUID } from "node:crypto";
import type { NonNullableUsage } from "@anthropic-ai/claude-agent-sdk";
import { createMerge, type MergeState } from "../stream-merge.ts";
import type { TreeNodeRef } from "../tree/nodes.ts";
import type { AgentState } from "./agent-state.ts";

export type MergeStream = "query" | "session";

/** The fold's view of one session: the merge of its query stream and its
 *  file, and what has been observed on it. Fields that mirror a top-level
 *  `AgentState` field (`model`) are observed evidence; the top-level one is
 *  the prediction for the next query. */
export interface SessionState {
  readonly merge: MergeState<UUID, MergeStream>;
  /** The context tree's leaf, folded from sessionEntry.leaf; null before
   *  any entry and after a wipe. */
  readonly treeLeaf: TreeNodeRef | null;
  /** The last leaf-eligible query observation still pending on `query`;
   *  null once the log has it. */
  readonly pendingLeaf: UUID | null;
  /** Boundaries whose preserved blocks are deferred behind anchors not
   *  yet in the log; the session tracker is incomplete while non-empty. */
  readonly awaitingAnchors: readonly UUID[];
  /** Usage/model observed on the last assistant message of the context
   *  (from the query stream while unsettled, from the file once settled). */
  readonly lastUsage?: NonNullableUsage;
  readonly model?: string;
  /** While true, session observations are excluded from `query`: the
   *  scan has not yet met an id the query stream reported. */
  readonly scanExcluded: boolean;
}

export const MERGE_STREAMS: readonly MergeStream[] = ["query", "session"];

const EMPTY_MERGE: MergeState<UUID, MergeStream> = createMerge<
  UUID,
  MergeStream
>(MERGE_STREAMS).match(
  (merge) => merge,
  (error) => {
    throw new Error(error.message);
  },
);

/** A file the fold has not seen a log entry of yet: the scan exclusion
 *  holds until a session observation meets a query-reported id. */
export function freshSessionState(): SessionState {
  return {
    merge: EMPTY_MERGE,
    treeLeaf: null,
    pendingLeaf: null,
    awaitingAnchors: [],
    scanExcluded: true,
  };
}

export function withSession(
  state: AgentState,
  sessionId: UUID,
  session: SessionState,
): AgentState {
  return { ...state, sessions: { ...state.sessions, [sessionId]: session } };
}

export function withoutFile(
  state: AgentState,
  sessionId: UUID | undefined,
): AgentState {
  if (sessionId === undefined || !(sessionId in state.sessions)) return state;
  const { [sessionId]: _dropped, ...sessions } = state.sessions;
  return { ...state, sessions };
}
