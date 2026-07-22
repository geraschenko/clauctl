/**
 * The session tree over raw jsonl entries. Probe ids in comments
 * (e.g. p0b/p0c) cite the experiments in
 * docs/derisk/compact-boundary-injection/FINDINGS.md.
 */

import type { UUID } from "node:crypto";
import {
  summaryOf,
  validRelink,
  type BoundaryRelink,
  type OnInvalid,
} from "./effective-chain.ts";
import { entriesByUuid, type SessionEntry } from "./session-file.ts";
import { formatTreeNodeRef, type ParentMap, type TreeNodeRef } from "./tree.ts";

/**
 * Raw parentUuid edges give the base tree; each boundary node is attached
 * as a child of its logicalParentUuid entry (root if absent). A boundary
 * with a valid relink additionally emits its relinked context as
 * substructure: one `viaBoundary` occurrence per relinked uuid, chained per
 * the relink parent map — under the raw summary occurrence (up_to) or
 * directly under the boundary occurrence (from-shape, ending in the relinked
 * summary, whose raw occurrence is omitted). Attachment resolves through a
 * running uuid → occurrence map that a processed relink overwrites, so
 * post-boundary entries and later boundaries' anchors land on relinked
 * occurrences — the effective-chain logic, applied forward. An invalid
 * relink emits nothing and leaves the map untouched, matching the loader's
 * skip.
 *
 * Throws on a duplicate occurrence key: valid files cannot produce one
 * (raw uuids are unique per file, relink validation rejects duplicates), so
 * a duplicate means the session file is corrupt — the error is loud so the
 * user learns about it.
 *
 * logicalParentUuid is not interpreted by the loader — it exists for tree
 * anchoring, and we set it ourselves when building a boundary (= the active
 * leaf at set-context time). Native boundaries follow the same idea: always
 * the last message before the summarization point (full /compact: the
 * pre-compaction leaf; up_to: the last entry of the summarized segment;
 * from: the last preserved entry = parent of the first summarized message —
 * confirmed in the p0b/p0c captures; see file comment). Native summary
 * entries parent onto the boundary in BOTH shapes, so parentUuid-based
 * tree construction stays correct without special-casing.
 */
// TDC: The basic thing this is doing besides just following parentUuid is extracting (in tree form) the stuff from the entry list that depends on the exact order of the entries, not just the parentUuid tree. The key thing is that parentUuid has to be interpreted in the context of the most recent boundary _entry_ (i.e. it really means "parentUuid@viaBoundary" if it exists and "parentUuid" otherwise). The other thing it's doing is saying that the first message in context is the boundary's anchorUuid, then the preserved uuids, and that any message whose parent is the anchorUuid is reparented onto the end of the boundary chain ... or something like that; I'm getting a bit confused again. 
export function buildTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): ParentMap {
  const byUuid = entriesByUuid(entries);
  const parentMap = new Map<string, string | null>();
  /** The current occurrence id for each uuid; a processed relink
   *  overwrites. */
  const occurrenceOf = new Map<UUID, string>();

  const attach = (ref: TreeNodeRef, parentUuid: UUID | undefined): void => {
    const key = formatTreeNodeRef(ref);
    if (parentMap.has(key)) {
      throw new Error(
        `duplicate occurrence ${key} — the session file is corrupt`,
      );
    }
    // A parent uuid pointing at nothing (or at an entry later in the file,
    // which append order rules out) falls back to a root.
    const parent =
      parentUuid === undefined ? undefined : occurrenceOf.get(parentUuid);
    parentMap.set(key, parent ?? null);
    occurrenceOf.set(ref.uuid, key);
  };

  const emitSubstructure = (
    boundaryUuid: UUID,
    relink: BoundaryRelink,
  ): void => {
    for (const relinkedUuid of relink.relinkedUuids) {
      // Preserved uuids name earlier entries (validity), so byUuid has them;
      // the from-shape summary is the entry being processed right now.
      const entry = byUuid.get(relinkedUuid)!;
      // Same parent resolution as the chain walk: relink map first, raw
      // parentUuid otherwise (only reachable for uuids[0] with no anchor).
      attach(
        { uuid: relinkedUuid, viaBoundary: boundaryUuid },
        relink.parentMap.get(relinkedUuid) ?? entry.parentUuid ?? undefined,
      );
    }
  };

  // A valid relink whose boundary has a summary defers its substructure to
  // the summary's file position — the up_to anchor (the summary occurrence)
  // does not exist before then. At most one relink is pending at a time: a
  // summary follows its boundary before the next boundary in any
  // CLI/clauctl-written file (in a hand-crafted interleaving, the later
  // boundary would displace the earlier pending substructure).
  let pendingRelink:
    | { summaryUuid: UUID; boundaryUuid: UUID; relink: BoundaryRelink }
    | undefined;

  for (const [index, entry] of entries.entries()) {
    if (entry.uuid === undefined) {
      continue;
    }
    if (entry.uuid !== pendingRelink?.summaryUuid) {
      // Boundaries carry parentUuid null; their tree anchor is
      // logicalParentUuid.
      const parentUuid =
        entry.parentUuid ??
        (entry.subtype === "compact_boundary"
          ? (entry.logicalParentUuid ?? undefined)
          : undefined);
      attach({ uuid: entry.uuid }, parentUuid);
      if (entry.subtype === "compact_boundary") {
        const relink = validRelink(entries, index, onInvalid);
        if (relink !== undefined) {
          // TDC: this is sloppy. validRelink has already computed what the summary is (if any) and whether it is the boundary's anchorUuid. My understanding is that summaryOf (lookahead and checking isCompactSummary) might not even be necessary. The rule is just that the first preserved uuid is reparented onto the anchor and children of the anchor are reparented onto the last preserved uuid, right? This means that to properly build the tree, we just need to keep the last boundary's `preserved_messages` field. When we encounter a new entry, first check the uuid. If it's anchorUuid, set the parent to the boundary. Else look at it's parentUuid. If it's preserved_messages.anchorUuid, then set the parent to `preserved_messages.uuids.last()@viaBoundary`; else if it's in preserved_messages.uuids, then set the parent to `parentUuid@viaBoundary`; else set the parent to parentUuid. Is that correct? Validate against our derisk findings *very carefully*. If this is correct, I think we can substantially simplify buildTree and effective-chain.ts.
          const summaryUuid = summaryOf(entries, index)?.uuid;
          if (summaryUuid !== undefined) {
            pendingRelink = { summaryUuid, boundaryUuid: entry.uuid, relink };
          } else {
            emitSubstructure(entry.uuid, relink);
          }
        }
      }
      continue;
    }
    // The pending boundary's summary: emit the deferred substructure here.
    // In from-shape the summary is itself relinked and its raw placement is
    // omitted (a raw occurrence under the boundary would fork the relinked
    // chain).
    const { boundaryUuid, relink } = pendingRelink;
    pendingRelink = undefined;
    if (!relink.relinkedUuids.includes(entry.uuid)) {
      // TDC: We should make this attach unconditional.
      attach({ uuid: entry.uuid }, entry.parentUuid ?? undefined);
    }
    emitSubstructure(boundaryUuid, relink);
  }
  return parentMap;
}
