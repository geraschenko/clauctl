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
import { toContextTree } from "../core/tree/context-tree.ts";
import { toDisplayTree } from "../core/tree/display-tree.ts";
import {
  entriesByUuid,
  queuedCommandPrompt,
  type SessionEntry,
} from "../core/session/file.ts";
import {
  formatTreeNodeRef,
  parseTreeNodeRef,
  type ParentMap,
  type TreeNodeStr,
} from "../core/tree/nodes.ts";
import { isRecord } from "../core/generated/util.ts";
import { displayUuid } from "../core/uuid.ts";
import {
  ASSISTANT_GLYPH,
  COMPACT_BOUNDARY_GLYPH,
  COMPACT_SUMMARY_GLYPH,
  OTHER_ENTRY_GLYPH,
  TOOL_CALL_GLYPH,
  TOOL_RESULT_GLYPH,
  USER_BUT_NON_HUMAN_GLYPH,
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
import type { SnapshotDocument } from "./input.ts";

export const FILTER_MODES = [
  "conversation",
  "no-tools",
  "user-only",
  "all",
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

/** The first CLI version that writes `origin` on user entries. Entries
 *  written earlier take the pre-origin fallback. */
const ORIGIN_FIELD_SINCE = "2.1.190";

/** A prompt the human typed. Entries whose writer (`entry.version`) knew
 *  the field carry the CLI's verdict in `origin`; older entries go through
 *  the pre-origin fallback (see docs/thoughts/subagent-activity.md). */
export function isHumanPrompt(entry: SessionEntry): boolean {
  return (
    entry.type === "user" &&
    (writtenBefore(entry, ORIGIN_FIELD_SINCE)
      ? preOriginHumanPrompt(entry)
      : isRecord(entry.origin) && entry.origin.kind === "human")
  );
}

/** A prompt the human typed, whichever way the CLI recorded it: a `user`
 *  entry (submitted idle) or a `queued_command` attachment (steered
 *  mid-turn). Compact summaries are prompt rows too for the filters, but
 *  not prompts. */
function isPromptEntry(entry: SessionEntry): boolean {
  return isHumanPrompt(entry) || queuedCommandPrompt(entry) !== undefined;
}

/** `entry.version` (dotted numeric) is older than `version`; a missing or
 *  unparsable version counts as older. */
function writtenBefore(entry: SessionEntry, version: string): boolean {
  if (typeof entry.version !== "string") {
    return true;
  }
  const parse = (dotted: string): number[] | undefined => {
    const parts = dotted.split(".").map(Number);
    return parts.every(Number.isInteger) ? parts : undefined;
  };
  const written = parse(entry.version);
  const since = parse(version);
  if (written === undefined || since === undefined) {
    return true;
  }
  for (let i = 0; i < Math.max(written.length, since.length); i += 1) {
    const a = written[i] ?? 0;
    const b = since[i] ?? 0;
    if (a !== b) {
      return a < b;
    }
  }
  return false;
}

// TEMPORARY — pre-2.1.190 fallback. Delete this block, ORIGIN_FIELD_SINCE
// and writtenBefore once sessions older than 2.1.190 no longer matter.
const PRE_ORIGIN_NON_HUMAN_PREFIXES = [
  "<command-",
  "<local-command-",
  "<bash-",
  "[Request interrupted",
];
/** Not isMeta, has text, text not starting with a known non-human prefix.
 *  Callers guard `type === "user"`. */
function preOriginHumanPrompt(entry: SessionEntry): boolean {
  const text = extractTextContent(messageContent(entry)).trim();
  return (
    entry.isMeta !== true &&
    text !== "" &&
    !PRE_ORIGIN_NON_HUMAN_PREFIXES.some((prefix) => text.startsWith(prefix))
  );
}

/** "conversation" is also the /tree selector's filter: every row it keeps
 *  is a valid pick target (a hidden occurrence's pick resolves through
 *  its nearest visible row). */
export function passesFilter(
  entry: SessionEntry,
  isCurrentLeaf: boolean,
  filter: FilterMode,
): boolean {
  switch (filter) {
    // "raw" shows buildTree's output verbatim (formatSessionSnapshot picks
    // the tree); "all" shows every display-tree occurrence.
    case "raw":
    case "all":
      return true;
    case "user-only":
      return isPromptEntry(entry) || entry.isCompactSummary === true;
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
      if (
        entry.subtype === "compact_boundary" ||
        isPromptEntry(entry) ||
        entry.isCompactSummary === true
      ) {
        return true;
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
  const steeredPrompt = queuedCommandPrompt(entry);
  if (steeredPrompt !== undefined) {
    return oneLine(steeredPrompt);
  }
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

/** Classifies the entry into the glyphs.ts vocabulary, first match wins:
 *  compact boundary, compact summary, prompt (typed or steered),
 *  tool_result-only user, other user with text, assistant with a tool_use
 *  block, other assistant, anything else. Lives here (not in glyphs.ts)
 *  because it is entry classification, sharing hasText/toolResultOnly with
 *  passesFilter. */
export function treeRowGlyph(entry: SessionEntry): string {
  if (entry.subtype === "compact_boundary") {
    return COMPACT_BOUNDARY_GLYPH;
  }
  if (entry.isCompactSummary === true) {
    return COMPACT_SUMMARY_GLYPH;
  }
  if (isPromptEntry(entry)) {
    return USER_GLYPH;
  }
  if (entry.type === "user") {
    if (toolResultOnly(entry)) {
      return TOOL_RESULT_GLYPH;
    }
    if (hasText(entry)) {
      return USER_BUT_NON_HUMAN_GLYPH;
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
  currentLeafId: TreeNodeStr | null,
  passes: (id: TreeNodeStr, entry: SessionEntry) => boolean,
  toolNames: ReadonlyMap<string, string>,
  omitUuid: boolean,
): DagLine[] {
  /** Every id → its nearest visible strict ancestor (null = none). */
  const visibleAncestorOf = new Map<TreeNodeStr, TreeNodeStr | null>();
  const visible = new Set<TreeNodeStr>();
  const rows: DagRow[] = [];
  for (const [id, parent] of parentMap) {
    let visibleAncestor: TreeNodeStr | null = null;
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
  let leafRow: TreeNodeStr | null = null;
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
export function formatSnapshotDocument(
  snapshot: SnapshotDocument,
  options: TreeFormatOptions,
): string {
  const byUuid = entriesByUuid(snapshot.entries);
  const fullTree = buildTree(snapshot.entries, () => {});
  let parentMap: ParentMap;
  let currentLeafId: TreeNodeStr | null;
  if (options.filter === "raw") {
    parentMap = fullTree;
    currentLeafId =
      snapshot.leaf === null ? null : formatTreeNodeRef(snapshot.leaf);
  } else {
    const displayTree = toDisplayTree(
      fullTree,
      toContextTree(fullTree, byUuid),
      byUuid,
    );
    parentMap = displayTree.parentMap;
    const leafNode =
      snapshot.leaf === null
        ? undefined
        : displayTree.nearestVisibleNode(snapshot.leaf);
    currentLeafId = leafNode === undefined ? null : formatTreeNodeRef(leafNode);
  }
  const toolNames = collectToolNames(snapshot.entries);
  const lines = treeLines(
    parentMap,
    byUuid,
    currentLeafId,
    (id, entry) => passesFilter(entry, id === currentLeafId, options.filter),
    toolNames,
    false,
  ).map((line) => dagLineText(line, options.width));
  lines.push(`[cursor: ${snapshot.leaf?.uuid ?? "null"}]`);
  return `${lines.join("\n")}\n`;
}
