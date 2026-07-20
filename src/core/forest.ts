/**
 * The session forest over raw jsonl entries. Probe ids in comments
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
import {
  formatTreeNodeRef,
  type Forest,
  type ForestNode,
  type TreeNodeRef,
} from "./tree.ts";

/**
 * Raw parentUuid edges give the base forest; each boundary node is attached
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
 * forest construction stays correct without special-casing.
 */
export function buildForest(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): Forest {
  const byUuid = entriesByUuid(entries);
  const forest = new Map<string, ForestNode>();
  /** The current occurrence for each uuid; a processed relink overwrites. */
  const occurrenceOf = new Map<UUID, TreeNodeRef>();

  const place = (ref: TreeNodeRef, parentUuid: UUID | undefined): void => {
    const key = formatTreeNodeRef(ref);
    if (forest.has(key)) {
      throw new Error(
        `duplicate occurrence ${key} — the session file is corrupt`,
      );
    }
    // A parent uuid pointing at nothing (or at an entry later in the file,
    // which append order rules out) falls back to a root.
    const parent =
      parentUuid === undefined ? undefined : occurrenceOf.get(parentUuid);
    forest.set(key, { ref, parent: parent ?? null });
    occurrenceOf.set(ref.uuid, ref);
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
      place(
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
      place({ uuid: entry.uuid }, parentUuid);
      if (entry.subtype === "compact_boundary") {
        const relink = validRelink(entries, index, onInvalid);
        if (relink !== undefined) {
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
      place({ uuid: entry.uuid }, entry.parentUuid ?? undefined);
    }
    emitSubstructure(boundaryUuid, relink);
  }
  return forest;
}
