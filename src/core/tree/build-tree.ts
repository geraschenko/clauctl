/**
 * The full occurrence tree over raw jsonl entries: what `raw` filter mode
 * shows, and the superset every navigation target lives in (see
 * docs/specs/session-tree.md). All relink rules live in loader.ts.
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session/file.ts";
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
 *  through the latest boundary encountered so far (effectiveParent, which
 *  yields `uuid@B` refs when the parent uuid is among that boundary's
 *  preserved uuids), plus each valid boundary's relinked block
 *  `uuids[i]@B → parentOfPreserved(i)` at the boundary's file position
 *  (the block's one genuine forward reference is the up_to anchor's raw
 *  occurrence, which arrives after the boundary; a final pass nulls
 *  parents that never materialized). EVERY encountered boundary becomes
 *  the latest — an invalid or empty boundary contributes no rules but
 *  still ends the previous boundary's effect (last-wins).
 *  Exactly one raw occurrence per uuid-bearing entry — a duplicate occurrence
 *  key is first-wins: the repeat entry is skipped entirely — no edge
 *  overwrite, no re-emitted block, and a re-appended boundary entry does
 *  not become the latest boundary. Silent — a legal CLI file shape (the
 *  CLI re-persists dropped history; see Edge cases in
 *  docs/specs/session-tree.md). */
export function buildTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): ParentMap {
  // Validation is anywhere-in-file (loader-faithful).
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
  let latest: CompactBoundary | undefined;

  for (const [index, entry] of entries.entries()) {
    if (entry.uuid === undefined) {
      continue;
    }
    const key = formatTreeNodeRef({ uuid: entry.uuid });
    if (parentMap.has(key)) {
      continue; // a re-persisted copy, skipped entirely (first-wins)
    }
    const parentRef = effectiveParent(latest, entry);
    parentMap.set(
      key,
      parentRef === undefined ? null : formatTreeNodeRef(parentRef),
    );
    if (entry.subtype !== "compact_boundary") {
      continue;
    }

    latest = undefined;
    const boundary = compactBoundaryAt(entries, index);
    const invalidReason = invalidRelinkReason(fileUuids, boundary);
    if (invalidReason !== undefined) {
      onInvalid(`boundary ${boundary.uuid}: relink skipped — ${invalidReason}`);
      continue;
    }
    const preservedUuids = boundary.preservedMessages.uuids;
    for (const [preservedIndex, preservedUuid] of preservedUuids.entries()) {
      parentMap.set(
        formatTreeNodeRef({ uuid: preservedUuid, viaBoundary: boundary.uuid }),
        formatTreeNodeRef(parentOfPreserved(boundary, preservedIndex)),
      );
    }
    if (preservedUuids.length > 0) {
      latest = boundary;
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
