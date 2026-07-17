/**
 * The CLI loader's load-time relink, reimplemented over raw session entries:
 * a compact_boundary entry's `preservedMessages` (anchorUuid + uuids)
 * instructs the loader to rebuild the effective context from the listed
 * entries instead of the raw parentUuid chain. This module mirrors those
 * semantics so the daemon can compute the chain a resume would load without
 * a CLI in the loop.
 *
 * Probe ids in comments (e.g. P3 m5, p2.b) cite the experiments in
 * docs/derisk/compact-boundary-injection/FINDINGS.md that established each
 * behavior.
 */

import type { UUID } from "node:crypto";
import type {
  NonNullableUsage,
  PermissionMode,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { toNonNullableUsage } from "./agent-state.ts";
import type { SessionEntry } from "./session-file.ts";

interface PreservedMessages {
  anchorUuid?: UUID;
  uuids: UUID[];
}

// Segment-only boundaries (compactMetadata.preservedSegment without
// preservedMessages, written by older CLI versions) are not modeled: they
// read as "no relink", so effectiveChain can differ from the loader on such
// organic sessions. Current CLIs write preservedMessages, and set-context
// only appends that form.

function preservedMessagesOf(
  boundary: SessionEntry,
): PreservedMessages | undefined {
  const metadata = boundary.compactMetadata as
    { preservedMessages?: { anchorUuid?: UUID; uuids?: unknown } } | undefined;
  const preserved = metadata?.preservedMessages;
  if (preserved === undefined || !Array.isArray(preserved.uuids)) {
    return undefined;
  }
  return {
    ...(preserved.anchorUuid !== undefined && {
      anchorUuid: preserved.anchorUuid,
    }),
    uuids: preserved.uuids as UUID[],
  };
}

/** The boundary's companion summary entry: parented on the boundary and
 *  flagged isCompactSummary (native shape in both anchor variants). */
export function summaryOf(
  entries: SessionEntry[],
  boundaryIndex: number,
): SessionEntry | undefined {
  const boundaryUuid = entries[boundaryIndex]!.uuid;
  return entries
    .slice(boundaryIndex + 1)
    .find(
      (entry) =>
        entry.parentUuid === boundaryUuid && entry.isCompactSummary === true,
    );
}

/** Identifies one tree node: a raw node (viaBoundary absent) or a
 *  boundary-substructure relinked node (viaBoundary = the boundary's
 *  uuid). */
export interface TreeNodeRef {
  uuid: UUID;
  viaBoundary?: UUID;
}

/** The validated relink of a boundary.
 *  This is exactly the part of the post-boundary chain which should have
 *  viaBoundary set to the boundary uuid. */
export interface BoundaryRelink {
  /** Ordered uuids receiving @boundary relinked nodes: the preserved uuids,
   *  plus the re-parented summary (when from-shape). */
  relinkedUuids: UUID[];
  /** Effective-parent overrides (uuid → parent uuid). */
  parentMap: Map<UUID, UUID>;
}

/**
 * The boundary's relink, validated loader-style: `uuids` non-empty, no
 * duplicates, every listed uuid names an entry earlier in the file. Anything
 * else silently skips the relink (P1 d, P3 m4; see file comment).
 * 
 * The parent map is the load-time relink as overrides: `uuids[i] →
 * uuids[i-1]`, `uuids[0] → anchorUuid`; in from-shape (anchor = the
 * boundary's own uuid) with a summary, the summary's effective parent is
 * `uuids[last]` — the raw chain there runs summary → boundary and would skip
 * the preserved uuids entirely, but the loader's from-shape context is
 * [uuids…, summary] (p2.b; see file comment).
 */
export function validRelink(
  entries: SessionEntry[],
  boundaryIndex: number,
): BoundaryRelink | undefined {
  const boundary = entries[boundaryIndex]!;
  const preserved = preservedMessagesOf(boundary);
  if (preserved === undefined || preserved.uuids.length === 0) {
    // Loader skips boundaries with no preserved uuids. TDC: add probe ref
    return undefined;
  }
  const { anchorUuid, uuids } = preserved;
  const earlierUuids = new Set(
    entries.slice(0, boundaryIndex).map((entry) => entry.uuid),
  );
  if (
    new Set(uuids).size !== uuids.length ||
    !uuids.every((preservedUuid) => earlierUuids.has(preservedUuid))
  ) {
    // Loader skips boundaries with duplicates in preserved uuid or unknown uuids. TDC: add probe refs
    return undefined;
  }

  const relinkedUuids = [...uuids];
  const parentMap = new Map<UUID, UUID>();
  for (let i = 1; i < uuids.length; i += 1) {
    parentMap.set(uuids[i]!, uuids[i - 1]!);
  }
  if (anchorUuid !== undefined) {
    parentMap.set(uuids[0]!, anchorUuid);
  }
  if (anchorUuid === boundary.uuid) {
    const summaryUuid = summaryOf(entries, boundaryIndex)?.uuid;
    if (summaryUuid !== undefined) {
      relinkedUuids.push(summaryUuid);
      parentMap.set(summaryUuid, uuids[uuids.length - 1]!);
    }
  }
  return { relinkedUuids, parentMap };
}

/**
 * The effective context chain (root → tip) the loader would produce for this
 * entries list, as tree-node references — pass a truncated list for "the
 * context when entry X first appeared". Mirrors loader semantics: only the
 * LAST boundary applies (stacked boundaries: last wins entirely — P3 m5; see
 * file comment); the walk takes relink-mapped parents first, raw
 * `parentUuid` otherwise; any boundary entry is transparent — reaching one
 * (or an entry with no parent) ends the walk. An element carries
 * `viaBoundary` iff its uuid is among the last boundary's relinked uuids —
 * elements reached below the anchor via raw parents stay bare.
 */
export function effectiveTreeNodeChain(entries: SessionEntry[]): TreeNodeRef[] {
  const byUuid = new Map<UUID, SessionEntry>();
  for (const entry of entries) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
    }
  }

  const boundaryIndex = entries.findLastIndex(
    (entry) => entry.subtype === "compact_boundary",
  );
  let relinkMap = new Map<UUID, UUID>();
  let relinkedUuids = new Set<UUID>();
  let boundaryUuid: UUID | undefined;
  let tip: UUID | undefined;
  if (boundaryIndex === -1) {
    tip = entries.findLast((entry) => entry.uuid !== undefined)?.uuid;
  } else {
    boundaryUuid = entries[boundaryIndex]!.uuid;
    const relink = validRelink(entries, boundaryIndex);
    const summaryUuid = summaryOf(entries, boundaryIndex)?.uuid;
    if (relink !== undefined) {
      // TDC: if the relink is invalid, we should emit some kind of error. I want the end user to know that something is fucked up in the session file.
      relinkMap = relink.parentMap;
      if (boundaryUuid !== undefined) {
        relinkedUuids = new Set(relink.relinkedUuids);
      }
    }
    // Entries written after the boundary (its own summary aside) chain on
    // top of the relinked context; with none, the tip is the relinked
    // skeleton's own tip: [summary, uuids…] (up_to), [uuids…, summary]
    // (from), or [uuids…] (no summary) — or the bare summary when the
    // relink is absent or invalid.
    const post = entries
      .slice(boundaryIndex + 1)
      .filter(
        (entry) => entry.uuid !== undefined && entry.uuid !== summaryUuid,
      );
    tip =
      post.length > 0
        ? post.at(-1)!.uuid
        : (relink?.relinkedUuids.at(-1) ?? summaryUuid);
  }

  const chain: TreeNodeRef[] = [];
  // TDC: why do we need `seen`? Entries in the relink map have already been confirmed to be unique and post entries are unique. If ever `seen.has(current)`, we should probably emit some kind of error rather than silently stopping, no?
  const seen = new Set<UUID>();
  let current = tip;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const entry = byUuid.get(current);
    if (entry === undefined || entry.subtype === "compact_boundary") {
      break;
    }
    chain.push(
      relinkedUuids.has(current)
        ? { uuid: current, viaBoundary: boundaryUuid! }
        : { uuid: current },
    );
    current = relinkMap.get(current) ?? entry.parentUuid ?? undefined;
  }
  chain.reverse();
  return chain;
}

