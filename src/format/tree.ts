/**
 * `format tree`: renders a session snapshot as an indented tree, one line
 * per visible entry — behavioral parity with `pictl format tree`. The layout
 * geometry is the synced generated/tree-layout.ts; this file owns the
 * clauctl-specific parts: entry summaries, filters, and payload adaptation. Lenient
 * like `format messages` — verbatim entries drift with Anthropic CLI
 * versions, so unrecognized shapes render generically rather than rejecting.
 */

import type { UUID } from "node:crypto";
import { buildTree } from "../core/tree/build-tree.ts";
import { toDisplayTree } from "../core/tree/display-tree.ts";
import { entriesByUuid, type SessionEntry } from "../core/session/file.ts";
import {
  treeChildren,
  formatTreeNodeRef,
  isFinalAssistantEntry,
  parseTreeNodeRef,
  type ParentMap,
  type SessionSnapshot,
} from "../core/tree/nodes.ts";
import { isRecord } from "../core/generated/util.ts";
import { displayUuid } from "../core/uuid.ts";
import { toLayoutTree } from "./generated/flat-tree.ts";
import {
  contentBlocks,
  extractTextContent,
  hasContentBlock,
  oneLine,
  truncateText,
} from "./generated/text.ts";
import {
  flattenVisibleTree,
  treePrefix,
  type FlatLayoutNode,
} from "./generated/tree-layout.ts";

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
      const text = oneLine(extractTextContent(messageContent(entry)));
      return entry.isCompactSummary === true
        ? `compaction: ${text}`
        : `user: ${text}`;
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
    return `assistant: ${parts.length === 0 ? "(no content)" : parts.join(" ")}`;
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
  entryOf: ReadonlyMap<UUID, SessionEntry>,
): Set<string> {
  const finalIds = new Set<string>();
  for (const id of parentMap.keys()) {
    if (isFinalAssistantEntry(id, children, entryOf)) {
      finalIds.add(id);
    }
  }
  return finalIds;
}

/** `omitUuid` drops the uuid column — the /tree selector's rows (uuids are
 *  for CLI copy-paste, noise in an interactive picker). Relinked occurrences
 *  (layout id carries `@boundary`) are marked `~` just before the uuid
 *  column (before the summary when the uuid is omitted). */
export function formatTreeNodeLine(
  flatNode: FlatLayoutNode<SessionEntry>,
  toolNames: ReadonlyMap<string, string>,
  width: number,
  omitUuid?: boolean,
): string {
  const marker = flatNode.isCurrentLeaf
    ? "* "
    : flatNode.isOnActivePath
      ? "• "
      : "";
  const relinked =
    parseTreeNodeRef(flatNode.node.id).viaBoundary === undefined ? "" : "~";
  const uuid8 = omitUuid
    ? ""
    : `${displayUuid(String(flatNode.node.payload.uuid))} `;
  const prefix = `${treePrefix(flatNode)}${marker}${relinked}${uuid8}`;
  const availableSummary = Math.max(0, width - [...prefix].length);
  const summary = entrySummary(flatNode.node.payload, toolNames);
  return `${prefix}${truncateText(summary, availableSummary)}`.trimEnd();
}

/** Whole-input formatter for `format tree`: builds the tree from the
 * snapshot's entries, adapts it to LayoutNode<SessionEntry>[], calls
 * flattenVisibleTree, renders lines + the cursor line. `raw` mode renders
 * buildTree's output verbatim; every other mode renders the display tree,
 * with the leaf marker on the visible row that carries a hidden leaf
 * occurrence (the `[cursor: …]` line keeps the true leaf uuid; a leaf on
 * a rootless hidden chain renders no marker). Layout ids are the tree keys.
 * Relink diagnostics are declared-ignored: interleaving them with the
 * rendered tree would corrupt the output, and invalid relinks still
 * render (un-relinked). */
export function formatSessionSnapshot(
  snapshot: SessionSnapshot,
  options: TreeFormatOptions,
): string {
  const entryOf = entriesByUuid(snapshot.entries);
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
    entryOf,
  );
  const lines = flattenVisibleTree(
    toLayoutTree(parentMap, (id) => entryOf.get(parseTreeNodeRef(id).uuid)!),
    currentLeafId,
    (node) =>
      passesFilter(
        node.payload,
        node.id === currentLeafId,
        finalIds.has(node.id),
        options.filter,
      ),
  ).map((flatNode) => formatTreeNodeLine(flatNode, toolNames, options.width));
  lines.push(`[cursor: ${snapshot.leaf?.uuid ?? "null"}]`);
  return `${lines.join("\n")}\n`;
}
