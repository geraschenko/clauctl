/**
 * The CLI loader's load-time transform, ported from the decompiled binary
 * (v2.1.258), in stages: 1 boundary relink + cut, 2 root-to-leaf walk,
 * 3 parallel-tool-group expansion, 4 resume sanitization. (Stage 5, wire
 * normalization, happens per request inside the CLI — out of scope here.)
 * "The load pipeline" section of
 * docs/derisk/compact-boundary-injection/FINDINGS.md specifies the stages;
 * probe ids in comments (e.g. P10, p14) cite the same file. This module
 * owns every relink rule — buildTree and the display transform call in
 * here rather than restating any of them.
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session/file.ts";
import {
  formatTreeNodeRef,
  type TreeNodeRef,
  type TreeNodeStr,
} from "./nodes.ts";

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

/** Parse a boundary entry. Precondition: `entry` is a uuid-bearing
 *  compact_boundary — throws otherwise (caller bug, not file corruption).
 *  Absent preservedMessages ("unset when compaction summarizes everything"
 *  per the SDK; also legacy segment-only boundaries) normalizes to the
 *  equivalent wipe `{anchorUuid: boundary, uuids: []}` — nothing
 *  pre-boundary survives either way (see Edge cases in
 *  docs/specs/session-tree.md for the divergence this creates).
 *  Present-but-malformed metadata throws: that is file corruption, not a
 *  shape any producer writes. */