/** Uuid projection of effectiveTreeNodeChain. */
export function effectiveChain(entries: SessionEntry[]): UUID[] {
  return effectiveTreeNodeChain(entries).map((ref) => ref.uuid);
}

/** File-derived AgentState seed values (daemon startup). */
export interface SessionFileSeed {
  lastUsage?: NonNullableUsage;
  claudeCodeVersion?: string;
  model?: string;
  permissionMode?: PermissionMode;
  lastTranscriptUuid?: UUID;
}

/**
 * AgentState values recoverable from the session file, for seeding a daemon
 * that starts with history on disk. lastUsage and model come from the last
 * assistant entry ON the effective chain (a rewound-away branch's usage does
 * not describe the context a resume would load); claudeCodeVersion from the
 * last version stamp and permissionMode from the last permission-mode entry,
 * both in plain file order (latest observation wins regardless of branch);
 * lastTranscriptUuid is the chain's last user/assistant entry under the same
 * meta/sidechain filter the stream applies — the value the fold would have
 * arrived at had this daemon watched the session live.
 */
export function seedFromEntries(entries: SessionEntry[]): SessionFileSeed {
  const byUuid = new Map<UUID, SessionEntry>();
  for (const entry of entries) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
    }
  }
  const chainEntries = effectiveChain(entries)
    .map((uuid) => byUuid.get(uuid))
    .filter((entry) => entry !== undefined);

  const lastAssistantMessage = chainEntries.findLast(
    (entry) => entry.type === "assistant",
  )?.message as SDKAssistantMessage["message"] | undefined;
  const claudeCodeVersion = entries.findLast(
    (entry) => typeof entry.version === "string",
  )?.version as string | undefined;
  const permissionMode = entries.findLast(
    (entry) => entry.type === "permission-mode",
  )?.permissionMode as PermissionMode | undefined;
  const lastTranscriptUuid = chainEntries.findLast(
    (entry) =>
      (entry.type === "user" || entry.type === "assistant") &&
      entry.isMeta !== true &&
      entry.isSidechain !== true,
  )?.uuid;

  return {
    ...(lastAssistantMessage?.usage !== undefined && {
      lastUsage: toNonNullableUsage(lastAssistantMessage.usage),
    }),
    ...(lastAssistantMessage?.model !== undefined && {
      model: lastAssistantMessage.model,
    }),
    ...(claudeCodeVersion !== undefined && { claudeCodeVersion }),
    ...(permissionMode !== undefined && { permissionMode }),
    ...(lastTranscriptUuid !== undefined && { lastTranscriptUuid }),
  };
}
