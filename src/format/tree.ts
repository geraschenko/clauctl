/**
 * `format tree`: renders a session snapshot as a git-log-style DAG, rows in
 * file order with the active chain in column 0 (see
 * docs/specs/tree-presentation.md). The graph geometry is dag-lines.ts
 * (generic); this file owns the clauctl-specific parts: entry glyphs and
 * summaries, filters, and the visible relation. Lenient like `format
 * messages` — verbatim entries drift with Anthropic CLI versions, so
 * unrecognized shapes render generically rather than rejecting.
 */

import type { UUID } from "node:crypto";
import { buildTree } from "../core/tree/build-tree.ts";
import { toDisplayTree } from "../core/tree/display-tree.ts";
import { entriesByUuid, type SessionEntry } from "../core/session/file.ts";
import {
  formatTreeNodeRef,
  isFinalAssistantEntry,
  parseTreeNodeRef,
  type ParentMap,
  type SessionSnapshot,
} from "../core/tree/nodes.ts";
import { treeChildren } from "../core/tree/parent-map.ts";
import { isRecord } from "../core/generated/util.ts";
import { displayUuid } from "../core/uuid.ts";
import {
  ASSISTANT_GLYPH,
  COMPACT_BOUNDARY_GLYPH,
  COMPACT_SUMMARY_GLYPH,
  OTHER_ENTRY_GLYPH,
  TOOL_CALL_GLYPH,
  TOOL_RESULT_GLYPH,
  USER_GLYPH,
} from "../tui/glyphs.ts";
import {
  dagLineText,
  renderDagLines,
  type DagLine,
  type DagRow,
} from "./dag-lines.ts";
import {
  contentBlocks,
  extractTextContent,
  hasContentBlock,
  oneLine,
} from "./generated/text.ts";

export const FILTER_MODES = [
  "conversation",
  "no-tools",
  "user-only",
  "all",
  "picker",
  "raw",
] as const;
export type FilterMode = (typeof FILTER_MODES)[number];

export interface TreeFormatOptions {
  filter: FilterMode;
  width: number;
}

function messageContent(entry: SessionEntry): unknown {
  return isRecord(entry.message) ? entry.message.content : undefined;
}

function recordBlocks(entry: SessionEntry): Record<string, unknown>[] {
  return contentBlocks(messageContent(entry)).filter(isRecord);
}

function hasText(entry: SessionEntry): boolean {
  return extractTextContent(messageContent(entry)).trim() !== "";
}

/** The stop_reason when it signals an abnormal end: present and neither of
 *  the two ordinary values. Aborted/errored turns are kept visible by the
 *  filters through this. */
function abnormalStopReason(entry: SessionEntry): string | undefined {
  const stopReason = isRecord(entry.message)
    ? entry.message.stop_reason
    : undefined;
  return typeof stopReason === "string" &&
    stopReason !== "end_turn" &&
    stopReason !== "tool_use"
    ? stopReason
    : undefined;
}

function toolResultOnly(entry: SessionEntry): boolean {
  return (
    hasContentBlock(messageContent(entry), "tool_result") && !hasText(entry)
  );
}

function userWithText(entry: SessionEntry): boolean {
  return entry.type === "user" && entry.isMeta !== true && hasText(entry);
}

/** `isFinal` is isFinalAssistantEntry over the occurrence, computed by
 *  callers (collectFinalAssistantIds below); only "picker" reads it. */
export function passesFilter(
  entry: SessionEntry,
  isCurrentLeaf: boolean,
  isFinal: boolean,
  filter: FilterMode,
): boolean {
  switch (filter) {
    // "raw" shows buildTree's output verbatim (formatSessionSnapshot picks
    // the tree); "all" shows every display-tree occurrence.
    case "raw":
    case "all":
      return true;
    case "user-only":
      return userWithText(entry);
    case "no-tools":
      // The current-leaf exemption applies to the assistant suppression
      // only (pictl parity): a tool_result leaf is still hidden.
      if (entry.type === "user" && toolResultOnly(entry)) {
        return false;
      }
      return !(
        entry.type === "assistant" &&
        !isCurrentLeaf &&
        hasContentBlock(messageContent(entry), "tool_use") &&
        !hasText(entry) &&
        abnormalStopReason(entry) === undefined
      );
    case "conversation":
      if (entry.subtype === "compact_boundary") {
        return true;
      }
      if (entry.type === "user") {
        return userWithText(entry);
      }
      return (
        entry.type === "assistant" &&
        (hasText(entry) ||
          abnormalStopReason(entry) !== undefined ||
          isCurrentLeaf)
      );
    // The /tree selector's fixed filter: every row is a valid pick target.
    // Restricting assistants to final entries makes assistant rows valid
    // rewindTo targets in ordinary session shapes; the daemon's file-order
    // validation remains the authority.
    case "picker":
      if (isCurrentLeaf || entry.subtype === "compact_boundary") {
        return true;
      }
      if (entry.type === "user") {
        return userWithText(entry);
      }
      return entry.type === "assistant" && isFinal && hasText(entry);
  }
}

