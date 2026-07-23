/**
 * The CLI loader's load-time transform, ported from the decompiled binary
 * (v2.1.170). The numbered steps in comments cite the "Ground truth"
 * section of docs/specs/session-tree.md, which records the transform and
 * the extraction method; probe ids (e.g. P10, P3 m4) cite
 * docs/derisk/compact-boundary-injection/FINDINGS.md. This module owns
 * every relink rule — buildTree and the display transform call in here
 * rather than restating any of them.
 */

import type { UUID } from "node:crypto";
import { entriesByUuid, type SessionEntry } from "../session-file.ts";
import type { TreeNodeRef } from "./nodes.ts";

/** Sink for corrupt-session-file diagnostics (an invalid relink, a
 *  parentUuid cycle). Required so ignoring them is a visible choice at the
 *  call site — pass `() => {}` to declare it. */
export type OnInvalid = (message: string) => void;

/** A compact_boundary entry's relink instruction, mirroring the jsonl
 *  field names. Parse-only — validity is a separate question (mirroring
 *  the binary, where parsing and step-3 validation are distinct).
 *  preservedMessages absent = the boundary carries no modeled metadata.
 *  Legacy segment-only boundaries parse as metadata-less — a known,
 *  deliberate divergence (the loader resolves them by a tail→head walk;
 *  see the spec's Edge cases). */
export interface CompactBoundary {
  uuid: UUID;
  preservedMessages?: { anchorUuid?: UUID; uuids: UUID[] };
}

/** Parse the boundary at entries[boundaryIndex]. Precondition: that entry
 *  is a uuid-bearing compact_boundary — throws otherwise (caller bug, not
 *  file corruption). Empty uuids parses as present (a pure wipe: rules
 *  no-op, the cut still applies — P10). */
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
  if (preserved === undefined || !Array.isArray(preserved.uuids)) {
    return { uuid: entry.uuid };
  }
  return {
    uuid: entry.uuid,
    preservedMessages: {
      ...(preserved.anchorUuid !== undefined && {
        anchorUuid: preserved.anchorUuid,
      }),
      uuids: preserved.uuids as UUID[],
    },
  };
}

/** Step-3 validation, written once: the reason this boundary's relink must
 *  not apply — a preserved uuid naming no file entry (loader-observed;
 *  anywhere in the file, NOT just earlier — the loader validates against
 *  the complete map), a duplicated uuid (probe-observed, P3 m4), or the
 *  anchor appearing among the preserved uuids (deliberate divergence like
 *  the duplicate rejection: the binary proceeds and its sequential passes
 *  self-parent the chain — a parent cycle; real files never take this
 *  shape, the anchor is the summary or the boundary's own uuid) — or
 *  undefined when the relink applies. loadedContext aborts its transform
 *  on it; buildTree emits no block; both report it through their
 *  onInvalid. Undefined for a metadata-less boundary: there is no relink
 *  to invalidate. */
export function invalidRelinkReason(
  fileUuids: ReadonlySet<UUID>,
  boundary: CompactBoundary,
): string | undefined {
  const preserved = boundary.preservedMessages;
  if (preserved === undefined) {
    return undefined;
  }
  if (new Set(preserved.uuids).size !== preserved.uuids.length) {
    return "duplicated uuid in preservedMessages.uuids";
  }
  if (
    preserved.anchorUuid !== undefined &&
    preserved.uuids.includes(preserved.anchorUuid)
  ) {
    return "anchorUuid appears in preservedMessages.uuids";
  }
  const unknownUuid = preserved.uuids.find((uuid) => !fileUuids.has(uuid));
  if (unknownUuid !== undefined) {
    return `preserved uuid ${unknownUuid} names no file entry`;
  }
  return undefined;
}

/** Loader parent rewrite under this boundary's relink: parentUuid ==
 *  anchorUuid (anchor present, uuids non-empty) → uuids.last(); otherwise
 *  the raw parentUuid. THE anchor-child rule (step 4) — the only place it
 *  is written; uuids[0] is exempt (its parent is the chain rewrite's
 *  business, and in the binary the rewrite runs first so the anchor-child
 *  pass skips it explicitly). loadedContext applies it map-wide (as the
 *  loader does); buildTree applies it forward from the boundary —
 *  divergent only for hand-crafted pre-boundary references to the
 *  anchor. */