export function compactBoundaryOf(entry: SessionEntry): CompactBoundary {
  if (entry.subtype !== "compact_boundary" || entry.uuid === undefined) {
    throw new Error(
      `compactBoundaryOf: ${entry.uuid ?? "<no uuid>"} is not a uuid-bearing compact_boundary`,
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
      `compactBoundaryOf: boundary ${entry.uuid} has malformed preservedMessages`,
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
 *  is valid. `precedingUuids` holds the entries written before the
 *  boundary: a preserved uuid naming anything else is rejected (a
 *  deliberate fail-closed divergence — the binary validates against the
 *  whole file; see Edge cases in docs/specs/session-tree.md). */
export function invalidRelinkReason(
  precedingUuids: Pick<ReadonlySet<TreeNodeStr>, "has">,
  boundary: CompactBoundary,
): string | undefined {
  const preserved = boundary.preservedMessages;
  if (new Set(preserved.uuids).size !== preserved.uuids.length) {
    // Deliberate fail-closed divergence: the binary rewrites a duplicated
    // preserved list unchecked over a uuid-keyed map, so the repeat clobbers
    // its earlier reparenting — the prefix before the duplicate's
    // second-to-last occurrence is functionally deleted and the remainder keeps
    // a parent cycle (p14: the summary vanished from the wire; see file
    // comment). A duplicate can never mean "this message twice", so rejecting
    // loses nothing.
    return "duplicated uuid in preservedMessages.uuids";
  }
  if (preserved.uuids.includes(preserved.anchorUuid)) {
    // Deliberate divergence: the binary's sequential passes self-parent the
    // chain on this shape; rejecting it is also what makes our
    // raw-parents-then-override rule order equivalent to the binary's
    // wherever the relink applies.
    return "anchorUuid appears in preservedMessages.uuids";
  }
  const unknownUuid = preserved.uuids.find((uuid) => !precedingUuids.has(uuid));
  if (unknownUuid !== undefined) {
    return `preserved uuid ${unknownUuid} names no earlier entry`;
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

/** The group-collection maps both stage-3 expansion (see file comment) and
 *  the display tree build from the same code: all assistant entries per API
 *  message.id, and the tool_result user children per call entry. Values are
 *  uuids: byUuid stays the single store of entry payloads, and both
 *  consumers already hold it. First occurrence wins on a duplicated uuid,
 *  matching buildTree; uuid-less entries contribute nothing. */
export interface ToolGroupMaps {
  assistantsByMessageId: Map<string, UUID[]>;
  /** Result entry uuids per CALL ENTRY uuid (each result's parentUuid) —
   *  not per toolu_… tool call id. */
  resultsByCallUuid: Map<UUID, UUID[]>;
}

/** Content blocks of an entry's API message ([] for non-array content). */
interface ContentBlock {
  type?: string;
  /** tool_use block id. */
  id?: string;
  /** tool_result block back-reference to its tool_use block id. */
  tool_use_id?: string;
}
function contentBlocks(entry: SessionEntry): ContentBlock[] {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function apiMessageIdOf(entry: SessionEntry): string | undefined {
  return (entry.message as { id?: string } | undefined)?.id;
}

/** The entry carries a tool_use block — the entry-level "tool call" whose
 *  pairing with its tool_result children preserved-uuids normalization
 *  guards. */
export function isToolCallEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "assistant" &&
    contentBlocks(entry).some((block) => block.type === "tool_use")
  );
}

/** The toolu_… tool_use block ids the entry carries. */
export function toolCallIdsOf(entry: SessionEntry): string[] {
  return contentBlocks(entry)
    .filter((block) => block.type === "tool_use")
    .flatMap((block) => (block.id === undefined ? [] : [block.id]));
}

/** The tool_use block ids the entry's tool_result blocks answer. */
export function toolResultIdsOf(entry: SessionEntry): string[] {
  return contentBlocks(entry)
    .filter((block) => block.type === "tool_result")
    .flatMap((block) =>
      block.tool_use_id === undefined ? [] : [block.tool_use_id],
    );
}

/** The entry carries a tool_result block (a call's user-side child). */
export function isToolResultEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "user" &&
    contentBlocks(entry).some((block) => block.type === "tool_result")
  );
}

/** Every content block is thinking — the shape stage 4 drops when a whole
 *  API-message group reduces to it (p19; see file comment). */
export function isThinkingOnlyEntry(entry: SessionEntry): boolean {
  const blocks = contentBlocks(entry);
  return (
    blocks.length > 0 &&
    blocks.every(
      (block) =>
        // The API's two thinking block kinds; the SDK's BetaContentBlock
        // union (node_modules/@anthropic-ai/sdk/resources/beta/messages/
        // messages.d.ts) is the reference for possible block types.
        // redacted_thinking is thinking the API returned encrypted;
        // classing it as thinking-kind follows the API's typing — the p19
        // probes exercised only plain thinking.
        block.type === "thinking" || block.type === "redacted_thinking",
    )
  );
}

function appendToGroup<K>(map: Map<K, UUID[]>, key: K, entryUuid: UUID): void {
  const group = map.get(key);
  if (group === undefined) {
    map.set(key, [entryUuid]);
  } else {
    group.push(entryUuid);
  }
}

export function toolGroupMaps(entries: SessionEntry[]): ToolGroupMaps {
  const assistantsByMessageId = new Map<string, UUID[]>();
  const resultsByCallUuid = new Map<UUID, UUID[]>();
  const seenUuids = new Set<UUID>();
  for (const entry of entries) {
    if (entry.uuid === undefined || seenUuids.has(entry.uuid)) {
      continue;
    }
    seenUuids.add(entry.uuid);
    if (entry.type === "assistant") {
      const apiMessageId = apiMessageIdOf(entry);
      if (apiMessageId !== undefined) {
        appendToGroup(assistantsByMessageId, apiMessageId, entry.uuid);
      }
    } else if (entry.parentUuid != null && isToolResultEntry(entry)) {
      appendToGroup(resultsByCallUuid, entry.parentUuid, entry.uuid);
    }
  }
  return { assistantsByMessageId, resultsByCallUuid };
}

/** Stage 3 of the load pipeline, mirroring the binary's parallel-group
 *  recovery exactly: for each API-message group with an on-chain member,
 *  splice the missing same-id assistant siblings (timestamp-sorted)
 *  then the missing tool_result children of all group members
 *  (timestamp-sorted) immediately after the group's LAST on-chain assistant
 *  entry. On-chain refs keep their positions and their viaBoundary;
 *  recovered entries enter as bare `{uuid}` refs (they are never
 *  boundary-preserved). byUuid is both the entry-payload store and the
 *  recovery universe — pass only entries that survived the relink + cut:
 *  an excluded pre-boundary sibling must NOT be recovered (p20-part1; see
 *  file comment). Precondition: chain is a root-first path, so its refs
 *  are unique. */
export function expandParallelToolGroups(
  chain: TreeNodeRef[],
  byUuid: Map<UUID, SessionEntry>,
): TreeNodeRef[] {
  const { assistantsByMessageId, resultsByCallUuid } = toolGroupMaps([
    ...byUuid.values(),
  ]);
  const onChain = new Set<UUID>();
  /** Splice anchor per API message id: overwriting in chain order matches
   *  the claude binary (its map assignment keeps the LAST on-chain assistant). */
  const anchorRefOf = new Map<string, TreeNodeRef>();
  for (const ref of chain) {
    onChain.add(ref.uuid);
    const entry = byUuid.get(ref.uuid);
    if (entry?.type === "assistant") {
      const apiMessageId = apiMessageIdOf(entry);
      if (apiMessageId !== undefined) {
        anchorRefOf.set(apiMessageId, ref);
      }
    }
  }
  const timestampOf = (entryUuid: UUID): string =>
    (byUuid.get(entryUuid)?.timestamp as string | undefined) ?? "";
  const byTimestamp = (a: UUID, b: UUID): number =>
    timestampOf(a).localeCompare(timestampOf(b));
  const recovered = new Set<UUID>();
  const insertionsAfter = new Map<string, UUID[]>();
  for (const [apiMessageId, anchorRef] of anchorRefOf) {
    const members = assistantsByMessageId.get(apiMessageId) ?? [];
    const missingSiblings = members
      .filter((member) => !onChain.has(member) && !recovered.has(member))
      .sort(byTimestamp);
    const missingResults = members
      .flatMap((member) => resultsByCallUuid.get(member) ?? [])
      .filter((result) => !onChain.has(result) && !recovered.has(result))
      .sort(byTimestamp);
    const block = [...missingSiblings, ...missingResults];
    if (block.length === 0) {
      continue;
    }
    for (const entryUuid of block) {
      recovered.add(entryUuid);
    }
    insertionsAfter.set(formatTreeNodeRef(anchorRef), block);
  }
  if (insertionsAfter.size === 0) {
    return chain;
  }
  const expanded: TreeNodeRef[] = [];
  for (const ref of chain) {
    expanded.push(ref);
    const block = insertionsAfter.get(formatTreeNodeRef(ref));
    if (block !== undefined) {
      expanded.push(...block.map((entryUuid) => ({ uuid: entryUuid })));
    }
  }
  return expanded;
}

/** Stage 4, resume sanitization, entry-level, in order: drop assistant
 *  entries whose content is only tool_use blocks none of which has a
 *  tool_result anywhere on the expanded chain (killed turns, p20; see file
 *  comment); then drop API-message groups reduced to thinking-only entries
 *  (p19; see file comment).
 *  Entry-granularity approximation: a mixed text + dead-tool_use entry is
 *  kept whole where the CLI drops just the dead block (not a shape the CLI
 *  writes — one block per assistant entry). */
function sanitizeForResume(
  chain: TreeNodeRef[],
  byUuid: Map<UUID, SessionEntry>,
): TreeNodeRef[] {
  const resolvedCallIds = new Set<string>();
  for (const ref of chain) {
    const entry = byUuid.get(ref.uuid);
    if (entry?.type === "user") {
      for (const block of contentBlocks(entry)) {
        if (block.type === "tool_result" && block.tool_use_id !== undefined) {
          resolvedCallIds.add(block.tool_use_id);
        }
      }
    }
  }
  const isDeadCall = (entry: SessionEntry): boolean => {
    if (entry.type !== "assistant") {
      return false;
    }
    const blocks = contentBlocks(entry);
    return (
      blocks.length > 0 &&
      blocks.every(
        (block) =>
          block.type === "tool_use" &&
          !(block.id !== undefined && resolvedCallIds.has(block.id)),
      )
    );
  };
  /** Remaining assistant members per API message id (id-less assistants
   *  are their own singleton group), collected while filtering. */
  const groupMembers = new Map<string, UUID[]>();
  const afterCallDrop: TreeNodeRef[] = [];
  for (const ref of chain) {
    const entry = byUuid.get(ref.uuid);
    if (entry !== undefined && isDeadCall(entry)) {
      continue;
    }
    if (entry?.type === "assistant") {
      appendToGroup(groupMembers, apiMessageIdOf(entry) ?? ref.uuid, ref.uuid);
    }
    afterCallDrop.push(ref);
  }
  const dropped = new Set<UUID>();
  for (const members of groupMembers.values()) {
    if (members.every((member) => isThinkingOnlyEntry(byUuid.get(member)!))) {
      for (const member of members) {
        dropped.add(member);
      }
    }
  }
  return afterCallDrop.filter((ref) => !dropped.has(ref.uuid));
}

/** @deprecated Test/verification oracle only (tree/context-check.ts and
 *  tests); product code derives context from the context tree —
 *  `toContextTree(...).contextAt(leaf)` (tree/context-tree.ts).
 *
 *  Our best estimate of the context the NEXT appended message will see:
 *  the loader transform of the current file — the last boundary's relink
 *  and cut, leaf selection, then the parent walk from the leaf. A trailing
 *  boundary is honored even though the binary applies it only on the next
 *  load, because that next load is exactly what the next appended message
 *  gets. Models stages 1–4 of the load pipeline: relink + cut, leaf walk,
 *  parallel-group expansion, resume sanitization. Stage 5 (wire
 *  normalization: adjacent-user merge, same-id regrouping, cross-model
 *  thinking strip) is out of scope — it reshapes API messages, not which
 *  entries are present. An element carries viaBoundary iff
 *  its uuid is among the boundary's preserved uuids. Duplicated raw uuids
 *  are last-wins, matching the loader's uuid-keyed map (legal re-persisted
 *  copies; see Edge cases in docs/specs/session-tree.md). */
export function loadedContext(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): TreeNodeRef[] {
  const byUuid = new Map<UUID, SessionEntry>();
  const firstIndexOf = new Map<UUID, number>();
  const lastIndexOf = new Map<UUID, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
      if (!firstIndexOf.has(entry.uuid)) {
        firstIndexOf.set(entry.uuid, index);
      }
      lastIndexOf.set(entry.uuid, index);
    }
  }

  const cutIndex = entries.findLastIndex(
    (entry) => entry.subtype === "compact_boundary" && entry.uuid !== undefined,
  );
  let boundary =
    cutIndex === -1 ? undefined : compactBoundaryOf(entries[cutIndex]!);
  if (boundary !== undefined) {
    // The walk treats boundaries as chain ends because the CLI writes them
    // with a null parentUuid (their placement is logicalParentUuid, a
    // tree-domain concern). A raw parent here means the producer changed
    // and the relink model needs re-deriving against the new binary.
    if (entries[cutIndex]!.parentUuid != null) {
      onInvalid(
        `boundary ${boundary.uuid} has a raw parentUuid — unexpected producer behavior; the loaded context may be wrong`,
      );
    }
    const invalidReason = invalidRelinkReason(
      {
        has: (uuid) => (firstIndexOf.get(uuid as UUID) ?? Infinity) < cutIndex,
      },
      boundary,
    );
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
      // tail — natively, a turn answering a prompt that was queued during
      // compaction and written just before the boundary (FINDINGS §1).
      return preservedTail;
    }
    return parent;
  };

  // One walk from the last surviving entry: climb silently to the nearest
  // user/assistant (trailing system entries are not context), then append
  // every entry until a boundary ends the chain. Reaching the boundary
  // (the file ends at it) or its anchor (the file ends at an up_to
  // summary, whose preserved uuids are PRESENTED after it) before
  // appending starts means the relinked chain's tail is the loaded tip —
  // redirect there. At most once: the appended chain legitimately returns
  // to the anchor (up_to appends the summary after the preserved uuids),
  // so the cycle guard restarts at the redirect and the redirect must not
  // re-fire.
  const chain: TreeNodeRef[] = [];
  // Cycle guard: raw parentUuid pointers are unvalidated, so a corrupt
  // file can loop the walk.
  let walked = new Set<UUID>();
  let appending = false;
  let redirected = false;
  const lastSurviving = entries.findLast(
    (entry) => entry.uuid !== undefined && !deleted(entry.uuid),
  )?.uuid;
  let current = lastSurviving === undefined ? undefined : refOf(lastSurviving);
  while (current !== undefined) {
    if (walked.has(current.uuid)) {
      onInvalid(
        `loadedContext walk revisited ${current.uuid} — parent cycle in the session file; stopping`,
      );
      break;
    }
    walked.add(current.uuid);
    const entry = byUuid.get(current.uuid);
    if (entry === undefined || deleted(current.uuid)) {
      // Known divergence from the 2.1.258 binary (corrupted files only):
      // its resume chain builder repairs a parent pointer that names no
      // file entry by splicing to the nearest earlier entry within 5s with
      // matching isSidechain (telemetry tengu_chain_timestamp_fallback).
      // We end the walk instead. No known producer writes dangling
      // parents, so this only differs on corrupt or hand-edited files.
      break;
    }
    if (
      !appending &&
      !redirected &&
      (entry.subtype === "compact_boundary" ||
        current.uuid === boundary?.preservedMessages.anchorUuid)
    ) {
      if (preservedUuids.length === 0) {
        break; // a wipe: nothing survives the boundary
      }
      redirected = true;
      current = preservedTail;
      walked = new Set();
      continue;
    }
    if (entry.subtype === "compact_boundary") {
      break;
    }
    if (entry.type === "user" || entry.type === "assistant") {
      appending = true;
    }
    if (appending) {
      chain.push(current);
    }
    current = parentOf(current);
  }
  chain.reverse();
  // Stages 3 + 4 over the entries that survived the cut: an entry a
  // boundary cut away must be neither recovered nor consulted (its
  // tool_result cannot revive a call the preserved list kept).
  const survivingByUuid = new Map(
    [...byUuid].filter(([entryUuid]) => !deleted(entryUuid)),
  );
  return sanitizeForResume(
    expandParallelToolGroups(chain, survivingByUuid),
    survivingByUuid,
  );
}
