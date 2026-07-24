/**
 * The CLI loader's load-time transform, ported from the decompiled binary
 * (v2.1.195). The "Ground truth" section of docs/specs/session-tree.md
 * records the transform and the extraction method; probe ids (e.g. P10,
 * P3 m4) cite docs/derisk/compact-boundary-injection/FINDINGS.md. This
 * module owns every relink rule — buildTree and the display transform call
 * in here rather than restating any of them.
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session-file.ts";
import type { TreeNodeRef } from "./nodes.ts";

/** Sink for corrupt-session-file diagnostics (an invalid relink, a
 *  parentUuid cycle). Required so ignoring them is a visible choice at the
 *  call site — pass `() => {}` to declare it. */
export type OnInvalid = (message: string) => void;

/** A compact_boundary entry's relink instruction, mirroring the jsonl
 *  field names. Validity is a separate question (invalidRelinkReason) —
 *  parsing and validation are distinct in the binary too. */
export interface CompactBoundary {
  uuid: UUID;
  preservedMessages: { anchorUuid: UUID; uuids: UUID[] };
}

/** Parse the boundary at entries[boundaryIndex]. Precondition: that entry
 *  is a uuid-bearing compact_boundary — throws otherwise (caller bug, not
 *  file corruption). Absent preservedMessages ("unset when compaction
 *  summarizes everything" per the SDK; also legacy segment-only boundaries)
 *  normalizes to the equivalent wipe `{anchorUuid: boundary, uuids: []}` —
 *  nothing pre-boundary survives either way (see the spec's Edge cases for
 *  the one divergence this creates). Present-but-malformed metadata throws:
 *  that is file corruption, not a shape any producer writes. */
export function compactBoundaryAt(
  entries: SessionEntry[],
  boundaryIndex: number,
): CompactBoundary {
  const entry = entries[boundaryIndex];
  if (entry?.subtype !== "compact_boundary" || entry.uuid === undefined) {
    throw new Error(
      `compactBoundaryAt: entries[${boundaryIndex}] is not a uuid-bearing compact_boundary`,
    );
  }
  const metadata = entry.compactMetadata as
    { preservedMessages?: { anchorUuid?: UUID; uuids?: unknown } } | undefined;
  const preserved = metadata?.preservedMessages;
  if (preserved === undefined) {
    return {
      uuid: entry.uuid,
      preservedMessages: { anchorUuid: entry.uuid, uuids: [] },
    };
  }
  if (!Array.isArray(preserved.uuids) || preserved.anchorUuid === undefined) {
    throw new Error(
      `compactBoundaryAt: boundary ${entry.uuid} has malformed preservedMessages`,
    );
  }
  return {
    uuid: entry.uuid,
    preservedMessages: {
      anchorUuid: preserved.anchorUuid,
      uuids: preserved.uuids as UUID[],
    },
  };
}

/** The reason this boundary's relink must not apply, or undefined when it
 *  is valid. Validation is anywhere-in-file: a preserved uuid may name an
 *  entry after the boundary (see the spec's Edge cases). */
// TDC: you can't say "see the spec's Edge cases" ... you have to say which spec. We have lots of specs, and the reader doesn't know which you're talking about. Give the file path. Note that there are going to be lots of specs that touch lots of files. You cannot assume that this file is associated with a single spec. It's not.
export function invalidRelinkReason(
  fileUuids: ReadonlySet<UUID>,
  boundary: CompactBoundary,
): string | undefined {
  const preserved = boundary.preservedMessages;
  if (new Set(preserved.uuids).size !== preserved.uuids.length) {
    // Probe-observed invalid (P3 m4; see file comment).
    return "duplicated uuid in preservedMessages.uuids";
  }
  if (preserved.uuids.includes(preserved.anchorUuid)) {
    // Deliberate divergence: the binary's sequential passes self-parent the
    // chain on this shape; rejecting it is also what makes our
    // raw-parents-then-override rule order equivalent to the binary's
    // wherever the relink applies.
    return "anchorUuid appears in preservedMessages.uuids";
  }
  const unknownUuid = preserved.uuids.find((uuid) => !fileUuids.has(uuid));
  if (unknownUuid !== undefined) {
    return `preserved uuid ${unknownUuid} names no file entry`;
  }
  return undefined;
}