export function effectiveParent(
  boundary: CompactBoundary,
  entry: SessionEntry,
): UUID | undefined {
  const preserved = boundary.preservedMessages;
  const rawParent = entry.parentUuid ?? undefined;
  if (
    preserved !== undefined &&
    preserved.anchorUuid !== undefined &&
    preserved.uuids.length > 0 &&
    rawParent === preserved.anchorUuid &&
    entry.uuid !== preserved.uuids[0]
  ) {
    return preserved.uuids[preserved.uuids.length - 1];
  }
  return rawParent;
}

/** Parent of uuids[index] inside the relinked chain: anchorUuid for
 *  index 0, uuids[index-1] after. THE chain-rewrite rule (step 4). Throws
 *  on a metadata-less boundary or an out-of-range index (caller bug). */
export function preservedParent(
  boundary: CompactBoundary,
  index: number,
): UUID | undefined {
  const preserved = boundary.preservedMessages;
  if (preserved === undefined || index < 0 || index >= preserved.uuids.length) {
    throw new Error(
      `preservedParent: boundary ${boundary.uuid} has no preserved uuid at index ${index}`,
    );
  }
  return index === 0 ? preserved.anchorUuid : preserved.uuids[index - 1];
}

/** One uuid's slot in the loader's transformed relation. */
interface TransformedNode {
  entry: SessionEntry;
  parent: UUID | undefined;
}

/** Our best estimate of the loaded context: the transcript entries the
 *  loader selects, in exact order — the ground-truth transform
 *  (last-boundary rules via effectiveParent/preservedParent, the cut,
 *  orphan reparent), then the parent walk from the leaf per ground-truth
 *  step 6 (single dangling tip, else nearest user/assistant at-or-above
 *  the last file entry). Estimate: downstream request normalization
 *  (tool-pair sanitization, attachment dropping, API-message grouping —
 *  FINDINGS "failure modes") is out of scope. An element carries
 *  viaBoundary iff its uuid is among the last boundary's preserved uuids.
 *  Duplicated raw uuids are last-wins, matching the loader's uuid-keyed
 *  map (legal re-persisted copies; see the spec's Edge cases). */
