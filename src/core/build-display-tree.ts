/**
 * The linearized display tree: the session tree as `buildTree` computes it,
 * minus the boundary-block forks and duplicated preserved messages. Relinked
 * occurrences are hidden (a message's single row is its raw occurrence;
 * exception: a from-shape summary's only occurrence is relinked, and it
 * stays as the block tail row), each valid-relink boundary re-anchors at the
 * display row of the last preserved uuid, and children of hidden relinked
 * occurrences attach to the boundary's block tail (summary row if present,
 * else the boundary row). Summary-less valid-relink boundaries with no
 * displayed descendants are hidden entirely (fixpoint, so stacked
 * navigation boundaries cascade away). Display-only: what the loader and
 * `effectiveTreeNodeChain` see is untouched. Spec:
 * docs/specs/boundary-display-linearization.md.
 */

import type { UUID } from "node:crypto";
import {
  summaryOf,
  validRelink,
  type BoundaryRelink,
  type OnInvalid,
} from "./effective-chain.ts";
import type { SessionEntry } from "./session-file.ts";
import { formatTreeNodeRef, type ParentMap, type TreeNodeRef } from "./tree.ts";

export interface DisplayTree {
  /** Linearized parent relation per the display-tree rules. */
  parentMap: ParentMap;
  /** Hidden occurrence id → visible display row id. Exhaustive: one entry
   *  for every omitted relinked occurrence and every hidden boundary row;
   *  values are transitively resolved AFTER the hidden-boundary fixpoint
   *  and are always keys of `parentMap`. For leaf-marker mapping. */
  representativeOf: Map<string, string>;
}

/**
 * Built by its own forward replay of the entries (not a post-transform of
 * `buildTree` output): the re-anchor target is the running uuid → display
 * row state mid-replay, which the finished ParentMap alone does not retain.
 * The replay mirrors `buildTree`'s loop shape, including the
 * pending-relink deferral to the summary's file position and the loud
 * duplicate-occurrence throw on corrupt files. Boundaries without a valid
 * relink keep their `logicalParentUuid` anchor and are always visible (the
 * loader still honors them as context cuts).
 */
