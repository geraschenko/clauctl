/**
 * The `/tree` picker: the session tree rendered exactly as `clauctl format
 * tree --filter picker` renders it (shared treeLines, uuids omitted), with
 * pi-style search and navigation over the row lines. Pick semantics
 * (resolveTreePick) live here too; interactive-mode owns the busy gate and
 * the set-context request.
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
  formatTreeNodeRef,
  parseTreeNodeRef,
  pathToLeaf,
  type ParentMap,
  type TreeNodeRef,
} from "../../core/tree/nodes.ts";
import { treeChildren } from "../../core/tree/parent-map.ts";
import { dagLineText, type DagLine } from "../../format/dag-lines.ts";
import { extractTextContent } from "../../format/generated/text.ts";
import {
  collectFinalAssistantIds,
  collectToolNames,
  passesFilter,
  treeLines,
} from "../../format/tree.ts";
import { theme } from "../theme.ts";

const MAX_VISIBLE_LINES = 15;

export type TreePickAction =
  | { kind: "rewind"; rewindTo: TreeNodeRef; editorText?: string }
  | { kind: "setChain"; uuids: UUID[] }
  | { kind: "newRoot"; editorText?: string };

/** The fresh-compaction context a summary pick re-installs: the loader's
 *  view of the file truncated just after the summary — the summary plus
 *  its boundary's preserved chain, before any post-compaction turns.
 *  Undefined when the summary is not on that chain (corrupt or
 *  hand-crafted file). */
