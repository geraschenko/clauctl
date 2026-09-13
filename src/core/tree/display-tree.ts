/**
 * The human view of the session tree: the context tree's relation with
 * boundary rows re-inserted where they are shown and matched blocks
 * hidden, so a linear conversation with any number of compactions renders
 * as one straight line and a rewind-and-append shows only its extension
 * (see docs/specs/context-tree.md).
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session/file.ts";
import { finishedTreeView, type FullTreeView } from "./build-tree.ts";
import {
  formatTreeNodeRef,
  parseTreeNodeRef,
  type ParentMap,
  type TreeNodeRef,
  type TreeNodeStr,
} from "./nodes.ts";
import { compactBoundaryOf, invalidRelinkReason } from "./loader.ts";
import {
  matchPreservedList,
  type ContextTree,
  type ContextTreeBuilder,
} from "./context-tree.ts";

export class DisplayTree {
  /** Visible rows only. */
  readonly parentMap: ParentMap;
  /** Hidden occurrence id → its nearest visible ancestor row, or null
   *  when the hidden chain is rootless (anchor-less or dangling-anchor
   *  blocks — hand-crafted/corrupt shapes). */
  private readonly visibleRowOf: ReadonlyMap<TreeNodeStr, TreeNodeStr | null>;

  constructor(
    parentMap: ParentMap,
    visibleRowOf: ReadonlyMap<TreeNodeStr, TreeNodeStr | null>,
  ) {
    this.parentMap = parentMap;
    this.visibleRowOf = visibleRowOf;
  }

  /** The row that displays `ref`: `ref` itself when visible — or unknown
   *  to the tree, so the caller's stale-ref handling still sees it — its
   *  nearest visible ancestor when hidden, undefined when the hidden chain
   *  is rootless (a leaf mapped here renders no marker, matching
   *  filtered-leaf behavior). */
  nearestVisibleNode(ref: TreeNodeRef): TreeNodeRef | undefined {
    const mapped = this.visibleRowOf.get(formatTreeNodeRef(ref));
    if (mapped === undefined) {
      return ref;
    }
    return mapped === null ? undefined : parseTreeNodeRef(mapped);
  }
}

/** The display tree of a full tree and its context tree as they grow,
 *  both over the same entries as byUuid — mismatches throw where detected.
 *  Display rules in docs/specs/context-tree.md. A row's visibility is
 *  final by its own push (a boundary hides only itself and its own block
 *  rows, which the full tree materializes after it), so each row's
 *  visible ancestor is settled as it arrives. */
export class DisplayTreeBuilder {
  private readonly fullTree: FullTreeView;
  private readonly contextTree: Pick<ContextTreeBuilder, "tree">;
  private readonly byUuid: ReadonlyMap<UUID, SessionEntry>;
  /** The display relation over every occurrence, hidden rows included. */
  private readonly displayParent = new Map<TreeNodeStr, TreeNodeStr | null>();
  private readonly hidden = new Set<TreeNodeStr>();
  /** Where a row whose full-tree parent is a boundary row goes: the
   *  boundary row itself, or the branch point of a matched no-summary
   *  boundary (which has no row). */
  private readonly blockParentOfBoundary = new Map<TreeNodeStr, TreeNodeStr>();
  private readonly nearestVisibleAncestorCache = new Map<
    TreeNodeStr,
    TreeNodeStr | null
  >();
  private readonly parentMap = new Map<TreeNodeStr, TreeNodeStr | null>();
  private readonly visibleRowOf = new Map<TreeNodeStr, TreeNodeStr | null>();
  readonly tree: DisplayTree;
  /** Index into fullTree.nodes of the next node to place. */
  private cursor = 0;

  constructor(
    fullTree: FullTreeView,
    contextTree: Pick<ContextTreeBuilder, "tree">,
    byUuid: ReadonlyMap<UUID, SessionEntry>,
  ) {
    this.fullTree = fullTree;
    this.contextTree = contextTree;
    this.byUuid = byUuid;
    this.tree = new DisplayTree(this.parentMap, this.visibleRowOf);
  }