export function buildDisplayTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): DisplayTree {
  const parentMap = new Map<string, string | null>();
  const representativeOf = new Map<string, string>();
  /** The current display row for each uuid; applying a relink overwrites
   *  the preserved uuids to the block tail, so post-boundary entries and
   *  later boundaries' anchors land there. */
  const displayRowOf = new Map<UUID, string>();
  /** Summary-less valid-relink boundary rows — hidden when childless. */
  const prunable = new Set<string>();

  const attach = (ref: TreeNodeRef, parent: string | null): void => {
    const key = formatTreeNodeRef(ref);
    if (parentMap.has(key)) {
      throw new Error(
        `duplicate occurrence ${key} — the session file is corrupt`,
      );
    }
    parentMap.set(key, parent);
    displayRowOf.set(ref.uuid, key);
  };

  const displayRow = (parentUuid: UUID | undefined): string | null =>
    parentUuid === undefined ? null : (displayRowOf.get(parentUuid) ?? null);

  /** Hide the relinked occurrences behind the block tail: each `uuid@B` id
   *  maps to the tail (the from-shape summary's own relinked row IS the
   *  tail and stays displayed), and the preserved uuids' display rows
   *  become the tail. */
  const applyRelink = (
    boundaryUuid: UUID,
    relink: BoundaryRelink,
    blockTail: string,
  ): void => {
    for (const relinkedUuid of relink.relinkedUuids) {
      const key = formatTreeNodeRef({
        uuid: relinkedUuid,
        viaBoundary: boundaryUuid,
      });
      if (key !== blockTail) {
        representativeOf.set(key, blockTail);
      }
      displayRowOf.set(relinkedUuid, blockTail);
    }
  };

  let pendingRelink:
    | { summaryUuid: UUID; boundaryUuid: UUID; relink: BoundaryRelink }
    | undefined;

  for (const [index, entry] of entries.entries()) {
    if (entry.uuid === undefined) {
      continue;
    }
    if (entry.uuid !== pendingRelink?.summaryUuid) {
      if (entry.subtype !== "compact_boundary") {
        attach({ uuid: entry.uuid }, displayRow(entry.parentUuid ?? undefined));
        continue;
      }
      const relink = validRelink(entries, index, onInvalid);
      if (relink === undefined) {
        attach(
          { uuid: entry.uuid },
          displayRow(entry.parentUuid ?? entry.logicalParentUuid ?? undefined),
        );
        continue;
      }
      const summaryUuid = summaryOf(entries, index)?.uuid;
      // The re-anchor target: the last preserved uuid's display row as of
      // just before this relink (composes across stacked boundaries). The
      // from-shape relink list ends in the summary — anchor on the
      // preserved uuids, not on it.
      const lastPreservedUuid = relink.relinkedUuids
        .filter((relinkedUuid) => relinkedUuid !== summaryUuid)
        .at(-1)!;
      attach({ uuid: entry.uuid }, displayRow(lastPreservedUuid));
      if (summaryUuid !== undefined) {
        pendingRelink = { summaryUuid, boundaryUuid: entry.uuid, relink };
      } else {
        const boundaryKey = formatTreeNodeRef({ uuid: entry.uuid });
        prunable.add(boundaryKey);
        applyRelink(entry.uuid, relink, boundaryKey);
      }
      continue;
    }
    // The pending boundary's summary: the block tail row. Its display
    // parent is the boundary row in BOTH shapes; in from-shape the row is
    // the relinked occurrence (the raw summary occurrence is omitted).
    const { boundaryUuid, relink } = pendingRelink;
    pendingRelink = undefined;
    const tailRef: TreeNodeRef = relink.relinkedUuids.includes(entry.uuid)
      ? { uuid: entry.uuid, viaBoundary: boundaryUuid }
      : { uuid: entry.uuid };
    attach(tailRef, formatTreeNodeRef({ uuid: boundaryUuid }));
    applyRelink(boundaryUuid, relink, formatTreeNodeRef(tailRef));
  }

  // Hidden-boundary fixpoint: drop childless prunable boundary rows, so
  // stacked navigation boundaries (each anchored on the previous) cascade
  // away. Child counts + a work queue keep this O(n): deleting a row
  // decrements its parent's count, which may queue the parent in turn.
  // A prunable boundary's parent is never null: its anchor is the last
  // preserved uuid's display row, and preserved uuids always name earlier
  // attached entries — so a null here is corruption, thrown loudly to keep
  // `representativeOf` values resolvable to display rows.
  const childCountOf = new Map<string, number>();
  for (const parent of parentMap.values()) {
    if (parent !== null) {
      childCountOf.set(parent, (childCountOf.get(parent) ?? 0) + 1);
    }
  }
  const prunedParentOf = new Map<string, string>();
  const pruneQueue = [...prunable].filter(
    (boundaryKey) => (childCountOf.get(boundaryKey) ?? 0) === 0,
  );
  while (pruneQueue.length > 0) {
    const boundaryKey = pruneQueue.pop()!;
    const parent = parentMap.get(boundaryKey)!;
    if (parent === null) {
      throw new Error(
        `hidden boundary ${boundaryKey} has no display anchor — the session file is corrupt`,
      );
    }
    prunedParentOf.set(boundaryKey, parent);
    parentMap.delete(boundaryKey);
    const parentChildCount = childCountOf.get(parent)! - 1;
    childCountOf.set(parent, parentChildCount);
    if (parentChildCount === 0 && prunable.has(parent)) {
      pruneQueue.push(parent);
    }
  }

  // Resolve representatives through the pruned rows onto surviving keys.
  // Path compression (rewriting each walked link to the final target)
  // keeps the whole resolution amortized O(n) across stacked chains.
  const resolve = (id: string): string => {
    const walked: string[] = [];
    let current = id;
    while (prunedParentOf.has(current)) {
      walked.push(current);
      current = prunedParentOf.get(current)!;
    }
    for (const link of walked) {
      prunedParentOf.set(link, current);
    }
    return current;
  };
  for (const [boundaryKey, parent] of prunedParentOf) {
    representativeOf.set(boundaryKey, resolve(parent));
  }
  for (const [hiddenId, representative] of representativeOf) {
    const resolved = resolve(representative);
    if (resolved !== representative) {
      representativeOf.set(hiddenId, resolved);
    }
  }

  return { parentMap, representativeOf };
}