/** tool_use id → name over ALL entries (visible or not), so tool_result
 *  lines can name their tool after filtering hides the call. A flat scan —
 *  needs no tree. */
export function collectToolNames(
  entries: readonly SessionEntry[],
): Map<string, string> {
  const toolNames = new Map<string, string>();
  for (const entry of entries) {
    for (const block of recordBlocks(entry)) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        toolNames.set(block.id, block.name);
      }
    }
  }
  return toolNames;
}

export function entrySummary(
  entry: SessionEntry,
  toolNames: ReadonlyMap<string, string>,
): string {
  if (entry.type === "user") {
    if (hasText(entry)) {
      return oneLine(extractTextContent(messageContent(entry)));
    }
    const results = recordBlocks(entry).filter(
      (block) => block.type === "tool_result",
    );
    if (results.length > 0) {
      const toolUseId = results[0]!.tool_use_id;
      const name =
        (typeof toolUseId === "string"
          ? toolNames.get(toolUseId)
          : undefined) ?? "tool";
      const isError = results.some((block) => block.is_error === true);
      return `${name}: ${isError ? "error" : "ok"}`;
    }
  }
  if (entry.type === "assistant") {
    const blocks = recordBlocks(entry);
    const parts: string[] = [];
    if (blocks.some((block) => block.type === "thinking")) {
      parts.push("[thinking]");
    }
    for (const block of blocks) {
      if (block.type === "tool_use") {
        parts.push(
          `[tool: ${typeof block.name === "string" ? block.name : "tool"}]`,
        );
      }
    }
    const text = oneLine(extractTextContent(messageContent(entry)));
    if (text !== "") {
      parts.push(text);
    } else {
      const stopReason = abnormalStopReason(entry);
      if (stopReason !== undefined) {
        parts.push(`(${stopReason})`);
      }
    }
    return parts.length === 0 ? "(no content)" : parts.join(" ");
  }
  if (entry.subtype === "compact_boundary") {
    const preTokens = isRecord(entry.compactMetadata)
      ? entry.compactMetadata.preTokens
      : undefined;
    return typeof preTokens === "number"
      ? `[compaction: ${Math.round(preTokens / 1000)}k tokens]`
      : "[compaction]";
  }
  const type = entry.type ?? "unknown";
  return entry.subtype === undefined ? type : `${type}: ${entry.subtype}`;
}

/** Layout ids of the occurrences that are final assistant entries — the
 *  per-tree input `passesFilter`'s "picker" mode needs. */
export function collectFinalAssistantIds(
  parentMap: ParentMap,
  children: ReadonlyMap<string | null, readonly string[]>,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): Set<string> {
  const finalIds = new Set<string>();
  for (const id of parentMap.keys()) {
    if (isFinalAssistantEntry(id, children, byUuid)) {
      finalIds.add(id);
    }
  }
  return finalIds;
}

/** Classifies the entry into the glyphs.ts vocabulary, first match wins:
 *  compact boundary, compact summary, user with text, tool_result-only
 *  user, assistant with a tool_use block, other assistant, anything else.
 *  Lives here (not in glyphs.ts) because it is entry classification,
 *  sharing hasText/toolResultOnly with passesFilter. */
export function treeRowGlyph(entry: SessionEntry): string {
  if (entry.subtype === "compact_boundary") {
    return COMPACT_BOUNDARY_GLYPH;
  }
  if (entry.isCompactSummary === true) {
    return COMPACT_SUMMARY_GLYPH;
  }
  if (entry.type === "user") {
    if (hasText(entry)) {
      return USER_GLYPH;
    }
    if (toolResultOnly(entry)) {
      return TOOL_RESULT_GLYPH;
    }
  }
  if (entry.type === "assistant") {
    return hasContentBlock(messageContent(entry), "tool_use")
      ? TOOL_CALL_GLYPH
      : ASSISTANT_GLYPH;
  }
  return OTHER_ENTRY_GLYPH;
}