/** Loader parent of `entry` under `boundary`'s relink (undefined = no
 *  relink in effect). A compact_boundary entry with no raw parent hangs off
 *  its logicalParentUuid — where the boundary event happened. The
 *  anchor-child rule is written ONLY here: a child of the anchor lands on
 *  the preserved tail; uuids[0] is exempt (its parent is
 *  parentOfPreserved's business — in the binary the chain rewrite has
 *  already run when the anchor-child pass looks, so it never matches). */
export function effectiveParent(
  boundary: CompactBoundary | undefined,
  entry: SessionEntry,
): UUID | undefined {
  const rawParent =
    entry.parentUuid ??
    (entry.subtype === "compact_boundary"
      ? entry.logicalParentUuid
      : undefined) ??
    undefined;
  if (
    boundary !== undefined &&
    boundary.preservedMessages.uuids.length > 0 &&
    rawParent === boundary.preservedMessages.anchorUuid &&
    entry.uuid !== boundary.preservedMessages.uuids[0]
  ) {
    return boundary.preservedMessages.uuids.at(-1);
  }
  return rawParent;
}

/** Parent ref of uuids[index] inside the relinked chain: uuids[0] hangs off
 *  the anchor (a bare ref — the anchor is not itself in uuids), later entries
 *  chain onto their predecessor's relinked occurrence. Throws on an
 *  out-of-range index (caller bug). */
export function parentOfPreserved(
  boundary: CompactBoundary,
  index: number,
): TreeNodeRef {
  const preserved = boundary.preservedMessages;
  if (index < 0 || index >= preserved.uuids.length) {
    throw new Error(
      `parentOfPreserved: boundary ${boundary.uuid} has no preserved uuid at index ${index}`,
    );
  }
  return index === 0
    ? { uuid: preserved.anchorUuid }
    : { uuid: preserved.uuids[index - 1]!, viaBoundary: boundary.uuid };
}

/** Our best estimate of the context the NEXT appended message will see:
 *  the loader transform of the current file — the last boundary's relink
 *  and cut, leaf selection, then the parent walk from the leaf. A trailing
 *  boundary is honored even though the binary applies it only on the next
 *  load, because that next load is exactly what the next appended message
 *  gets. Estimate: downstream request normalization (tool-pair
 *  sanitization, attachment dropping, API-message grouping — FINDINGS
 *  "failure modes") is out of scope. An element carries viaBoundary iff
 *  its uuid is among the boundary's preserved uuids. Duplicated raw uuids
 *  are last-wins, matching the loader's uuid-keyed map (legal re-persisted
 *  copies; see the spec's Edge cases). */
