/**
 * `format tree`: renders a session snapshot as a git-log-style DAG, rows in
 * file order with the active chain in column 0 (see
 * docs/specs/tree-presentation.md). The graph geometry is dag-lines.ts
 * (generic); this file owns the clauctl-specific parts: filters and the
 * visible relation; row glyphs, labels and sizes come from the entry views
 * (src/format/entry-view/entry-view.ts). Lenient like `format messages` —
 * verbatim entries drift with Anthropic CLI versions, so unrecognized
 * shapes render generically rather than rejecting.
 */

import type { UUID } from "node:crypto";
import { buildTree } from "../core/tree/build-tree.ts";
import { toContextTree } from "../core/tree/context-tree.ts";
import { toDisplayTree } from "../core/tree/display-tree.ts";
import { entriesByUuid, type SessionEntry } from "../core/session/file.ts";
import { trackToolNames } from "../core/session/track-tool-names.ts";
import {
  formatTreeNodeRef,
  parseTreeNodeRef,
  type ParentMap,
  type TreeNodeStr,
} from "../core/tree/nodes.ts";
import { displayUuid } from "../core/uuid.ts";
import {
  abnormalStopReason,
  hasText,
  isPromptEntry,
  toolResultOnly,
} from "../core/session/entry-predicates.ts";
import { messageContent } from "../core/session/file.ts";
import { entryViewFor } from "./entry-view/index.ts";
import {
  dagLineText,
  renderDagLines,
  type DagLine,
  type DagRow,
} from "./dag-lines.ts";
import { hasContentBlock } from "../core/generated/text.ts";
import type { SnapshotDocument } from "./input.ts";

export const FILTER_MODES = [
  "conversation",
  "no-tools",
  "user-only",
  "all",
  "raw",
] as const;
export type FilterMode = (typeof FILTER_MODES)[number];

/** `format tree` / CLI options: the filter is one of the named modes. */
export interface TreeFormatOptions {
  filter: FilterMode;
  width: number;
  omitUuids: boolean;
  sizes: boolean;
}

/** `treeLines` options: the filter is an arbitrary row predicate (a
 *  FilterMode via `passesFilter`, or anything else — e.g. a search that
 *  keeps the tree structure). */
export interface TreeLineOptions {
  filter: (id: TreeNodeStr, entry: SessionEntry) => boolean;
  width: number;
  omitUuids: boolean;
  sizes: boolean;
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

/** The one rendering shared by `format tree` and `/tree`: the rows of
 *  `parentMap` passing `filter`, in parentMap order, hidden rows' children
 *  re-attached to their nearest visible ancestor; the active chain = the
 *  leaf's row → root over that visible relation, where the leaf's row is
 *  currentLeafId itself when it passes, else its nearest visible ancestor
 *  (null → no chain; also for a currentLeafId unknown to the tree).
 *  Labels: the 8-char uuid prefix (`~`-prefixed on relinked ids) unless
 *  `omitUuids`, then the entry view's summary (`width` bounds it) and, with
 *  `sizes`, its size.
 *  Because a row always follows its parent (throws otherwise — a
 *  buildTree/toDisplayTree invariant), one forward pass resolves every
 *  row's nearest visible ancestor. */
export function treeLines(
  parentMap: ParentMap,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
  currentLeafId: TreeNodeStr | null,
  toolNames: ReadonlyMap<string, string>,
  options: TreeLineOptions,
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
    if (!options.filter(id, entry)) {
      continue;
    }
    visible.add(id);
    const view = entryViewFor(entry);
    const summary = view.summary(entry, toolNames, options.width);
    const label = options.omitUuids
      ? summary
      : `${ref.viaBoundary === undefined ? "" : "~"}${displayUuid(ref.uuid)} ${summary}`;
    rows.push({
      id,
      parentId: visibleAncestor,
      glyph: view.glyph,
      label,
      size: options.sizes ? view.size(entry) : undefined,
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
  const toolNames = new Map<string, string>();
  for (const entry of snapshot.entries) {
    trackToolNames(entry, toolNames);
  }
  const lines = treeLines(parentMap, byUuid, currentLeafId, toolNames, {
    ...options,
    filter: (id, entry) =>
      passesFilter(entry, id === currentLeafId, options.filter),
  }).map((line) => dagLineText(line, options.width));
  lines.push(`[cursor: ${snapshot.leaf?.uuid ?? "null"}]`);
  return `${lines.join("\n")}\n`;
}