  /** Consume the full-tree nodes materialized since the last push. */
  push(): void {
    const nodes = this.fullTree.nodes;
    for (; this.cursor < nodes.length; this.cursor++) {
      const id = nodes[this.cursor]!;
      this.place(id);
      if (this.hidden.has(id)) {
        this.visibleRowOf.set(id, this.nearestVisibleAncestor(id));
      } else {
        this.parentMap.set(id, this.nearestVisibleAncestor(id));
      }
    }
  }

  private place(id: TreeNodeStr): void {
    const fullParent = this.fullTree.parentMap.get(id) ?? null;
    const entry = this.byUuid.get(parseTreeNodeRef(id).uuid);
    if (entry === undefined) {
      throw new Error(`DisplayTreeBuilder: ${id} names no entry`);
    }
    const contextTree = this.contextTree.tree;
    if (entry.subtype !== "compact_boundary") {
      const contextParent = contextTree.parentMap.get(id);
      if (contextParent === undefined) {
        throw new Error(
          `DisplayTreeBuilder: ${id} is not a context-tree occurrence`,
        );
      }
      this.displayParent.set(
        id,
        contextParent ??
          (fullParent !== null && this.blockParentOfBoundary.has(fullParent)
            ? this.blockParentOfBoundary.get(fullParent)!
            : null),
      );
      return;
    }
    const boundary = compactBoundaryOf(entry);
    const preservedUuids = boundary.preservedMessages.uuids;
    if (
      preservedUuids.length === 0 ||
      invalidRelinkReason(this.displayParent, boundary) !== undefined
    ) {
      this.displayParent.set(id, fullParent);
      this.blockParentOfBoundary.set(id, id);
      return;
    }
    const anchorIsSummary = boundary.preservedMessages.anchorUuid !== id;
    const match = matchPreservedList(
      contextTree,
      preservedUuids,
      anchorIsSummary,
      this.displayParent,
      this.hidden,
    );
    if (match === undefined) {
      this.displayParent.set(id, null);
      this.blockParentOfBoundary.set(id, id);
      return;
    }
    for (const preservedUuid of preservedUuids.slice(0, match.remainderFrom)) {
      this.hidden.add(
        formatTreeNodeRef({ uuid: preservedUuid, viaBoundary: boundary.uuid }),
      );
    }
    this.displayParent.set(id, match.branchPoint);
    if (anchorIsSummary) {
      this.blockParentOfBoundary.set(id, id);
    } else {
      this.hidden.add(id);
      this.blockParentOfBoundary.set(id, match.branchPoint);
    }
  }

  /** Nearest visible strict ancestor; null when the hidden chain is
   *  rootless. Memoized with path compression, so the transform stays
   *  O(occurrences) over long hidden blocks. */
  private nearestVisibleAncestor(id: TreeNodeStr): TreeNodeStr | null {
    const walked: TreeNodeStr[] = [];
    let current = this.displayParent.get(id) ?? null;
    let answer: TreeNodeStr | null = null;
    while (current !== null) {
      if (!this.hidden.has(current)) {
        answer = current;
        break;
      }
      const memo = this.nearestVisibleAncestorCache.get(current);
      if (memo !== undefined) {
        answer = memo;
        break;
      }
      walked.push(current);
      current = this.displayParent.get(current) ?? null;
    }
    for (const node of walked) {
      this.nearestVisibleAncestorCache.set(node, answer);
    }
    return answer;
  }
}

/** The display tree of a whole-file tree and its context tree, both built
 *  from the same entries as byUuid. */
export function toDisplayTree(
  fullTree: ParentMap,
  contextTree: ContextTree,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): DisplayTree {
  const builder = new DisplayTreeBuilder(
    finishedTreeView(fullTree),
    { tree: contextTree },
    byUuid,
  );
  builder.push();
  return builder.tree;
}
