/**
 * The human view of the session tree: the full tree minus relinked
 * duplicates and boundary forks, so a linear conversation with any number
 * of compactions renders as one straight line (see
 * docs/specs/session-tree.md).
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session-file.ts";
import type { ParentMap } from "./nodes.ts";
import { compactBoundaryAt, invalidRelinkReason } from "./loader.ts";

export interface DisplayTree {
  /** Visible rows only. */
  parentMap: ParentMap;
  /** Hidden occurrence id → its nearest visible ancestor row, or null
   *  when the hidden chain is rootless (anchor-less or dangling-anchor
   *  blocks — hand-crafted/corrupt shapes; a null-mapped leaf renders no
   *  marker, matching filtered-leaf behavior). Defined for every hidden
   *  id (relinked rows, pruned boundary rows). Sole purpose: mapping a
   *  hidden leaf ref to the row that carries the `*` marker / picker
   *  cursor. Picker rows themselves are all visible. */
  visibleRowOf: Map<string, string | null>;
}

/** The human view, derived from the full tree by three rules:
 *  1. each boundary row with a valid non-empty preserved list reparents
 *     onto the raw row of its last preserved uuid;
 *  2. every `@boundary` row is hidden; anything whose parent is hidden
 *     displays under its nearest visible ancestor;
 *  3. a boundary row with a valid NON-EMPTY preserved list and no
 *     visible descendants is hidden too (fixpoint, so stacked navigation
 *     boundaries cascade away).
 *  Boundaries with no applicable relink — metadata-less, invalid, or
 *  empty-list (a context wipe is a real event) — keep their placement
 *  and stay visible. Display-only: loadedContext and the wire protocol
 *  are untouched. Precondition: fullTree came from buildTree over the
 *  same entries — mismatched inputs are unchecked. No OnInvalid: boundary
 *  validity is re-derived without reporting (diagnostics belong to the
 *  buildTree call). */
export function toDisplayTree(
  fullTree: ParentMap,
  entries: SessionEntry[],
): DisplayTree {
  const fileUuids = new Set<UUID>();
  for (const entry of entries) {
    if (entry.uuid !== undefined) {
      fileUuids.add(entry.uuid);
    }
  }
  /** Rule 1: boundary row → the raw row of its last preserved uuid.
   *  Membership doubles as "valid non-empty preserved list" (rule 3's
   *  candidate set). First occurrence wins on a duplicated uuid exactly as
   *  in buildTree: a later copy of ANY uuid-bearing entry is skipped, so a
   *  duplicate boundary contributes nothing even when the first occurrence
   *  was metadata-less or not a boundary. */
  const boundaryTail = new Map<string, string>();
  const seenUuids = new Set<UUID>();
  for (const [index, entry] of entries.entries()) {
    if (entry.uuid === undefined || seenUuids.has(entry.uuid)) {
      continue;
    }
    seenUuids.add(entry.uuid);
    if (entry.subtype !== "compact_boundary") {
      continue;
    }
    const boundary = compactBoundaryAt(entries, index);
    const preservedUuids = boundary.preservedMessages?.uuids ?? [];
    if (
      preservedUuids.length > 0 &&
      invalidRelinkReason(fileUuids, boundary) === undefined
    ) {
      boundaryTail.set(entry.uuid, preservedUuids[preservedUuids.length - 1]!);
    }
  }

  /** The reparented relation (rule 1 applied over the full tree). */
  const parentOf = (id: string): string | null =>
    boundaryTail.get(id) ?? fullTree.get(id) ?? null;

  const isRelinkedRow = (id: string): boolean => id.includes("@");
  /** A row that is visible regardless of descendants: neither a relinked
   *  row nor a rule-3 candidate boundary. */
  const isPlainRow = (id: string): boolean =>
    !isRelinkedRow(id) && !boundaryTail.has(id);

  // Rule 3: a candidate boundary is pruned when no descendant is a plain
  // row — equivalently, kept iff it is a strict ancestor of a plain row.
  // Marking every strict ancestor of every plain row computes the fixpoint
  // of iterated pruning directly: marks come only from plain rows, which
  // are never pruned, so no cascade can unmark anything. Each walk stops at
  // the first already-marked node (the marks double as the cycle guard), so
  // the pass is O(occurrences) total.
  const hasPlainDescendant = new Set<string>();
  for (const id of fullTree.keys()) {
    if (!isPlainRow(id)) {
      continue;
    }
    let current = parentOf(id);
    while (current !== null && !hasPlainDescendant.has(current)) {
      hasPlainDescendant.add(current);
      current = parentOf(current);
    }
  }
  const hidden = new Set<string>();
  for (const id of fullTree.keys()) {
    if (
      isRelinkedRow(id) ||
      (boundaryTail.has(id) && !hasPlainDescendant.has(id))
    ) {
      hidden.add(id);
    }
  }

  /** Nearest visible strict ancestor in the reparented relation; null when
   *  the hidden chain is rootless (or, defensively, cyclic). Memoized with
   *  path compression — every hidden node passed on a walk shares the
   *  walk's answer, so each node is walked at most once and the whole
   *  transform stays O(occurrences) even over long hidden blocks. */
  const resolved = new Map<string, string | null>();
  const nearestVisibleAncestor = (id: string): string | null => {
    const cached = resolved.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const walked = [id];
    const onWalk = new Set<string>([id]);
    let answer: string | null = null;
    let current = parentOf(id);
    while (current !== null) {
      if (onWalk.has(current) || !fullTree.has(current)) {
        break;
      }
      if (!hidden.has(current)) {
        answer = current;
        break;
      }
      const memo = resolved.get(current);
      if (memo !== undefined) {
        answer = memo;
        break;
      }
      walked.push(current);
      onWalk.add(current);
      current = parentOf(current);
    }
    // Every node passed after walked[k] was hidden, so each walked node's
    // nearest visible ancestor is the same answer.
    for (const node of walked) {
      resolved.set(node, answer);
    }
    return answer;
  };

  const parentMap = new Map<string, string | null>();
  const visibleRowOf = new Map<string, string | null>();
  for (const id of fullTree.keys()) {
    if (hidden.has(id)) {
      visibleRowOf.set(id, nearestVisibleAncestor(id));
    } else {
      parentMap.set(id, nearestVisibleAncestor(id));
    }
  }
  return { parentMap, visibleRowOf };
}
