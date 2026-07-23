/**
 * The full occurrence tree over raw jsonl entries: what `raw` filter mode
 * shows, and the superset every navigation target lives in (see
 * docs/specs/session-tree.md). All relink rules live in loader.ts.
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session-file.ts";
import { formatTreeNodeRef, type ParentMap } from "./nodes.ts";
import {
  compactBoundaryAt,
  effectiveParent,
  invalidRelinkReason,
  parentOfPreserved,
  type CompactBoundary,
  type OnInvalid,
} from "./loader.ts";

/** Every occurrence: raw entries under their parents as interpreted
 *  through the latest boundary encountered so far (effectiveParent,
 *  decorated to `uuid@B` keys when the parent uuid is among that
 *  boundary's preserved uuids), plus each boundary's relinked block
 *  `uuids[i]@B → preservedParent(i)` — emitted only when the boundary
 *  carries preservedMessages AND invalidRelinkReason returns undefined —
 *  at the boundary's file position (the block's one genuine forward
 *  reference is the up_to anchor's raw occurrence, which arrives after
 *  the boundary; a final pass nulls parents that never materialized). EVERY
 *  encountered boundary becomes the latest — an invalid, empty, or
 *  metadata-less boundary contributes no rules but still ends the
 *  previous boundary's effect (last-wins). Boundary entries anchor at
 *  logicalParentUuid, resolved through the boundary in effect before
 *  them like any other parent reference.
 *  Exactly one raw occurrence per uuid-bearing entry — a duplicate occurrence
 *  key is first-wins: the repeat entry is skipped entirely — no edge
 *  overwrite, no re-emitted block, and a re-appended boundary entry does
 *  not become the latest boundary. Silent — a legal CLI file shape (the
 *  CLI re-persists dropped history; see the spec's Edge cases). */
export function buildTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): ParentMap {
  // Step-3 validation is anywhere-in-file (loader-faithful).
  const fileUuids = new Set<UUID>();
  for (const entry of entries) {
    if (entry.uuid !== undefined) {
      fileUuids.add(entry.uuid);
    }
  }

  const parentMap = new Map<string, string | null>();
  /** The latest boundary encountered so far, tracked only while its relink
   *  applied (valid, non-empty): a boundary with no applicable relink ends
   *  the previous boundary's effect and contributes no rules, which this
   *  represents as undefined. */
  let latest:
    { boundary: CompactBoundary; preservedSet: ReadonlySet<UUID> } | undefined;

  for (const [index, entry] of entries.entries()) {
    if (entry.uuid === undefined) {
      continue;
    }
    const key = formatTreeNodeRef({ uuid: entry.uuid });
    if (parentMap.has(key)) {
      continue; // a re-persisted copy, skipped entirely (first-wins)
    }
    const isBoundaryEntry = entry.subtype === "compact_boundary";
    // Boundaries carry parentUuid null; their tree anchor is
    // logicalParentUuid, resolved through the boundary in effect before
    // them like any other parent reference.
    const anchored: SessionEntry = isBoundaryEntry
      ? { ...entry, parentUuid: entry.parentUuid ?? entry.logicalParentUuid }
      : entry;
    const parentUuid =
      latest === undefined
        ? (anchored.parentUuid ?? undefined)
        : effectiveParent(latest.boundary, anchored);
    const parentKey =
      parentUuid === undefined
        ? null
        : latest !== undefined && latest.preservedSet.has(parentUuid)
          // TDC: here we should be using formatTreeNodeRef regardless. But we should set viaBoundary based on the above condition. DO NOT assume that formatTreeNodeRef({uuid, undefined}) === uuid.
          ? formatTreeNodeRef({
              uuid: parentUuid,
              viaBoundary: latest.boundary.uuid,
            })
          : parentUuid;
    parentMap.set(key, parentKey);
    if (!isBoundaryEntry) {
      continue;
    }

    latest = undefined;
    const boundary = compactBoundaryAt(entries, index);
    if (boundary.preservedMessages === undefined) {
      continue;
    }
    const invalidReason = invalidRelinkReason(fileUuids, boundary);
    if (invalidReason !== undefined) {
      onInvalid(`boundary ${boundary.uuid}: relink skipped — ${invalidReason}`);
      continue;
    }
    const preservedUuids = boundary.preservedMessages.uuids;
    for (const [preservedIndex, preservedUuid] of preservedUuids.entries()) {
      const blockParent = parentOfPreserved(boundary, preservedIndex);
      parentMap.set(
        formatTreeNodeRef({ uuid: preservedUuid, viaBoundary: boundary.uuid }),
        blockParent === undefined
          ? null
          // TDC: the fact that we have to do this dance here suggests that preservedParent should return a TreeNodeRef, not a UUID. The caller should not have to know whether to set viaBoundary.
          : preservedIndex === 0
            ? blockParent // the anchor's raw occurrence
            : formatTreeNodeRef({
                uuid: blockParent,
                viaBoundary: boundary.uuid,
              }),
      );
    }
    if (preservedUuids.length > 0) {
      latest = { boundary, preservedSet: new Set(preservedUuids) };
    }
  }

  // Parent keys that never materialized become roots. Raw rows keep the old
  // silent root fallback (a raw parentUuid pointing at nothing); a relinked
  // row's dangling parent (an anchor entry that never arrived) is corrupt
  // and reported.
  for (const [key, parent] of parentMap) {
    if (parent !== null && !parentMap.has(parent)) {
      parentMap.set(key, null);
      if (key.includes("@")) {
        onInvalid(
          `relinked occurrence ${key}: parent ${parent} names no tree occurrence — treating as root`,
        );
      }
    }
  }
  return parentMap;
}