/** The one rendering shared by `format tree` and `/tree`: the rows of
 *  `parentMap` passing `passes`, in parentMap order, hidden rows' children
 *  re-attached to their nearest visible ancestor; the active chain = the
 *  leaf's row → root over that visible relation, where the leaf's row is
 *  currentLeafId itself when it passes, else its nearest visible ancestor
 *  (null → no chain; also for a currentLeafId unknown to the tree).
 *  Labels: the 8-char uuid prefix (`~`-prefixed on relinked ids) unless
 *  omitUuid, then entrySummary. Because a row always follows its parent
 *  (throws otherwise — a buildTree/toDisplayTree invariant), one forward
 *  pass resolves every row's nearest visible ancestor. */
export function treeLines(
  parentMap: ParentMap,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
  currentLeafId: string | null,
  passes: (id: string, entry: SessionEntry) => boolean,
  toolNames: ReadonlyMap<string, string>,
  omitUuid: boolean,
): DagLine[] {
  /** Every id → its nearest visible strict ancestor (null = none). */
  const visibleAncestorOf = new Map<string, string | null>();
  const visible = new Set<string>();
  const rows: DagRow[] = [];
  for (const [id, parent] of parentMap) {
    let visibleAncestor: string | null = null;
    if (parent !== null) {
      if (!visibleAncestorOf.has(parent)) {
        throw new Error(`treeLines: row ${id} precedes its parent ${parent}`);
      }
      visibleAncestor = visible.has(parent)
        ? parent
        : visibleAncestorOf.get(parent)!;
    }
    visibleAncestorOf.set(id, visibleAncestor);
    const ref = parseTreeNodeRef(id);
    const entry = byUuid.get(ref.uuid)!;
    if (!passes(id, entry)) {
      continue;
    }
    visible.add(id);
    const label = omitUuid
      ? entrySummary(entry, toolNames)
      : `${ref.viaBoundary === undefined ? "" : "~"}${displayUuid(ref.uuid)} ${entrySummary(entry, toolNames)}`;
    rows.push({
      id,
      parentId: visibleAncestor,
      glyph: treeRowGlyph(entry),
      label,
    });
  }
  let leafRow: string | null = null;
  if (currentLeafId !== null) {
    leafRow = visible.has(currentLeafId)
      ? currentLeafId
      : (visibleAncestorOf.get(currentLeafId) ?? null);
  }
  return renderDagLines(rows, leafRow);
}

/** Whole-input formatter for `format tree`: builds the tree from the
 * snapshot's entries, renders treeLines + the cursor line. `raw` mode
 * renders buildTree's output verbatim; every other mode renders the
 * display tree, with a hidden leaf occurrence mapped to its nearest
 * visible row (the `[cursor: …]` line keeps the true leaf uuid). Relink
 * diagnostics are declared-ignored: interleaving them with the rendered
 * tree would corrupt the output, and invalid relinks still render
 * (un-relinked). */
export function formatSessionSnapshot(
  snapshot: SessionSnapshot,
  options: TreeFormatOptions,
): string {
  const byUuid = entriesByUuid(snapshot.entries);
  const fullTree = buildTree(snapshot.entries, () => {});
  let parentMap: ParentMap;
  let currentLeafId: string | null;
  if (options.filter === "raw") {
    parentMap = fullTree;
    currentLeafId =
      snapshot.leaf === null ? null : formatTreeNodeRef(snapshot.leaf);
  } else {
    const displayTree = toDisplayTree(fullTree, snapshot.entries);
    parentMap = displayTree.parentMap;
    const leafRow =
      snapshot.leaf === null
        ? undefined
        : displayTree.nearestVisibleRow(snapshot.leaf);
    currentLeafId = leafRow === undefined ? null : formatTreeNodeRef(leafRow);
  }
  const toolNames = collectToolNames(snapshot.entries);
  const finalIds = collectFinalAssistantIds(
    parentMap,
    treeChildren(parentMap),
    byUuid,
  );
  const lines = treeLines(
    parentMap,
    byUuid,
    currentLeafId,
    (id, entry) =>
      passesFilter(
        entry,
        id === currentLeafId,
        finalIds.has(id),
        options.filter,
      ),
    toolNames,
    false,
  ).map((line) => dagLineText(line, options.width));
  lines.push(`[cursor: ${snapshot.leaf?.uuid ?? "null"}]`);
  return `${lines.join("\n")}\n`;
}
