/**
 * The human view of the session tree: the context tree's relation with
 * boundary rows re-inserted where they are shown and matched blocks
 * hidden, so a linear conversation with any number of compactions renders
 * as one straight line and a rewind-and-append shows only its extension
 * (see docs/specs/context-tree.md).
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session/file.ts";
import {
  formatTreeNodeRef,
  parseTreeNodeRef,
  type ParentMap,
  type TreeNodeRef,
} from "./nodes.ts";
import { compactBoundaryOf, invalidRelinkReason } from "./loader.ts";
import { matchPreservedList, type ContextTree } from "./context-tree.ts";

export class DisplayTree {
  /** Visible rows only. */
  readonly parentMap: ParentMap;
  /** Hidden occurrence id → its nearest visible ancestor row, or null
   *  when the hidden chain is rootless (anchor-less or dangling-anchor
   *  blocks — hand-crafted/corrupt shapes). */
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

/** The display tree of a full tree and its context tree, both built from
 *  the same entries as byUuid — mismatches throw where detected. Display
 *  rules in docs/specs/context-tree.md; loadedContext and the wire protocol
 *  are untouched. */
export function toDisplayTree(
  fullTree: ParentMap,
  contextTree: ContextTree,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): DisplayTree {
  /** The display relation over every occurrence, hidden rows included. */
  const displayParent = new Map<string, string | null>();
  const hidden = new Set<string>();
  /** Where a row whose full-tree parent is a boundary row goes: the
   *  boundary row itself, or the branch point of a matched no-summary
   *  boundary (which has no row). */
  const blockParentOfBoundary = new Map<string, string>();
  for (const [id, fullParent] of fullTree) {
    const entry = byUuid.get(parseTreeNodeRef(id).uuid);
    if (entry === undefined) {
      throw new Error(`toDisplayTree: ${id} names no entry`);
    }
    if (entry.subtype !== "compact_boundary") {
      const contextParent = contextTree.parentMap.get(id);
      if (contextParent === undefined) {
        throw new Error(
          `toDisplayTree: ${id} is not a context-tree occurrence`,
        );
      }
      displayParent.set(
        id,
        contextParent ??
          (fullParent !== null && blockParentOfBoundary.has(fullParent)
            ? blockParentOfBoundary.get(fullParent)!
            : null),
      );
      continue;
    }
    const boundary = compactBoundaryOf(entry);
    const preservedUuids = boundary.preservedMessages.uuids;
    if (
      preservedUuids.length === 0 ||
      invalidRelinkReason(displayParent, boundary) !== undefined
    ) {
      displayParent.set(id, fullParent);
      blockParentOfBoundary.set(id, id);
      continue;
    }
    const anchorIsSummary = boundary.preservedMessages.anchorUuid !== id;
    const match = matchPreservedList(
      contextTree,
      preservedUuids,
      anchorIsSummary,
      displayParent,
      hidden,
    );
    if (match === undefined) {
      displayParent.set(id, null);
      blockParentOfBoundary.set(id, id);
      continue;
    }
    for (const preservedUuid of preservedUuids.slice(0, match.remainderFrom)) {
      hidden.add(
        formatTreeNodeRef({ uuid: preservedUuid, viaBoundary: boundary.uuid }),
      );
    }
    displayParent.set(id, match.branchPoint);
    if (anchorIsSummary) {
      blockParentOfBoundary.set(id, id);
    } else {
      hidden.add(id);
      blockParentOfBoundary.set(id, match.branchPoint);
    }
  }

  /** Nearest visible strict ancestor; null when the hidden chain is
   *  rootless. Memoized with path compression, so the transform stays
   *  O(occurrences) over long hidden blocks. */
  const nearestVisibleAncestorCache = new Map<string, string | null>();
  const nearestVisibleAncestor = (id: string): string | null => {
    const walked: string[] = [];
    let current = displayParent.get(id) ?? null;
    let answer: string | null = null;
    while (current !== null) {
      if (!hidden.has(current)) {
        answer = current;
        break;
      }
      const memo = nearestVisibleAncestorCache.get(current);
      if (memo !== undefined) {
        answer = memo;
        break;
      }
      walked.push(current);
      current = displayParent.get(current) ?? null;
    }
    for (const node of walked) {
      nearestVisibleAncestorCache.set(node, answer);
    }
    return answer;
  };

  const parentMap = new Map<string, string | null>();
  const visibleRowOf = new Map<string, string | null>();
  for (const id of displayParent.keys()) {
    if (hidden.has(id)) {
      visibleRowOf.set(id, nearestVisibleAncestor(id));
    } else {
      parentMap.set(id, nearestVisibleAncestor(id));
    }
  }
  return new DisplayTree(parentMap, visibleRowOf);
}
