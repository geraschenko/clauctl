/**
 * The `/tree` picker: the session tree rendered exactly as `clauctl format
 * tree --filter picker` renders it (shared flattenVisibleTree +
 * formatTreeNodeLine, uuids omitted), with pi-style search and navigation.
 * Pick semantics (resolveTreePick) live here too; interactive-mode owns the
 * busy gate and the set-context request.
 */

import type { UUID } from "node:crypto";
import {
  Container,
  getKeybindings,
  matchesKey,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { DisplayTree } from "../../core/tree/display-tree.ts";
import {
  loadedContext,
  loadedContextUuids,
  type OnInvalid,
} from "../../core/tree/loader.ts";
import type { SessionEntry } from "../../core/session/file.ts";
import {
  treeChildren,
  formatTreeNodeRef,
  parseTreeNodeRef,
  pathToLeaf,
  type ParentMap,
  type TreeNodeRef,
} from "../../core/tree/nodes.ts";
import { toLayoutTree } from "../../format/generated/flat-tree.ts";
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
} from "../../format/tree.ts";
import { theme } from "../theme.ts";

const MAX_VISIBLE_ROWS = 15;

export type TreePickAction =
  | { kind: "rewind"; rewindTo: TreeNodeRef; editorText?: string }
  | { kind: "setChain"; uuids: UUID[] }
  | { kind: "newRoot"; editorText?: string };

/** The fresh-compaction context a summary pick re-installs: the loader's
 *  view of the file truncated just after the summary — the summary plus
 *  its boundary's preserved chain, before any post-compaction turns —
 *  filtered to user/assistant uuids (system entries carry no context).
 *  Undefined when the summary is not on that chain (corrupt or
 *  hand-crafted file). */
function summaryChainUuids(
  summary: SessionEntry,
  entries: SessionEntry[],
  entryOf: ReadonlyMap<UUID, SessionEntry>,
  onInvalid: OnInvalid,
): UUID[] | undefined {
  // NOTE: For an "up_to" summary, the summary appears in the assistant's
  // context _before_ the preserved uuids. However, it's presented to the user
  // as appearing _after_ the preserved uuids. So if the user picks the summary,
  // their expectation is that the perserved uuids remain in context.
  const summaryIndex = entries.findIndex(
    (entry) => entry.uuid === summary.uuid,
  );
  const chain = loadedContextUuids(
    entries.slice(0, summaryIndex + 1),
    onInvalid,
  );
  if (!chain.includes(summary.uuid!)) {
    return undefined;
  }
  return chain.filter((uuid) => {
    const type = entryOf.get(uuid)?.type;
    return type === "user" || type === "assistant";
  });
}

/**
 * Assistant pick → itself; user pick → nearest assistant ancestor on the
 * FULL tree + editorText = the user text (so editing a post-compaction
 * message stays inside the compacted context); boundary pick → "undo the
 * boundary": rewind to the last assistant ref of the pre-boundary loaded
 * context (the true pre-boundary context tip, correct even when that tip
 * is a relinked occurrence of an older boundary), no editorText; summary
 * pick → the compaction stays in effect with the summary as-is: setChain
 * with the fresh-compaction context (the summary plus its boundary's
 * preserved chain; the summary is a user entry the daemon cannot rewind
 * to, so its old entry rides along as a preserved uuid of a fresh
 * boundary), no editorText; no assistant found → newRoot (sent as
 * {uuids: []}). The
 * ancestor is not re-resolved to the final entry of its API message: the
 * nearest assistant ancestor on a path is final by construction except in
 * exotic interrupt shapes, which the daemon's final-entry validation
 * rejects with a clear error. An empty user text (reachable via the
 * current-leaf filter exemption) omits editorText. A malformed summary
 * (parent not a boundary, or off its boundary's chain — corrupt or
 * hand-crafted file) falls back to ordinary user-row pick semantics.
 */