export function loadedContext(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): TreeNodeRef[] {
  // The loader's uuid-keyed view: last-wins on a duplicated uuid, both for
  // the entry payload and for the file index the cut compares against.
  const byUuid = entriesByUuid(entries);
  const lastIndexOf = new Map<UUID, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.uuid !== undefined) {
      lastIndexOf.set(entry.uuid, index);
    }
  }
  const transformed = new Map<UUID, TransformedNode>();
  for (const [uuid, entry] of byUuid) {
    transformed.set(uuid, { entry, parent: entry.parentUuid ?? undefined });
  }

  const isBoundary = (entry: SessionEntry): boolean =>
    entry.subtype === "compact_boundary" && entry.uuid !== undefined;
  // Step 1: cutIndex (K) = the last boundary of any kind; meta = the last
  // boundary carrying preservedMessages. No metadata anywhere → no
  // transform at all.
  const cutIndex = entries.findLastIndex(isBoundary);
  let meta: { index: number; boundary: Required<CompactBoundary> } | undefined;
  for (let index = cutIndex; index >= 0 && meta === undefined; index -= 1) {
    if (!isBoundary(entries[index]!)) {
      continue;
    }
    const boundary = compactBoundaryAt(entries, index);
    if (boundary.preservedMessages !== undefined) {
      meta = {
        index,
        boundary: {
          uuid: boundary.uuid,
          preservedMessages: boundary.preservedMessages,
        },
      };
    }
  }

  /** The relink whose rules ran (valid, non-empty uuids): its preserved
   *  uuids carry viaBoundary in the result. */
  let appliedBoundary: Required<CompactBoundary> | undefined;
  if (meta !== undefined) {
    // Step 2: the relink rules run only when the metadata boundary IS the
    // last boundary. Step 3: an invalid preserved list aborts the whole
    // transform — no rewrite AND no cut.
    const abortReason =
      meta.index === cutIndex
        ? invalidRelinkReason(new Set(byUuid.keys()), meta.boundary)
        : undefined;
    if (abortReason !== undefined) {
      onInvalid(
        `boundary ${meta.boundary.uuid}: relink skipped — ${abortReason}`,
      );
    } else {
      const preservedUuids =
        meta.index === cutIndex ? meta.boundary.preservedMessages.uuids : [];
      if (preservedUuids.length > 0) {
        // Step 4: anchor-child reparent (on raw parents), then the chain
        // rewrite on the preserved uuids themselves — same outcome as the
        // binary's rewrite-then-reparent order, because effectiveParent
        // exempts uuids[0] and preservedParent overrides any preserved
        // uuid the anchor-child pass touched. The equivalence needs the
        // anchor absent from uuids (otherwise the binary's sequential
        // passes see post-rewrite parents this order never produces) —
        // guaranteed here by invalidRelinkReason.
        for (const node of transformed.values()) {
          node.parent = effectiveParent(meta.boundary, node.entry);
        }
        for (const [index, preservedUuid] of preservedUuids.entries()) {
          // Validated above: every preserved uuid names a file entry.
          transformed.get(preservedUuid)!.parent = preservedParent(
            meta.boundary,
            index,
          );
        }
        appliedBoundary = meta.boundary;
      }
      // Step 5: the cut — delete every entry before the last boundary that
      // is not preserved (nothing is preserved when the last boundary is
      // metadata-less or a pure wipe)…
      const preservedSet = new Set(preservedUuids);
      const deleted = new Set<UUID>();
      for (const uuid of [...transformed.keys()]) {
        if (lastIndexOf.get(uuid)! < cutIndex && !preservedSet.has(uuid)) {
          transformed.delete(uuid);
          deleted.add(uuid);
        }
      }
      // …then orphan reparent: surviving user/assistant entries whose
      // parent was deleted land on the preserved tail (non-empty lists
      // only).
      const preservedTail = preservedUuids[preservedUuids.length - 1];
      if (preservedTail !== undefined) {
        for (const node of transformed.values()) {
          if (
            (node.entry.type === "user" || node.entry.type === "assistant") &&
            node.parent !== undefined &&
            deleted.has(node.parent)
          ) {
            node.parent = preservedTail;
          }
        }
      }
    }
  }

  // Step 6: leaf selection — a single dangling tip of the transformed
  // relation when a relink ran; otherwise (or with multiple tips) the
  // nearest user/assistant at-or-above the last file entry.
  let leaf: UUID | undefined;
  if (appliedBoundary !== undefined) {
    const parents = new Set<UUID | undefined>();
    for (const node of transformed.values()) {
      parents.add(node.parent);
    }
    const tips = [...transformed.keys()].filter((uuid) => !parents.has(uuid));
    if (tips.length === 1) {
      leaf = tips[0];
    }
  }
  if (leaf === undefined) {
    let current = entries.findLast(
      (entry) => entry.uuid !== undefined && transformed.has(entry.uuid),
    )?.uuid;
    const seen = new Set<UUID>();
    while (current !== undefined) {
      if (seen.has(current)) {
        onInvalid(
          `leaf walk revisited ${current} — parent cycle in the session file; stopping`,
        );
        current = undefined;
        break;
      }
      seen.add(current);
      const node = transformed.get(current);
      if (node === undefined) {
        current = undefined;
        break;
      }
      if (node.entry.type === "user" || node.entry.type === "assistant") {
        break;
      }
      current = node.parent;
    }
    leaf = current;
  }

  // The context: the ordinary parent walk from the leaf over the
  // transformed relation, boundaries acting as chain ends.
  const relinkedUuids = new Set(appliedBoundary?.preservedMessages.uuids ?? []);
  const chain: TreeNodeRef[] = [];
  // Cycle guard: raw parentUuid pointers are unvalidated, so a corrupt
  // file can loop the walk.
  const seen = new Set<UUID>();
  let current = leaf;
  while (current !== undefined) {
    if (seen.has(current)) {
      onInvalid(
        `loadedContext walk revisited ${current} — parent cycle in the session file; stopping`,
      );
      break;
    }
    seen.add(current);
    const node = transformed.get(current);
    if (node === undefined || node.entry.subtype === "compact_boundary") {
      break;
    }
    chain.push(
      relinkedUuids.has(current)
        ? { uuid: current, viaBoundary: appliedBoundary!.uuid }
        : { uuid: current },
    );
    current = node.parent;
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