export function loadedContext(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): TreeNodeRef[] {
  const byUuid = new Map<UUID, SessionEntry>();
  const lastIndexOf = new Map<UUID, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
      lastIndexOf.set(entry.uuid, index);
    }
  }

  const cutIndex = entries.findLastIndex(
    (entry) => entry.subtype === "compact_boundary" && entry.uuid !== undefined,
  );
  // TDC: If there's something wrong with the boundary, we can't just pretend it doesn't exist. That's certainly not what the loader does. I think we should probably return an error/undefined in that situation. Running the subsequent parentOf calculation as if there were no boundary is simply wrong. This also simplifies things, because we don't have anything conditional on cutApplies below.
  const boundary =
    cutIndex === -1 ? undefined : compactBoundaryAt(entries, cutIndex);
  // An invalid preserved list aborts the whole transform — no relink AND no
  // cut; the walk sees raw parents only.
  let cutApplies = false;
  if (boundary !== undefined) {
    const abortReason = invalidRelinkReason(new Set(byUuid.keys()), boundary);
    if (abortReason === undefined) {
      cutApplies = true;
    } else {
      onInvalid(`boundary ${boundary.uuid}: relink skipped — ${abortReason}`);
    }
  }
  const preservedUuids = cutApplies ? boundary!.preservedMessages.uuids : [];
  const preservedIndex = new Map(
    preservedUuids.map((preservedUuid, index) => [preservedUuid, index]),
  );
  const preservedTail = preservedUuids.at(-1);  // TDC: this should be the anchor if uuids is empty.
  const relinked = preservedUuids.length > 0;  // TDC: I don't understand the point of this constant.

  /** Cut away by the boundary: last occurrence before it and not preserved. */
  const deleted = (uuid: UUID): boolean => {
    const lastIndex = lastIndexOf.get(uuid);
    return (
      cutApplies &&
      lastIndex !== undefined &&
      lastIndex < cutIndex &&
      !preservedIndex.has(uuid)
    );
  };

  /** The transformed relation, one uuid at a time (must exist in byUuid).
   *  Boundaries end chains: their logical anchoring is tree-domain
   *  placement, not a loaded edge. */
  // TDC: why not just have parentOf take a TreeNodeRef and return a TreeNodeRef? You can make effectiveParent return a TreeNodeRef as well. It makes everything much easier to understand.
  const parentOf = (uuid: UUID): UUID | undefined => {
    const entry = byUuid.get(uuid)!;
    if (entry.subtype === "compact_boundary") {
      return undefined;
    }
    const index = preservedIndex.get(uuid);
    if (index !== undefined) {
      return parentOfPreserved(boundary!, index).uuid;
    }
    const parent = effectiveParent(cutApplies ? boundary : undefined, entry);
    if (
      parent !== undefined &&
      deleted(parent) &&
      (entry.type === "user" || entry.type === "assistant") &&
      preservedTail !== undefined
    ) {
      // A surviving turn whose parent was cut is attached to the preserved
      // tail. This should never happen in a well-formed session file.
      return preservedTail;
    }
    return parent;
  };

  let leaf: UUID | undefined;
  if (relinked) {
    // TDC: I think this is technically correct, but needlessly complicated and confusing. I disagree with your claim that the relinked leaf cannot be derived from the last file entry with a uuid. The algorithm I expect is this: look at the last entry of the file with a uuid. Since the boundary has a uuid, this entry must be equal or later than the boundary. If it's the boundary, the leaf node is entry.uuid@boundary.uuid (there cannot be an anchor which should be the leaf because that would have to come _after_ the boundary, and it hasn't). If it's something other than the boundary, check if it's the boundary's anchor. If so, the leaf is preservedTail. If not, it's the leaf. Whatever leaf you found, walk backwards from there to construct loadedContext.
    // The relinked leaf is not derivable from the last file entry (a file
    // ending at an up_to summary has the preserved tail as its true tip):
    // it is the single dangling tip of the surviving relation, when there
    // is exactly one.
    const survivors = [...byUuid.keys()].filter((uuid) => !deleted(uuid));
    const parents = new Set<UUID | undefined>();
    for (const uuid of survivors) {
      if (byUuid.get(uuid)!.subtype !== "compact_boundary") {
        parents.add(parentOf(uuid));
      }
    }
    const tips = survivors.filter((uuid) => !parents.has(uuid));
    if (tips.length === 1) {
      leaf = tips[0];
    }
  }
  if (leaf === undefined) {
    // TDC: I don't think this computes the correct leaf if the boundary is the final entry in the session file.
    // Nearest user/assistant at-or-above the last surviving entry.
    let current = entries.findLast(
      (entry) => entry.uuid !== undefined && !deleted(entry.uuid),
    )?.uuid;
    const walked = new Set<UUID>();
    while (current !== undefined) {
      if (walked.has(current)) {
        onInvalid(
          `leaf walk revisited ${current} — parent cycle in the session file; stopping`,
        );
        current = undefined;
        break;
      }
      walked.add(current);
      const entry = byUuid.get(current);
      if (entry === undefined || deleted(current)) {
        current = undefined;
        break;
      }
      if (entry.type === "user" || entry.type === "assistant") {
        break;
      }
      current = parentOf(current);
    }
    leaf = current;
  }

  const chain: TreeNodeRef[] = [];
  // Cycle guard: raw parentUuid pointers are unvalidated, so a corrupt
  // file can loop the walk.
  const walked = new Set<UUID>();
  let current = leaf;
  while (current !== undefined) {
    if (walked.has(current)) {
      onInvalid(
        `loadedContext walk revisited ${current} — parent cycle in the session file; stopping`,
      );
      break;
    }
    walked.add(current);
    const entry = byUuid.get(current);
    if (
      entry === undefined ||
      deleted(current) ||
      entry.subtype === "compact_boundary"
    ) {
      break;
    }
    chain.push(
      preservedIndex.has(current)
        ? { uuid: current, viaBoundary: boundary!.uuid }
        : { uuid: current },
    );
    current = parentOf(current);
  }
  chain.reverse();
  return chain;
}

/** Uuid projection of loadedContext. */
export function loadedContextUuids(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): UUID[] {
  return loadedContext(entries, onInvalid).map((ref) => ref.uuid);
}
