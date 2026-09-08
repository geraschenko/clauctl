/**
 * The full occurrence tree over raw jsonl entries: what `raw` filter mode
 * shows, and the superset every navigation target lives in (see
 * docs/specs/session-tree.md). All relink rules live in loader.ts.
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session/file.ts";
import {
  formatTreeNodeRef,
  type ParentMap,
  type TreeNodeStr,
} from "./nodes.ts";
import {
  compactBoundaryOf,
  effectiveParent,
  invalidRelinkReason,
  parentOfPreserved,
  type CompactBoundary,
  type OnInvalid,
} from "./loader.ts";

/** The full tree as its dependents (context and display builders) read
 *  it: the live relation, the same nodes as an indexable sequence for a
 *  dependent's cursor, and the boundaries still waiting for an anchor. */
export interface FullTreeView {
  readonly parentMap: ParentMap;
  /** parentMap's keys, only ever appended. Kept as an array because a
   *  dependent resumes from an index across pushes, which a Map key
   *  iterator cannot do: once it reports done it stays done. */
  readonly nodes: readonly TreeNodeStr[];
  /** Boundaries whose blocks are deferred behind absent anchors, file order. */
  readonly awaitingAnchors: readonly UUID[];
}

/** A finished tree has nothing deferred. */
export function finishedTreeView(parentMap: ParentMap): FullTreeView {
  return { parentMap, nodes: [...parentMap.keys()], awaitingAnchors: [] };
}

/** Every occurrence — one raw node per uuid (first-wins) plus relinked
 *  block nodes — in an order where each node follows its parent: raw
 *  nodes at file position with parents read through the latest boundary
 *  (effectiveParent), each valid boundary's relinked block right after
 *  its anchor's node, and raw nodes parented on a not-yet-materialized
 *  block node deferred behind it. Rules and edge cases (last-wins
 *  boundaries, first-wins duplicates, dangling anchors) in
 *  docs/specs/session-tree.md. */
export class SessionTreeBuilder implements FullTreeView {
  /** Live views; grow with push. */
  readonly parentMap = new Map<TreeNodeStr, TreeNodeStr | null>();
  readonly nodes: TreeNodeStr[] = [];
  private readonly onInvalid: OnInvalid;
  /** The latest boundary encountered so far, tracked only while its relink
   *  applied (valid, non-empty): a boundary with no applicable relink ends
   *  the previous boundary's effect and contributes no rules, which this
   *  represents as undefined. */
  private latest: CompactBoundary | undefined;
  /** Relinked blocks whose anchor entry has not arrived yet, keyed by the
   *  anchor uuid, each with the raw nodes deferred behind it: flushed in
   *  order right after the anchor's raw node is set. */
  private readonly pendingBlockByAnchor = new Map<
    UUID,
    { boundaryUuid: UUID; edges: [TreeNodeStr, TreeNodeStr][] }
  >();
  /** Node (block node or raw node deferred behind one) → the anchor uuid
   *  whose pending block holds it. */
  private readonly deferredAnchorOf = new Map<TreeNodeStr, UUID>();
  private finished = false;

  constructor(onInvalid: OnInvalid) {
    this.onInvalid = onInvalid;
  }

  get awaitingAnchors(): readonly UUID[] {
    return [...this.pendingBlockByAnchor.values()].map(
      (pending) => pending.boundaryUuid,
    );
  }

  pushAll(entries: readonly SessionEntry[]): void {
    for (const entry of entries) {
      this.push(entry);
    }
  }

  /** Place `entry` (and flush any deferred block nodes it unblocks). */
  push(entry: SessionEntry): void {
    if (this.finished) {
      throw new Error("SessionTreeBuilder: push after finish");
    }
    if (entry.uuid === undefined) {
      return;
    }
    const node = formatTreeNodeRef({ uuid: entry.uuid });
    if (this.parentMap.has(node) || this.deferredAnchorOf.has(node)) {
      return; // a re-persisted copy of a placed or deferred node: first-wins
    }
    const parentRef = effectiveParent(this.latest, entry);
    const parent =
      parentRef === undefined ? null : formatTreeNodeRef(parentRef);
    // A boundary is never deferred: its own relink must run at its file
    // position (it becomes the latest boundary). Its tree parent is its
    // logicalParentUuid, which no producer points at a pending block node.
    const parentAnchor =
      parent === null || entry.subtype === "compact_boundary"
        ? undefined
        : this.deferredAnchorOf.get(parent);
    if (parent !== null && parentAnchor !== undefined) {
      this.deferBehind(parentAnchor, [node, parent]);
      return;
    }
    this.setParent(node, parent);
    this.flushBlock(entry.uuid);
    if (entry.subtype !== "compact_boundary") {
      return;
    }

    this.latest = undefined;
    const boundary = compactBoundaryOf(entry);
    const invalidReason = invalidRelinkReason(this.parentMap, boundary);
    if (invalidReason !== undefined) {
      this.onInvalid(
        `boundary ${boundary.uuid}: relink skipped — ${invalidReason}`,
      );
      return;
    }
    const preservedUuids = boundary.preservedMessages.uuids;
    const block: [TreeNodeStr, TreeNodeStr][] = preservedUuids.map(
      (preservedUuid, preservedIndex) => [
        formatTreeNodeRef({ uuid: preservedUuid, viaBoundary: boundary.uuid }),
        formatTreeNodeRef(parentOfPreserved(boundary, preservedIndex)),
      ],
    );
    const anchorUuid = boundary.preservedMessages.anchorUuid;
    if (this.parentMap.has(anchorUuid)) {
      for (const [blockNode, blockParent] of block) {
        this.setParent(blockNode, blockParent);
      }
    } else if (block.length > 0) {
      this.pendingBlockByAnchor.set(anchorUuid, {
        boundaryUuid: boundary.uuid,
        edges: [],
      });
      for (const edge of block) {
        this.deferBehind(anchorUuid, edge);
      }
    }
    if (preservedUuids.length > 0) {
      this.latest = boundary;
    }
  }

  /** End of input: place nodes still deferred behind an anchor that never
   *  arrived. The daemon never calls it; the live view simply omits such
   *  nodes until their anchor arrives. */
  finish(): void {
    this.finished = true;
    for (const anchorUuid of [...this.pendingBlockByAnchor.keys()]) {
      this.flushBlock(anchorUuid);
    }
  }

  private setParent(node: TreeNodeStr, parent: TreeNodeStr | null): void {
    if (parent !== null && !this.parentMap.has(parent)) {
      if (node.includes("@")) {
        this.onInvalid(
          `relinked occurrence ${node}: parent ${parent} names no tree occurrence — treating as root`,
        );
      }
      parent = null;
    }
    this.parentMap.set(node, parent);
    this.nodes.push(node);
  }

  private deferBehind(
    anchorUuid: UUID,
    edge: [TreeNodeStr, TreeNodeStr],
  ): void {
    this.pendingBlockByAnchor.get(anchorUuid)!.edges.push(edge);
    this.deferredAnchorOf.set(edge[0], anchorUuid);
  }

  private flushBlock(anchorUuid: UUID): void {
    for (const [node, parent] of this.pendingBlockByAnchor.get(anchorUuid)
      ?.edges ?? []) {
      this.setParent(node, parent);
      this.deferredAnchorOf.delete(node);
    }
    this.pendingBlockByAnchor.delete(anchorUuid);
  }
}

/** The whole-file tree: a SessionTreeBuilder fed `entries` and finished. */
export function buildTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): ParentMap {
  const builder = new SessionTreeBuilder(onInvalid);
  builder.pushAll(entries);
  builder.finish();
  return builder.parentMap;
}
