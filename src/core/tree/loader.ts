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
 *  nothing pre-boundary survives either way (see Edge cases in
 *  docs/specs/session-tree.md for the divergence this creates).
 *  Present-but-malformed metadata throws:
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
 *  entry after the boundary (see Edge cases in
 *  docs/specs/session-tree.md). */
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
 *  relink in effect). A parent among the preserved uuids is that uuid's
 *  relinked occurrence (viaBoundary set). A compact_boundary entry with no
 *  raw parent hangs off its logicalParentUuid — where the boundary event
 *  happened. The anchor-child rule is written ONLY here: a child of the
 *  anchor lands on the preserved tail; uuids[0] is exempt (its parent is
 *  parentOfPreserved's business — in the binary the chain rewrite has
 *  already run when the anchor-child pass looks, so it never matches). */
export function effectiveParent(
  boundary: CompactBoundary | undefined,
  entry: SessionEntry,
): TreeNodeRef | undefined {
  const rawParent =
    entry.parentUuid ??
    (entry.subtype === "compact_boundary"
      ? entry.logicalParentUuid
      : undefined) ??
    undefined;
  if (rawParent === undefined) {
    return undefined;
  }
  const preserved = boundary?.preservedMessages;
  if (
    preserved !== undefined &&
    preserved.uuids.length > 0 &&
    rawParent === preserved.anchorUuid &&
    entry.uuid !== preserved.uuids[0]
  ) {
    return { uuid: preserved.uuids.at(-1)!, viaBoundary: boundary!.uuid };
  }
  if (preserved !== undefined && preserved.uuids.includes(rawParent)) {
    return { uuid: rawParent, viaBoundary: boundary!.uuid };
  }
  return { uuid: rawParent };
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
 *  copies; see Edge cases in docs/specs/session-tree.md). */
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
  let boundary =
    cutIndex === -1 ? undefined : compactBoundaryAt(entries, cutIndex);
  if (boundary !== undefined) {
    const invalidReason = invalidRelinkReason(new Set(byUuid.keys()), boundary);
    if (invalidReason !== undefined) {
      // Deliberate divergence (see Edge cases in docs/specs/session-tree.md):
      // the binary aborts the whole transform and loads raw parents,
      // resurrecting pre-boundary context; we treat the boundary as a full
      // wipe instead — the safe direction for a corrupt file.
      onInvalid(
        `boundary ${boundary.uuid}: invalid preservedMessages (${invalidReason}) — treating the boundary as a full context wipe`,
      );
      boundary = {
        uuid: boundary.uuid,
        preservedMessages: { anchorUuid: boundary.uuid, uuids: [] },
      };
    }
  }
  const preservedUuids = boundary?.preservedMessages.uuids ?? [];
  const preservedIndex = new Map(
    preservedUuids.map((preservedUuid, index) => [preservedUuid, index]),
  );
  /** The tip of the relinked chain — the anchor itself when nothing was
   *  preserved (a wipe's anchor is the boundary, so the chain is empty). */
  const preservedTail: TreeNodeRef | undefined =
    boundary === undefined
      ? undefined
      : preservedUuids.length > 0
        ? { uuid: preservedUuids.at(-1)!, viaBoundary: boundary.uuid }
        : { uuid: boundary.preservedMessages.anchorUuid };

  /** Cut away by the boundary: last occurrence before it and not preserved. */
  const deleted = (uuid: UUID): boolean => {
    const lastIndex = lastIndexOf.get(uuid);
    return (
      lastIndex !== undefined &&
      lastIndex < cutIndex &&
      !preservedIndex.has(uuid)
    );
  };

  /** A ref's loaded occurrence: relinked when its uuid is preserved. */
  const refOf = (uuid: UUID): TreeNodeRef =>
    preservedIndex.has(uuid) ? { uuid, viaBoundary: boundary!.uuid } : { uuid };

  /** The transformed relation (ref.uuid must exist in byUuid). Boundaries
   *  end chains: their logical anchoring is tree-domain placement, not a
   *  loaded edge. */
  const parentOf = (ref: TreeNodeRef): TreeNodeRef | undefined => {
    const entry = byUuid.get(ref.uuid)!;
    if (entry.subtype === "compact_boundary") {
      // TDC: maybe it's worth making an assertion here that entry.parentUuid is null, or showing a banner if it's not true, because if that ever changes, it means that claude code has started doing something weird and we need to update our relinking algorithm.
      return undefined;
    }
    const index = preservedIndex.get(ref.uuid);
    if (index !== undefined) {
      return parentOfPreserved(boundary!, index);
    }
    const parent = effectiveParent(boundary, entry);
    if (
      parent !== undefined &&
      deleted(parent.uuid) &&
      (entry.type === "user" || entry.type === "assistant")
    ) {
      // A surviving turn whose parent was cut is attached to the preserved
      // tail. This should never happen in a well-formed session file.
      return preservedTail;
    }
    return parent;
  };

  // Leaf selection: climb from the last surviving entry to the nearest
  // user/assistant. Reaching the boundary (the file ends at it) or its
  // anchor (the file ends at an up_to summary, whose preserved uuids are
  // PRESENTED after it) means the relinked chain's tail is the loaded tip.
  let leaf: TreeNodeRef | undefined;
  const lastSurviving = entries.findLast(
    (entry) => entry.uuid !== undefined && !deleted(entry.uuid),
  )?.uuid;
  // TDC: It feels like we're unnecessarily implementing the climb twice here. Instead, we should start at lastSurviving, climb until we get to a user-or-assistant, start appending to the chain, continue climbing (and appending) until done, break. Return reversed chain. Can you combine these two climbs like that? I think the only thing we have to change about initialization is that if last_surviving is a boundary, we must *immediately* replace it with preservedTail. After that I think the climb logic should be identical.
  let climb = lastSurviving === undefined ? undefined : refOf(lastSurviving);
  const climbed = new Set<UUID>();
  while (climb !== undefined) {
    if (climbed.has(climb.uuid)) {
      onInvalid(
        `leaf walk revisited ${climb.uuid} — parent cycle in the session file; stopping`,
      );
      break;
    }
    climbed.add(climb.uuid);
    const entry = byUuid.get(climb.uuid);
    if (entry === undefined || deleted(climb.uuid)) {
      break;
    }
    if (
      entry.subtype === "compact_boundary" ||
      climb.uuid === boundary?.preservedMessages.anchorUuid
    ) {
      leaf = preservedTail;
      break;
    }
    if (entry.type === "user" || entry.type === "assistant") {
      leaf = climb;
      break;
    }
    climb = parentOf(climb);
  }

  const chain: TreeNodeRef[] = [];
  // Cycle guard: raw parentUuid pointers are unvalidated, so a corrupt
  // file can loop the walk.
  const walked = new Set<UUID>();
  let current = leaf;
  while (current !== undefined) {
    if (walked.has(current.uuid)) {
      onInvalid(
        `loadedContext walk revisited ${current.uuid} — parent cycle in the session file; stopping`,
      );
      break;
    }
    walked.add(current.uuid);
    const entry = byUuid.get(current.uuid);
    if (
      entry === undefined ||
      deleted(current.uuid) ||
      entry.subtype === "compact_boundary"
    ) {
      break;
    }
    chain.push(current);
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
