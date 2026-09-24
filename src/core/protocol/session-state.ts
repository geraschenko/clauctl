import type { UUID } from "node:crypto";
import type { NonNullableUsage } from "@anthropic-ai/claude-agent-sdk";
import type { MergeState, Resolved } from "../stream-merge.ts";
import type { TreeNodeRef } from "../tree/nodes.ts";

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
  /** Ids resolved by every observation of the fold step that produced
   *  this state, in resolution order; empty on every other state (like
   *  `AgentState.anomaly`, it describes the event just folded). */
  readonly resolved: readonly Resolved<UUID, MergeStream>[];
}

export const MERGE_STREAMS: readonly MergeStream[] = ["query", "session"];
