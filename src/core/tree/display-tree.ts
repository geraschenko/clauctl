/**
 * The human view of the session tree: the full tree minus relinked
 * duplicates and boundary forks, so a linear conversation with any number
 * of compactions renders as one straight line (see
 * docs/specs/session-tree.md).
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session/file.ts";
import {
  formatTreeNodeRef,
  parseTreeNodeRef,
  type ParentMap,
  type TreeNodeRef,
} from "./nodes.ts";
import {
  compactBoundaryAt,
  invalidRelinkReason,
  toolGroupMaps,
} from "./loader.ts";

export class DisplayTree {
  /** Visible rows only. */
  readonly parentMap: ParentMap;
  /** Hidden occurrence id → its nearest visible ancestor row, or null
   *  when the hidden chain is rootless (anchor-less or dangling-anchor
   *  blocks — hand-crafted/corrupt shapes). Defined for every hidden id
   *  (relinked rows, pruned boundary rows). */
  private readonly visibleRowOf: Map<string, string | null>;

  constructor(parentMap: ParentMap, visibleRowOf: Map<string, string | null>) {
    this.parentMap = parentMap;
    this.visibleRowOf = visibleRowOf;
  }

  /** The row that displays `ref`: `ref` itself when visible — or unknown
   *  to the tree, so the caller's stale-ref handling still sees it — its
   *  nearest visible ancestor when hidden, undefined when the hidden chain
   *  is rootless (a leaf mapped here renders no marker, matching
   *  filtered-leaf behavior). */
  nearestVisibleRow(ref: TreeNodeRef): TreeNodeRef | undefined {
    const mapped = this.visibleRowOf.get(formatTreeNodeRef(ref));
    if (mapped === undefined) {
      return ref;
    }
    return mapped === null ? undefined : parseTreeNodeRef(mapped);
  }
}

/** The human view, derived from the full tree by four rules:
 *  1. each boundary row with a valid non-empty preserved list reparents
 *     onto the raw row of its last preserved uuid;
 *  2. every `@boundary` row is hidden; anything whose parent is hidden
 *     displays under its nearest visible ancestor;
 *  3. a boundary row with a valid NON-EMPTY preserved list and no
 *     visible descendants is hidden too (fixpoint, so stacked navigation
 *     boundaries cascade away);
 *  4. each parallel tool group — all assistant entries sharing an API
 *     message.id plus their tool_result children — linearizes in strict
 *     chronological (file) order: the first element keeps its raw display
 *     parent, each later element parents onto its predecessor, and any
 *     OUTSIDE child of a group tool_result reparents onto the group's
 *     last element (the result's child is the turn's continuation —
 *     producers parent the next turn on the last-written result — which
 *     would otherwise dangle mid-group). An outside child of a NON-result
 *     member keeps its raw parent: it is a genuine fork — rewinding to a
 *     tool-call entry (a valid target when no same-id sibling follows it)
 *     and prompting creates exactly that shape — and pulling it onto the
 *     tail would fabricate lineage. This shows both calls of a parallel
 *     turn on one path; it deliberately differs from the loader's splice
 *     order, which places a group's recovered entries as one block after
 *     the group's last on-chain assistant rather than at their file
 *     positions (docs/session-views.md).
 *  Boundaries with no applicable relink — invalid or empty-list — keep
 *  their placement and stay visible: a context wipe is a real event the
 *  user performed, and hiding it would hide history. Display-only:
 *  loadedContext and the wire protocol are untouched. Precondition:
 *  fullTree came from buildTree over the same entries — mismatched inputs
 *  are unchecked. No OnInvalid: boundary validity is re-derived without
 *  reporting (diagnostics belong to the buildTree call). */
