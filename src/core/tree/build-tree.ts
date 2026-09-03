/**
 * The full occurrence tree over raw jsonl entries: what `raw` filter mode
 * shows, and the superset every navigation target lives in (see
 * docs/specs/session-tree.md). All relink rules live in loader.ts.
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session/file.ts";
import { formatTreeNodeRef, type ParentMap } from "./nodes.ts";
import {
  compactBoundaryOf,
  effectiveParent,
  invalidRelinkReason,
  parentOfPreserved,
  type CompactBoundary,
  type OnInvalid,
} from "./loader.ts";

/** Every occurrence — one raw row per uuid (first-wins) plus relinked
 *  block rows — in an order where each row follows its parent: raw rows at file position with parents read
 *  through the latest boundary (effectiveParent), each valid boundary's
 *  relinked block right after its anchor's row, and raw rows parented on
 *  a not-yet-materialized block row deferred behind it. Rules and edge
 *  cases (last-wins boundaries, first-wins duplicates, dangling anchors)
 *  in docs/specs/session-tree.md. */
export function buildTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): ParentMap {
  const parentMap = new Map<string, string | null>();
  const setParent = (key: string, parent: string | null): void => {
    if (parent !== null && !parentMap.has(parent)) {
      if (key.includes("@")) {
        onInvalid(
          `relinked occurrence ${key}: parent ${parent} names no tree occurrence — treating as root`,
        );
      }
      parent = null;
    }
    parentMap.set(key, parent);
  };
  /** The latest boundary encountered so far, tracked only while its relink
   *  applied (valid, non-empty): a boundary with no applicable relink ends
   *  the previous boundary's effect and contributes no rules, which this
   *  represents as undefined. */
  let latest: CompactBoundary | undefined;
  /** Relinked blocks whose anchor entry has not arrived yet, keyed by the
   *  anchor uuid, each with the raw rows deferred behind it: flushed in
   *  order right after the anchor's raw row is set. */
  const pendingBlockByAnchor = new Map<UUID, [string, string][]>();
  /** Row key (block row or raw row deferred behind one) → the anchor uuid
   *  whose pending block holds it. */
  const deferredAnchorOf = new Map<string, UUID>();
  const deferBehind = (anchorUuid: UUID, row: [string, string]): void => {
    pendingBlockByAnchor.get(anchorUuid)!.push(row);
    deferredAnchorOf.set(row[0], anchorUuid);
  };
  const flushBlock = (anchorUuid: UUID): void => {
    for (const [rowKey, rowParent] of pendingBlockByAnchor.get(anchorUuid) ??
      []) {
      setParent(rowKey, rowParent);
      deferredAnchorOf.delete(rowKey);
    }
    pendingBlockByAnchor.delete(anchorUuid);
  };

  for (const entry of entries) {
    if (entry.uuid === undefined) {
      continue;
    }
    const key = formatTreeNodeRef({ uuid: entry.uuid });
    if (parentMap.has(key) || deferredAnchorOf.has(key)) {
      continue; // a re-persisted copy of a placed or deferred row: first-wins
    }
    const parentRef = effectiveParent(latest, entry);
    const parent =
      parentRef === undefined ? null : formatTreeNodeRef(parentRef);
    // A boundary is never deferred: its own relink must run at its file
    // position (it becomes the latest boundary). Its tree parent is its
    // logicalParentUuid, which no producer points at a pending block row.
    const parentAnchor =
      parent === null || entry.subtype === "compact_boundary"
        ? undefined
        : deferredAnchorOf.get(parent);
    if (parent !== null && parentAnchor !== undefined) {
      deferBehind(parentAnchor, [key, parent]);
      continue;
    }
    setParent(key, parent);
    flushBlock(entry.uuid);
    if (entry.subtype !== "compact_boundary") {
      continue;
    }

    latest = undefined;
    const boundary = compactBoundaryOf(entry);
    const invalidReason = invalidRelinkReason(parentMap, boundary);
    if (invalidReason !== undefined) {
      onInvalid(`boundary ${boundary.uuid}: relink skipped — ${invalidReason}`);
      continue;
    }
    const preservedUuids = boundary.preservedMessages.uuids;
    const block: [string, string][] = preservedUuids.map(
      (preservedUuid, preservedIndex) => [
        formatTreeNodeRef({ uuid: preservedUuid, viaBoundary: boundary.uuid }),
        formatTreeNodeRef(parentOfPreserved(boundary, preservedIndex)),
      ],
    );
    const anchorUuid = boundary.preservedMessages.anchorUuid;
    if (parentMap.has(anchorUuid)) {
      for (const [blockKey, blockParent] of block) {
        setParent(blockKey, blockParent);
      }
    } else if (block.length > 0) {
      pendingBlockByAnchor.set(anchorUuid, []);
      for (const row of block) {
        deferBehind(anchorUuid, row);
      }
    }
    if (preservedUuids.length > 0) {
      latest = boundary;
    }
  }
  for (const anchorUuid of [...pendingBlockByAnchor.keys()]) {
    flushBlock(anchorUuid);
  }
  return parentMap;
}
