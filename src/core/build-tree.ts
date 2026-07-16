/**
 * The session tree over raw jsonl entries (get-tree). Probe ids in comments
 * (e.g. p0b/p0c) cite the experiments in
 * docs/derisk/compact-boundary-injection/FINDINGS.md.
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "./session-file.ts";

export interface TreeNode {
  entryUuid: UUID;
  children: TreeNode[];
  /** Set when the edge to this node's parent comes from a boundary relink
   *  rather than the entry's raw parentUuid. */
  viaBoundary?: UUID;
}

export interface SessionTree {
  roots: TreeNode[];
  /** Payloads by uuid; duplicated tree nodes share one payload. Entries
   *  lacking a uuid (file-history-snapshot, queue-operation) are omitted —
   *  they get no tree node and are visible via get-entries only. */
  entries: Record<UUID, SessionEntry>;
}

/** TODO: THIS SPEC ships the raw forest only: raw parentUuid edges give the base
 *  forest, and each boundary node is attached as a child of its
 *  logicalParentUuid entry (root if absent). The boundary's relinked chain —
 *  summary + uuids per anchor shape hanging under it as DUPLICATE nodes
 *  (same entryUuid, new TreeNode), with relink revisits unrolled linearly —
 *  is specified and built in a FOLLOW-UP spec; until then viaBoundary is
 *  never set. The TreeNode/SessionTree shapes above are fixed now so the
 *  follow-up is additive.
 *
 *  logicalParentUuid is not interpreted by the loader — it exists for tree
 *  anchoring, and we set it ourselves when building a boundary (= the active
 *  leaf at set-context time). Native boundaries follow the same idea: always
 *  the last message before the summarization point (full /compact: the
 *  pre-compaction leaf; up_to: the last entry of the summarized segment;
 *  from: the last preserved entry = parent of the first summarized message —
 *  confirmed in the p0b/p0c captures; see file comment). Native summary
 *  entries parent onto the boundary in BOTH shapes, so parentUuid-based tree
 *  construction stays correct without special-casing. */
export function buildTree(entries: SessionEntry[]): SessionTree {
  const payloads: Record<UUID, SessionEntry> = {};
  const nodes = new Map<UUID, TreeNode>();
  const roots: TreeNode[] = [];
  for (const entry of entries) {
    if (entry.uuid === undefined) {
      continue;
    }
    payloads[entry.uuid] = entry;
    const node: TreeNode = { entryUuid: entry.uuid, children: [] };
    nodes.set(entry.uuid, node);
    // Boundaries carry parentUuid null; their tree anchor is
    // logicalParentUuid.
    const parentUuid =
      entry.parentUuid ??
      (entry.subtype === "compact_boundary"
        ? (entry.logicalParentUuid ?? null)
        : null);
    // A parent uuid pointing at nothing (or at an entry later in the file,
    // which append order rules out) falls back to a root.
    const parent = parentUuid === null ? undefined : nodes.get(parentUuid);
    if (parent !== undefined) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { roots, entries: payloads };
}