function summaryChainUuids(
  summary: SessionEntry,
  entries: SessionEntry[],
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
  return chain.includes(summary.uuid!) ? chain : undefined;
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
 * exotic interrupt shapes, where normalization completes or rejects the
 * list. An empty user text (reachable via the
 * current-leaf filter exemption) omits editorText. A malformed summary
 * (parent not a boundary, or off its boundary's chain — corrupt or
 * hand-crafted file) falls back to ordinary user-row pick semantics.
 */
export function resolveTreePick(
  fullTree: ParentMap,
  entries: SessionEntry[],
  byUuid: ReadonlyMap<UUID, SessionEntry>,
  pick: TreeNodeRef,
  onInvalid: OnInvalid,
): TreePickAction {
  const pickedEntry = byUuid.get(pick.uuid);
  if (pickedEntry?.subtype === "compact_boundary") {
    const boundaryIndex = entries.findIndex(
      (entry) => entry.uuid === pickedEntry.uuid,
    );
    const rewindTo = loadedContext(
      entries.slice(0, boundaryIndex),
      onInvalid,
    ).findLast((ref) => byUuid.get(ref.uuid)?.type === "assistant");
    return rewindTo === undefined
      ? { kind: "newRoot" }
      : { kind: "rewind", rewindTo };
  }
  if (
    pickedEntry?.isCompactSummary === true &&
    pickedEntry.parentUuid != null &&
    byUuid.get(pickedEntry.parentUuid)?.subtype === "compact_boundary"
  ) {
    // Not the user-row semantics below: a user pick rewinds to the previous
    // assistant and prefills the editor, but a summary is a user entry only
    // from Claude's perspective — backing up past it would undo the
    // compaction, which is not what picking the summary means.
    const chain = summaryChainUuids(pickedEntry, entries, onInvalid);
    if (chain !== undefined) {
      return { kind: "setChain", uuids: chain };
    }
  }
  const path = pathToLeaf(fullTree, byUuid, pick);
  const entryAt = (index: number): SessionEntry | undefined => {
    const ref = path.at(index);
    return ref === undefined ? undefined : byUuid.get(ref.uuid);
  };
  const picked = entryAt(-1);
  if (picked?.type === "assistant") {
    return { kind: "rewind", rewindTo: pick };
  }
  const pickedContent =
    picked?.type === "user" &&
    typeof picked.message === "object" &&
    picked.message !== null
      ? (picked.message as { content?: unknown }).content
      : undefined;
  const editorText = extractTextContent(pickedContent);
  const editorTextField = editorText === "" ? {} : { editorText };
  for (let index = path.length - 2; index >= 0; index -= 1) {
    if (entryAt(index)?.type === "assistant") {
      return { kind: "rewind", rewindTo: path[index]!, ...editorTextField };
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

  /** The whole picker-filtered tree, rendered once. */
  private readonly treeLines: readonly DagLine[];
  /** Display-tree parent relation (layout ids), for
   *  nearest-visible-ancestor selection recovery when search hides the
   *  selected row. */
  private readonly parentMap: ParentMap;
  private readonly onSelect: (pick: TreeNodeRef) => void;
  private readonly onCancel: () => void;

  private searchQuery = "";
  /** What is shown: treeLines, or the search matches (row lines only,
   *  drawn without connectors). */
  private lines: readonly DagLine[] = [];
  /** Index into `lines`; always a line with a rowId when any exists. */
  private selectedLine = 0;
  private lastSelectedId: string | null;
  private warning: string | undefined;

  constructor(
    leaf: TreeNodeRef | null,
    displayTree: DisplayTree,
    byUuid: ReadonlyMap<UUID, SessionEntry>,
    onSelect: (pick: TreeNodeRef) => void,
    onCancel: () => void,
  ) {
    super();
    const parentMap = displayTree.parentMap;
    // A hidden leaf occurrence's row is its nearest visible row (a rootless
    // hidden chain → no active chain, matching filtered-leaf behavior).
    const leafRow =
      leaf === null ? undefined : displayTree.nearestVisibleRow(leaf);
    const currentLeafId =
      leafRow === undefined ? null : formatTreeNodeRef(leafRow);
    const finalIds = collectFinalAssistantIds(
      parentMap,
      treeChildren(parentMap),
      byUuid,
    );
    this.treeLines = treeLines(
      parentMap,
      byUuid,
      currentLeafId,
      (id, entry) =>
        passesFilter(entry, id === currentLeafId, finalIds.has(id), "picker"),
      collectToolNames([...byUuid.values()]),
      true,
    );
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.parentMap = parentMap;
    this.lastSelectedId = currentLeafId;
    this.applyFilter();
  }

  /** Persistent warning line for contextChanged-while-open. */
  setWarning(text: string): void {
    this.warning = text;
  }

  /**
   * Recompute the shown lines: the rendered tree when the query is empty,
   * else the row lines whose label contains every search token. The
   * current-leaf exemption is part of the picker filter only — a search
   * that doesn't match the leaf hides it (pi parity).
   */
  private applyFilter(): void {
    const selected = this.lines[this.selectedLine];
    if (selected?.rowId !== undefined) {
      this.lastSelectedId = selected.rowId;
    }
    const tokens = this.searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token !== "");
    this.lines =
      tokens.length === 0
        ? this.treeLines
        : this.treeLines.filter((line) => {
            if (line.rowId === undefined) {
              return false;
            }
            const label = line.label.toLowerCase();
            return tokens.every((token) => label.includes(token));
          });
    this.selectedLine =
      this.lastSelectedId === null
        ? this.nearestSelectableLine(0, 1)
        : this.nearestVisibleIndex(this.lastSelectedId);
  }

  /** The line of `id` if shown, else its nearest shown ancestor, else a
   *  clamp of the previous selection (snapped to a selectable line). */
  private nearestVisibleIndex(id: string): number {
    const indexById = new Map<string, number>();
    for (const [index, line] of this.lines.entries()) {
      if (line.rowId !== undefined) {
        indexById.set(line.rowId, index);
      }
    }
    let currentId: string | null = id;
    while (currentId !== null) {
      const index = indexById.get(currentId);
      if (index !== undefined) {
        return index;
      }
      currentId = this.parentMap.get(currentId) ?? null;
    }
    return this.nearestSelectableLine(this.selectedLine, -1);
  }

  /** The nearest line with a rowId at or beyond `from` (clamped into
   *  range) in `direction` (+1/-1), falling back to the other direction;
   *  the clamped `from` when there is none at all. */
  private nearestSelectableLine(from: number, direction: 1 | -1): number {
    const start = Math.max(0, Math.min(from, this.lines.length - 1));
    for (const step of [direction, -direction]) {
      for (
        let index = start;
        index >= 0 && index < this.lines.length;
        index += step
      ) {
        if (this.lines[index]!.rowId !== undefined) {
          return index;
        }
      }
    }
    return start;
  }

  private lineText(line: DagLine, width: number): string {
    const dimGlyph = line.rowId?.includes("@") === true;
    if (this.searchQuery === "") {
      const text = dagLineText(line, width);
      return dimGlyph
        ? text.replace(line.glyph, theme.fg("dim", line.glyph))
        : text;
    }
    // Search view: a flat list, no connectors.
    const glyph = dimGlyph ? theme.fg("dim", line.glyph) : line.glyph;
    return `${glyph} ${dagLineText({ ...line, prefix: "", glyph: "", suffix: "" }, Math.max(0, width - 2))}`;
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
    if (this.lines.length === 0) {
      lines.push(theme.fg("dim", "(no matching entries)"));
    } else {
      const start = Math.max(
        0,
        Math.min(
          this.selectedLine - Math.floor(MAX_VISIBLE_LINES / 2),
          this.lines.length - MAX_VISIBLE_LINES,
        ),
      );
      const end = Math.min(start + MAX_VISIBLE_LINES, this.lines.length);
      for (let index = start; index < end; index += 1) {
        const line = this.lineText(this.lines[index]!, width);
        lines.push(index === this.selectedLine ? theme.inverse(line) : line);
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
    if (keybindings.matches(data, "tui.select.up")) {
      this.selectedLine = this.nearestSelectableLine(this.selectedLine - 1, -1);
    } else if (keybindings.matches(data, "tui.select.down")) {
      this.selectedLine = this.nearestSelectableLine(this.selectedLine + 1, 1);
    } else if (keybindings.matches(data, "tui.select.pageUp")) {
      this.selectedLine = this.nearestSelectableLine(
        this.selectedLine - MAX_VISIBLE_LINES,
        -1,
      );
    } else if (keybindings.matches(data, "tui.select.pageDown")) {
      this.selectedLine = this.nearestSelectableLine(
        this.selectedLine + MAX_VISIBLE_LINES,
        1,
      );
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      const rowId = this.lines[this.selectedLine]?.rowId;
      if (rowId !== undefined) {
        // Row ids ARE formatTreeNodeRef output, so the pick recovers the
        // occurrence directly — no parallel bookkeeping.
        this.onSelect(parseTreeNodeRef(rowId));
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
