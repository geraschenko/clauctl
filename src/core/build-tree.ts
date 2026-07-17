/**
 * The session tree over raw jsonl entries (get-tree). Probe ids in comments
 * (e.g. p0b/p0c) cite the experiments in
 * docs/derisk/compact-boundary-injection/FINDINGS.md.
 */

import type { UUID } from "node:crypto";
import {
  summaryOf,
  validRelink,
  type BoundaryRelink,
  type OnInvalid,
  type TreeNodeRef,
} from "./effective-chain.ts";
import type { SessionEntry } from "./session-file.ts";

export interface TreeNode {
  /** The entry, embedded verbatim. Entries lacking a uuid
   *  (file-history-snapshot, queue-operation) get no tree node and are
   *  visible via get-entries only. Relinked nodes (boundary substructure)
   *  serialize their payload once per node — accepted for a self-contained
   *  format input. */
  entry: SessionEntry;
  children: TreeNode[];
  /** Set when the edge to this node's parent comes from a boundary relink
   *  rather than the entry's raw parentUuid. */
  viaBoundary?: UUID;
}

export interface SessionTree {
  tree: TreeNode[];
  /** The current-leaf tree node — where the next turn attaches. The tip of
   *  the current effective context, daemon-computed (effectiveTreeNodeChain
   *  minus a live filterTail override). Null when the session has no chain
   *  entries. */
  leaf: TreeNodeRef | null;
}

/**
 * Raw parentUuid edges give the base forest; each boundary node is attached
 * as a child of its logicalParentUuid entry (root if absent). A boundary
 * with a valid relink additionally emits its relinked context as
 * substructure: one `viaBoundary` node per relinked uuid, chained per the
 * relink parent map — under the raw summary node (up_to) or directly under
 * the boundary node (from-shape, ending in the relinked summary, whose raw
 * node is omitted). Attachment resolves through a running uuid → node map
 * that a processed relink overwrites, so post-boundary entries and later
 * boundaries' anchors land on relinked nodes — the effective-chain logic,
 * applied forward. An invalid relink emits nothing and leaves the map
 * untouched, matching the loader's skip.
 *
 * logicalParentUuid is not interpreted by the loader — it exists for tree
 * anchoring, and we set it ourselves when building a boundary (= the active
 * leaf at set-context time). Native boundaries follow the same idea: always
 * the last message before the summarization point (full /compact: the
 * pre-compaction leaf; up_to: the last entry of the summarized segment;
 * from: the last preserved entry = parent of the first summarized message —
 * confirmed in the p0b/p0c captures; see file comment). Native summary
 * entries parent onto the boundary in BOTH shapes, so parentUuid-based tree
 * construction stays correct without special-casing.
 */
export function buildTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): TreeNode[] {
  const nodes = new Map<UUID, TreeNode>();
  const roots: TreeNode[] = [];

  const attach = (node: TreeNode, parentUuid: UUID | undefined): void => {
    // A parent uuid pointing at nothing (or at an entry later in the file,
    // which append order rules out) falls back to a root.
    const parent = parentUuid === undefined ? undefined : nodes.get(parentUuid);
    if (parent !== undefined) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  };

  const emitSubstructure = (
    boundaryUuid: UUID,
    relink: BoundaryRelink,
  ): void => {
    for (const relinkedUuid of relink.relinkedUuids) {
      // Preserved uuids name earlier entries (validity), so their nodes
      // exist; the from-shape summary is the entry being processed right
      // now — its node was pre-registered by the caller.
      const entry = nodes.get(relinkedUuid)!.entry;
      const node: TreeNode = { entry, children: [], viaBoundary: boundaryUuid };
      // Same parent resolution as the chain walk: relink map first, raw
      // parentUuid otherwise (only reachable for uuids[0] with no anchor).
      attach(
        node,
        relink.parentMap.get(relinkedUuid) ?? entry.parentUuid ?? undefined,
      );
      nodes.set(relinkedUuid, node);
    }
  };

  // A valid relink whose boundary has a summary defers its substructure to
  // the summary's file position — the up_to anchor (the summary node) does
  // not exist before then. At most one relink is pending at a time: a
  // summary follows its boundary before the next boundary in any
  // CLI/clauctl-written file (in a hand-crafted interleaving, the later
  // boundary would displace the earlier pending substructure).
  let pendingRelink:
    | { summaryUuid: UUID; boundaryUuid: UUID; relink: BoundaryRelink }
    | undefined;

  for (const [index, entry] of entries.entries()) {
    if (entry.uuid === undefined) {
      continue;
    }
    if (entry.uuid !== pendingRelink?.summaryUuid) {
      const node: TreeNode = { entry, children: [] };
      // Boundaries carry parentUuid null; their tree anchor is
      // logicalParentUuid.
      const parentUuid =
        entry.parentUuid ??
        (entry.subtype === "compact_boundary"
          ? (entry.logicalParentUuid ?? undefined)
          : undefined);
      attach(node, parentUuid);
      nodes.set(entry.uuid, node);
      if (entry.subtype === "compact_boundary") {
        const relink = validRelink(entries, index, onInvalid);
        if (relink !== undefined) {
          const summaryUuid = summaryOf(entries, index)?.uuid;
          if (summaryUuid !== undefined) {
            pendingRelink = { summaryUuid, boundaryUuid: entry.uuid, relink };
          } else {
            emitSubstructure(entry.uuid, relink);
          }
        }
      }
      continue;
    }
    // The pending boundary's summary: emit the deferred substructure here.
    // In from-shape the summary is itself relinked and its raw placement is
    // omitted; it is still registered so emitSubstructure can read the
    // entry (the relink then overwrites the registration with the relinked
    // node).
    const { boundaryUuid, relink } = pendingRelink;
    pendingRelink = undefined;
    const node: TreeNode = { entry, children: [] };
    if (!relink.relinkedUuids.includes(entry.uuid)) {
      attach(node, entry.parentUuid ?? undefined);
    }
    nodes.set(entry.uuid, node);
    emitSubstructure(boundaryUuid, relink);
  }
  return roots;
}
