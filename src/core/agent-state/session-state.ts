import type { UUID } from "node:crypto";
import { createMerge, type MergeState } from "../stream-merge.ts";
import {
  MERGE_STREAMS,
  type MergeStream,
  type SessionState,
} from "../protocol/index.ts";

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
    resolved: [],
  };
}
