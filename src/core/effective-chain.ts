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
import { foldUsage } from "./agent-state.ts";
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
    | { preservedMessages?: { anchorUuid?: UUID; uuids?: unknown } }
    | undefined;
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

/**
 * The boundary's effective-parent map (spec "Concrete examples"): the
 * load-time relink as parent overrides. `uuids[i] → uuids[i-1]`,
 * `uuids[0] → anchorUuid`; in from-shape (anchor = the boundary's own uuid)
 * with a summary and non-empty uuids, the summary's effective parent is
 * `uuids[last]` — the raw chain there runs summary → boundary and would skip
 * the preserved uuids entirely, but the loader's from-shape context is
 * [uuids…, summary] (p2.b; see file comment). With empty uuids the summary
 * keeps its raw parent (the boundary) — the intended summary-only context.
 */
function effectiveParentMap(
  entries: SessionEntry[],
  boundaryIndex: number,
): Map<UUID, UUID> {
  const boundary = entries[boundaryIndex]!;
  const map = new Map<UUID, UUID>();
  const preserved = preservedMessagesOf(boundary);
  if (preserved === undefined) {
    return map;
  }
  const { anchorUuid, uuids } = preserved;
  for (let i = 1; i < uuids.length; i += 1) {
    map.set(uuids[i]!, uuids[i - 1]!);
  }
  if (uuids.length > 0 && anchorUuid !== undefined) {
    map.set(uuids[0]!, anchorUuid);
  }
  if (anchorUuid === boundary.uuid && uuids.length > 0) {
    const summaryUuid = summaryOf(entries, boundaryIndex)?.uuid;
    if (summaryUuid !== undefined) {
      map.set(summaryUuid, uuids[uuids.length - 1]!);
    }
  }
  return map;
}

/**
 * The effective context chain (root → tip) the loader would produce for this
 * entries list — pass a truncated list for "the context when entry X first
 * appeared". Mirrors loader semantics: only the LAST boundary applies
 * (stacked boundaries: last wins entirely — P3 m5; see file comment); the
 * walk takes mapped parents first, raw `parentUuid` otherwise; any boundary
 * entry is transparent — reaching one (or an entry with no parent) ends the
 * walk.
 */
export function effectiveChain(entries: SessionEntry[]): UUID[] {
  const byUuid = new Map<UUID, SessionEntry>();
  for (const entry of entries) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
    }
  }

  const boundaryIndex = entries.findLastIndex(
    (entry) => entry.subtype === "compact_boundary",
  );
  let map = new Map<UUID, UUID>();
  let tip: UUID | undefined;
  if (boundaryIndex === -1) {
    tip = entries.findLast((entry) => entry.uuid !== undefined)?.uuid;
  } else {
    const boundary = entries[boundaryIndex]!;
    map = effectiveParentMap(entries, boundaryIndex);
    const summaryUuid = summaryOf(entries, boundaryIndex)?.uuid;
    // Entries written after the boundary (its own summary aside) chain on
    // top of the relinked context; with none, the tip is the relinked
    // skeleton's own tip: [summary, uuids…] (up_to), [uuids…, summary]
    // (from), or [uuids…] (no summary).
    const post = entries
      .slice(boundaryIndex + 1)
      .filter(
        (entry) => entry.uuid !== undefined && entry.uuid !== summaryUuid,
      );
    if (post.length > 0) {
      tip = post.at(-1)!.uuid;
    } else {
      const preserved = preservedMessagesOf(boundary);
      const fromShape = preserved?.anchorUuid === boundary.uuid;
      tip =
        (fromShape || preserved === undefined || preserved.uuids.length === 0
          ? summaryUuid
          : undefined) ??
        preserved?.uuids.at(-1) ??
        summaryUuid;
    }
  }

  const chain: UUID[] = [];
  const seen = new Set<UUID>();
  let current = tip;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const entry = byUuid.get(current);
    if (entry === undefined || entry.subtype === "compact_boundary") {
      break;
    }
    chain.push(current);
    current = map.get(current) ?? entry.parentUuid ?? undefined;
  }
  chain.reverse();
  return chain;
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
      lastUsage: foldUsage(lastAssistantMessage.usage),
    }),
    ...(lastAssistantMessage?.model !== undefined && {
      model: lastAssistantMessage.model,
    }),
    ...(claudeCodeVersion !== undefined && { claudeCodeVersion }),
    ...(permissionMode !== undefined && { permissionMode }),
    ...(lastTranscriptUuid !== undefined && { lastTranscriptUuid }),
  };
}
