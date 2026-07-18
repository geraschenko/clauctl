/**
 * The `/tree` picker: the session tree rendered exactly as `clauctl format
 * tree --filter picker` renders it (shared flattenVisibleTree +
 * formatTreeNodeLine, uuids omitted), with pi-style search and navigation.
 * Pick semantics (resolveTreePick) live here too; interactive-mode owns the
 * busy gate and the set-context request.
 */

import { Container, matchesKey, type Focusable } from "@earendil-works/pi-tui";
import type { SessionEntry } from "../../core/session-file.ts";
import {
  formatTreeNodeRef,
  parseTreeNodeRef,
  pathToLeaf,
  type SessionTree,
  type TreeNodeRef,
} from "../../core/tree.ts";
import { extractTextContent } from "../../format/generated/text.ts";
import {
  flattenVisibleTree,
  type FlatLayoutNode,
  type LayoutNode,
} from "../../format/generated/tree-layout.ts";
import {
  collectFinalAssistantIds,
  collectToolNames,
  entrySummary,
  formatTreeNodeLine,
  passesFilter,
  toLayoutNode,
} from "../../format/tree.ts";
import { theme } from "../theme.ts";

const MAX_VISIBLE_ROWS = 15;

export type TreePickAction =
  | { kind: "rewind"; rewindTo: TreeNodeRef; editorText?: string }
  | { kind: "newRoot"; editorText?: string };

/**
 * Assistant pick → itself; user pick → nearest assistant ancestor +
 * editorText = the user text; boundary pick → nearest assistant ancestor,
 * no editorText (undoes the boundary); no assistant ancestor → newRoot
 * (sent as {uuids: []}). The ancestor is not re-resolved to the final entry
 * of its API message: the nearest assistant ancestor on a path is final by
 * construction except in exotic interrupt shapes, which the daemon's
 * final-entry validation rejects with a clear error. An empty user text
 * (reachable via the current-leaf filter exemption) omits editorText.
 */
export function resolveTreePick(
  tree: SessionTree,
  pick: TreeNodeRef,
): TreePickAction {
  const path = pathToLeaf(tree.tree, pick);
  const picked = path.at(-1);
  if (picked?.entry.type === "assistant") {
    return { kind: "rewind", rewindTo: pick };
  }
  const pickedContent =
    picked !== undefined &&
    picked.entry.type === "user" &&
    typeof picked.entry.message === "object" &&
    picked.entry.message !== null
      ? (picked.entry.message as { content?: unknown }).content
      : undefined;
  const editorText = extractTextContent(pickedContent);
  const editorTextField = editorText === "" ? {} : { editorText };
  for (let index = path.length - 2; index >= 0; index -= 1) {
    const ancestor = path[index]!;
    if (ancestor.entry.type === "assistant") {
      return {
        kind: "rewind",
        rewindTo: {
          uuid: ancestor.entry.uuid!,
          ...(ancestor.viaBoundary !== undefined && {
            viaBoundary: ancestor.viaBoundary,
          }),
        },
        ...editorTextField,
      };
    }
  }
  return { kind: "newRoot", ...editorTextField };
}

/** Printable input (no C0/C1 control characters) appends to the search. */
function isPrintable(data: string): boolean {
  return (
    data.length > 0 &&
    ![...data].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    })
  );
}

export class TreeSelectorComponent extends Container implements Focusable {
  focused = false;

  private readonly roots: LayoutNode<SessionEntry>[];
  private readonly currentLeafId: string | null;
  private readonly toolNames: ReadonlyMap<string, string>;
  private readonly finalIds: ReadonlySet<string>;
  /** Full-tree parent relation (layout ids), for nearest-visible-ancestor
   *  selection recovery when search hides the selected row. */
  private readonly parentById = new Map<string, string | null>();
  private readonly onSelect: (pick: TreeNodeRef) => void;
  private readonly onCancel: () => void;

  private searchQuery = "";
  private visibleRows: readonly FlatLayoutNode<SessionEntry>[] = [];
  private selectedIndex = 0;
  private lastSelectedId: string | null;
  private warning: string | undefined;

  constructor(
    tree: SessionTree,
    onSelect: (pick: TreeNodeRef) => void,
    onCancel: () => void,
  ) {
    super();
    this.roots = tree.tree.map(toLayoutNode);
    this.currentLeafId =
      tree.leaf === null ? null : formatTreeNodeRef(tree.leaf);
    this.toolNames = collectToolNames(tree.tree);
    this.finalIds = collectFinalAssistantIds(tree.tree);
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    const visit = (
      node: LayoutNode<SessionEntry>,
      parentId: string | null,
    ): void => {
      this.parentById.set(node.id, parentId);
      node.children.forEach((child) => visit(child, node.id));
    };
    this.roots.forEach((root) => visit(root, null));
    this.lastSelectedId = this.currentLeafId;
    this.applyFilter();
  }