export function resolveTreePick(
  fullTree: ParentMap,
  entries: SessionEntry[],
  entryOf: ReadonlyMap<UUID, SessionEntry>,
  pick: TreeNodeRef,
  onInvalid: OnInvalid,
): TreePickAction {
  const pickedEntry = entryOf.get(pick.uuid);
  if (pickedEntry?.subtype === "compact_boundary") {
    const boundaryIndex = entries.findIndex(
      (entry) => entry.uuid === pickedEntry.uuid,
    );
    const rewindTo = loadedContext(
      entries.slice(0, boundaryIndex),
      onInvalid,
    ).findLast((ref) => entryOf.get(ref.uuid)?.type === "assistant");
    return rewindTo === undefined
      ? { kind: "newRoot" }
      : { kind: "rewind", rewindTo };
  }
  if (
    pickedEntry?.isCompactSummary === true &&
    pickedEntry.parentUuid != null &&
    entryOf.get(pickedEntry.parentUuid)?.subtype === "compact_boundary"
  ) {
    const chain = summaryChainUuids(pickedEntry, entries, entryOf, onInvalid);
    if (chain !== undefined) {
      return { kind: "setChain", uuids: chain };
    }
  }
  const path = pathToLeaf(fullTree, entryOf, pick);
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
      return { kind: "rewind", rewindTo: ancestor.ref, ...editorTextField };
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
  /** Display-tree parent relation (layout ids), for
   *  nearest-visible-ancestor selection recovery when search hides the
   *  selected row. */
  private readonly parentMap: ParentMap;
  private readonly onSelect: (pick: TreeNodeRef) => void;
  private readonly onCancel: () => void;

  private searchQuery = "";
  private visibleRows: readonly FlatLayoutNode<SessionEntry>[] = [];
  private selectedIndex = 0;
  private lastSelectedId: string | null;
  private warning: string | undefined;

  constructor(
    leaf: TreeNodeRef | null,
    displayTree: DisplayTree,
    entryOf: ReadonlyMap<UUID, SessionEntry>,
    onSelect: (pick: TreeNodeRef) => void,
    onCancel: () => void,
  ) {
    super();
    const parentMap = displayTree.parentMap;
    this.roots = toLayoutTree(parentMap, (id) =>
      entryOf.get(parseTreeNodeRef(id).uuid)!,
    );
    // A hidden leaf occurrence marks its nearest visible row (a rootless
    // hidden chain → no marker, matching filtered-leaf behavior).
    const leafRow =
      leaf === null ? undefined : displayTree.nearestVisibleRow(leaf);
    this.currentLeafId =
      leafRow === undefined ? null : formatTreeNodeRef(leafRow);
    this.toolNames = collectToolNames([...entryOf.values()]);
    this.finalIds = collectFinalAssistantIds(
      parentMap,
      treeChildren(parentMap),
      entryOf,
    );
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.parentMap = parentMap;
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
      currentId = this.parentMap.get(currentId) ?? null;
    }
    return Math.min(
      this.selectedIndex,
      Math.max(0, this.visibleRows.length - 1),
    );
  }

  override render(width: number): string[] {
    const lines: string[] = [];
    const keybindings = getKeybindings();
    const confirmKey = keybindings.getKeys("tui.select.confirm")[0] ?? "enter";
    const cancelKey = keybindings.getKeys("tui.select.cancel")[0] ?? "escape";
    lines.push(
      theme.fg(
        "accent",
        `pick a tree entry (${confirmKey} to rewind, ${cancelKey} to cancel)`,
      ),
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
    // Command chords resolve through the global registry (tui.select.*);
    // search editing (backspace, printable input) is text editing and stays
    // on hard-coded keys.
    const keybindings = getKeybindings();
    const rowCount = this.visibleRows.length;
    if (keybindings.matches(data, "tui.select.up")) {
      if (rowCount > 0) {
        this.selectedIndex =
          this.selectedIndex === 0 ? rowCount - 1 : this.selectedIndex - 1;
      }
    } else if (keybindings.matches(data, "tui.select.down")) {
      if (rowCount > 0) {
        this.selectedIndex =
          this.selectedIndex === rowCount - 1 ? 0 : this.selectedIndex + 1;
      }
    } else if (keybindings.matches(data, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - MAX_VISIBLE_ROWS);
    } else if (keybindings.matches(data, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(
        Math.max(0, rowCount - 1),
        this.selectedIndex + MAX_VISIBLE_ROWS,
      );
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.visibleRows[this.selectedIndex];
      if (selected !== undefined) {
        // Layout ids ARE formatTreeNodeRef output, so the pick recovers the
        // occurrence directly — no parallel bookkeeping.
        this.onSelect(parseTreeNodeRef(selected.node.id));
      }
    } else if (keybindings.matches(data, "tui.select.cancel")) {
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