export function toDisplayTree(
  fullTree: ParentMap,
  entries: SessionEntry[],
): DisplayTree {
  /** All uuids in `entries`, and each uuid's first-occurrence index —
   *  duplicate arbitration exactly as in buildTree, and rule 4's
   *  chronological sort key. Built complete before any rule runs: relink
   *  validation and group linearization both need lookahead over the whole
   *  entry list. */
  const fileUuids = new Set<UUID>();
  const entryIndexOf = new Map<UUID, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.uuid !== undefined && !entryIndexOf.has(entry.uuid)) {
      fileUuids.add(entry.uuid);
      entryIndexOf.set(entry.uuid, index);
    }
  }
  /** Rule 1: boundary row → the raw row of its last preserved uuid.
   *  Membership doubles as "valid non-empty preserved list" (rule 3's
   *  candidate set). A later copy of ANY uuid-bearing entry is skipped, so
   *  a duplicate boundary contributes nothing even when the first
   *  occurrence was metadata-less or not a boundary. */
  const parentOfBoundary = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    if (
      entry.uuid === undefined ||
      entryIndexOf.get(entry.uuid) !== index ||
      entry.subtype !== "compact_boundary"
    ) {
      continue;
    }
    const boundary = compactBoundaryAt(entries, index);
    const preservedUuids = boundary.preservedMessages.uuids;
    if (
      preservedUuids.length > 0 &&
      invalidRelinkReason(fileUuids, boundary) === undefined
    ) {
      parentOfBoundary.set(
        entry.uuid,
        preservedUuids[preservedUuids.length - 1]!,
      );
    }
  }

  const linearizedGroupParent = linearizedGroupParents(
    fullTree,
    entries,
    entryIndexOf,
  );

  /** The reparented relation (rules 1 and 4 applied over the full tree;
   *  rule 1 wins for boundary rows — their placement is the relink's
   *  business even when their logical parent is a group result). */
  const parentOf = (id: string): string | null =>
    parentOfBoundary.get(id) ??
    linearizedGroupParent.get(id) ??
    fullTree.get(id) ??
    null;

  const isRelinkedRow = (id: string): boolean => id.includes("@");
  /** A row that is visible regardless of descendants: neither a relinked
   *  row nor a rule-3 candidate boundary. */
  const isPlainRow = (id: string): boolean =>
    !isRelinkedRow(id) && !parentOfBoundary.has(id);

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
      (parentOfBoundary.has(id) && !hasPlainDescendant.has(id))
    ) {
      hidden.add(id);
    }
  }

  /** Nearest visible strict ancestor in the reparented relation; null when
   *  the hidden chain is rootless (or, defensively, cyclic). Memoized with
   *  path compression — every hidden node passed on a walk shares the
   *  walk's answer, so each node is walked at most once and the whole
   *  transform stays O(occurrences) even over long hidden blocks. */
  const nearestVisibleAncestorCache = new Map<string, string | null>();
  const nearestVisibleAncestor = (id: string): string | null => {
    const cached = nearestVisibleAncestorCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
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
      const memo = nearestVisibleAncestorCache.get(current);
      if (memo !== undefined) {
        answer = memo;
        break;
      }
      onWalk.add(current);
      current = parentOf(current);
    }
    // Every node walked past was hidden, so they all share the answer.
    for (const node of onWalk) {
      nearestVisibleAncestorCache.set(node, answer);
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
  return new DisplayTree(parentMap, visibleRowOf);
}

/** Rule 4's parent overrides, over raw rows only (a raw row's id is its
 *  bare uuid): each non-first element of a parallel tool group parents
 *  onto its predecessor in first-occurrence order, and each outside child
 *  of a group tool_result reparents onto the group's last element.
 *  Relinked occurrences and their children are the relink structure,
 *  handled by rules 1–3. Already-chronological groups (single-call turns,
 *  interleaved same-id turns) produce overrides that restate the raw
 *  parents — identity in effect. */
function linearizedGroupParents(
  fullTree: ParentMap,
  entries: SessionEntry[],
  entryIndexOf: ReadonlyMap<UUID, number>,
): Map<string, string> {
  const { assistantsByMessageId, resultsByCallUuid } = toolGroupMaps(entries);
  const linearizedParent = new Map<string, string>();
  /** Group tool_result raw row → its group's last element and member set,
   *  for the outside-child reparent. */
  const tailOfResult = new Map<string, { tail: UUID; group: Set<UUID> }>();
  for (const members of assistantsByMessageId.values()) {
    const resultUuids = members.flatMap(
      (member) => resultsByCallUuid.get(member) ?? [],
    );
    const group = [...members, ...resultUuids].sort(
      (a, b) => entryIndexOf.get(a)! - entryIndexOf.get(b)!,
    );
    if (group.length < 2) {
      continue;
    }
    for (let index = 1; index < group.length; index++) {
      linearizedParent.set(group[index]!, group[index - 1]!);
    }
    const groupSet = new Set(group);
    const tail = group.at(-1)!;
    for (const result of resultUuids) {
      tailOfResult.set(result, { tail, group: groupSet });
    }
  }
  for (const [id, parent] of fullTree) {
    if (parent === null || parent.includes("@") || id.includes("@")) {
      continue;
    }
    const groupOfParent = tailOfResult.get(parent);
    if (groupOfParent !== undefined && !groupOfParent.group.has(id as UUID)) {
      linearizedParent.set(id, groupOfParent.tail);
    }
  }
  return linearizedParent;
}