  /** Persistent warning line for contextChanged-while-open. */
  setWarning(text: string): void {
    this.warning = text;
  }

  /**
   * Recompute the visible rows: the fixed "picker" filter AND-composed with
   * the search tokens in one predicate, so hidden-parent re-attachment keeps
   * working during search. The current-leaf exemption is part of the fixed
   * filter only — a search that doesn't match the leaf hides it (pi parity).
   */
  private applyFilter(): void {
    const selected = this.visibleRows[this.selectedIndex];
    if (selected !== undefined) {
      this.lastSelectedId = selected.node.id;
    }
    const tokens = this.searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token !== "");
    this.visibleRows = flattenVisibleTree(
      this.roots,
      this.currentLeafId,
      (node) => {
        if (
          !passesFilter(
            node.payload,
            node.id === this.currentLeafId,
            this.finalIds.has(node.id),
            "picker",
          )
        ) {
          return false;
        }
        if (tokens.length === 0) {
          return true;
        }
        const summary = entrySummary(
          node.payload,
          this.toolNames,
        ).toLowerCase();
        return tokens.every((token) => summary.includes(token));
      },
    );
    this.selectedIndex =
      this.lastSelectedId === null
        ? 0
        : this.nearestVisibleIndex(this.lastSelectedId);
  }

  /** The row of `id` if visible, else its nearest visible ancestor, else a
   *  clamp of the previous selection. */
  private nearestVisibleIndex(id: string): number {
    const indexById = new Map(
      this.visibleRows.map((row, index) => [row.node.id, index]),
    );
    let currentId: string | null = id;
    while (currentId !== null) {
      const index = indexById.get(currentId);
      if (index !== undefined) {
        return index;
      }
      currentId = this.parentById.get(currentId) ?? null;
    }
    return Math.min(
      this.selectedIndex,
      Math.max(0, this.visibleRows.length - 1),
    );
  }

  override render(width: number): string[] {
    const lines: string[] = [];
    lines.push(
      theme.fg("accent", "pick a tree entry (enter to rewind, esc to cancel)"),
    );
    if (this.visibleRows.length === 0) {
      lines.push(theme.fg("dim", "(no matching entries)"));
    } else {
      const start = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2),
          this.visibleRows.length - MAX_VISIBLE_ROWS,
        ),
      );
      const end = Math.min(start + MAX_VISIBLE_ROWS, this.visibleRows.length);
      for (let index = start; index < end; index += 1) {
        const line = formatTreeNodeLine(
          this.visibleRows[index]!,
          this.toolNames,
          width,
          true,
        );
        lines.push(index === this.selectedIndex ? theme.inverse(line) : line);
      }
    }
    if (this.searchQuery !== "") {
      lines.push(theme.fg("dim", `search: ${this.searchQuery}`));
    }
    if (this.warning !== undefined) {
      lines.push(theme.fg("warning", this.warning));
    }
    return lines;
  }

  handleInput(data: string): void {
    const rowCount = this.visibleRows.length;
    if (matchesKey(data, "up")) {
      if (rowCount > 0) {
        this.selectedIndex =
          this.selectedIndex === 0 ? rowCount - 1 : this.selectedIndex - 1;
      }
    } else if (matchesKey(data, "down")) {
      if (rowCount > 0) {
        this.selectedIndex =
          this.selectedIndex === rowCount - 1 ? 0 : this.selectedIndex + 1;
      }
    } else if (matchesKey(data, "pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - MAX_VISIBLE_ROWS);
    } else if (matchesKey(data, "pageDown")) {
      this.selectedIndex = Math.min(
        Math.max(0, rowCount - 1),
        this.selectedIndex + MAX_VISIBLE_ROWS,
      );
    } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const selected = this.visibleRows[this.selectedIndex];
      if (selected !== undefined) {
        // Layout ids ARE formatTreeNodeRef output, so the pick recovers the
        // occurrence directly — no parallel bookkeeping.
        this.onSelect(parseTreeNodeRef(selected.node.id));
      }
    } else if (matchesKey(data, "escape")) {
      if (this.searchQuery !== "") {
        this.searchQuery = "";
        this.applyFilter();
      } else {
        this.onCancel();
      }
    } else if (matchesKey(data, "backspace")) {
      if (this.searchQuery !== "") {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.applyFilter();
      }
    } else if (isPrintable(data)) {
      this.searchQuery += data;
      this.applyFilter();
    }
  }
}
