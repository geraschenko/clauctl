/**
 * `format tree`: renders get-tree output as an indented forest, one line per
 * visible entry — behavioral parity with `pictl format tree`. The layout
 * geometry is the synced generated/tree-layout.ts; this file owns the
 * clauctl-specific parts: entry summaries, filters, and the adapter. Lenient
 * like `format messages` — verbatim entries drift with Anthropic CLI
 * versions, so unrecognized shapes render generically rather than rejecting.
 */

import type { SessionTree, TreeNode } from "../core/build-tree.ts";
import type { SessionEntry } from "../core/session-file.ts";
import { extractTextContent, oneLine, truncateText } from "./generated/text.ts";
import {
  flattenVisibleTree,
  treePrefix,
  type FlatLayoutNode,
  type LayoutNode,
} from "./generated/tree-layout.ts";

export const FILTER_MODES = [
  "conversation",
  "no-tools",
  "user-only",
  "all",
] as const;
export type FilterMode = (typeof FILTER_MODES)[number];

export interface TreeFormatOptions {
  filter: FilterMode;
  width: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageContent(entry: SessionEntry): unknown {
  return isRecord(entry.message) ? entry.message.content : undefined;
}

function contentBlocks(entry: SessionEntry): Record<string, unknown>[] {
  const content = messageContent(entry);
  return Array.isArray(content) ? content.filter(isRecord) : [];
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
    contentBlocks(entry).some((block) => block.type === "tool_result") &&
    !hasText(entry)
  );
}

function userWithText(entry: SessionEntry): boolean {
  return entry.type === "user" && entry.isMeta !== true && hasText(entry);
}

function passesFilter(
  entry: SessionEntry,
  isCurrentLeaf: boolean,
  filter: FilterMode,
): boolean {
  switch (filter) {
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
        contentBlocks(entry).some((block) => block.type === "tool_use") &&
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
  }
}

/** tool_use id → name over ALL entries (visible or not), so tool_result
 *  lines can name their tool after filtering hides the call. */
function collectToolNames(tree: TreeNode[]): Map<string, string> {
  const toolNames = new Map<string, string>();
  const visit = (node: TreeNode): void => {
    for (const block of contentBlocks(node.entry)) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        toolNames.set(block.id, block.name);
      }
    }
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  return toolNames;
}

function entrySummary(
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
    const results = contentBlocks(entry).filter(
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
    const blocks = contentBlocks(entry);
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

function layoutId(uuid: string, viaBoundary: string | undefined): string {
  return viaBoundary === undefined ? uuid : `${uuid}@${viaBoundary}`;
}

function toLayoutNode(node: TreeNode): LayoutNode<SessionEntry> {
  return {
    id: layoutId(String(node.entry.uuid), node.viaBoundary),
    children: node.children.map(toLayoutNode),
    payload: node.entry,
  };
}

function formatTreeNodeLine(
  flatNode: FlatLayoutNode<SessionEntry>,
  toolNames: ReadonlyMap<string, string>,
  width: number,
): string {
  const marker = flatNode.isCurrentLeaf
    ? "* "
    : flatNode.isOnActivePath
      ? "• "
      : "";
  const uuid8 = String(flatNode.node.payload.uuid).slice(0, 8);
  const prefix = `${treePrefix(flatNode)}${marker}${uuid8} `;
  const availableSummary = Math.max(0, width - [...prefix].length);
  const summary = entrySummary(flatNode.node.payload, toolNames);
  return `${prefix}${truncateText(summary, availableSummary)}`.trimEnd();
}

/** Whole-input formatter for `format tree`: adapts TreeNode[] to
 * LayoutNode<SessionEntry>[], calls flattenVisibleTree, renders lines +
 * the cursor line. Layout ids are adapter-internal occurrence composites —
 * `uuid` when the node has no viaBoundary, else `${uuid}@${viaBoundary}`
 * ("@" cannot appear in a uuid) — and currentLeafId is the same composite
 * over `input.leaf`. Unique layout ids are a checked precondition of the
 * synced layout: `flattenVisibleTree` throws on duplicates, so an adapter
 * bug fails loudly. */
export function formatSessionTree(
  input: SessionTree,
  options: TreeFormatOptions,
): string {
  const toolNames = collectToolNames(input.tree);
  const currentLeafId =
    input.leaf === null
      ? null
      : layoutId(input.leaf.uuid, input.leaf.viaBoundary);
  const lines = flattenVisibleTree(
    input.tree.map(toLayoutNode),
    currentLeafId,
    (node) =>
      passesFilter(node.payload, node.id === currentLeafId, options.filter),
  ).map((flatNode) => formatTreeNodeLine(flatNode, toolNames, options.width));
  lines.push(`[cursor: ${input.leaf?.uuid ?? "null"}]`);
  return `${lines.join("\n")}\n`;
}
