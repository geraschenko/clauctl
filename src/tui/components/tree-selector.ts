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
import type { ContextTree } from "../../core/tree/context-tree.ts";
import type { DisplayTree } from "../../core/tree/display-tree.ts";
import {
  compactBoundaryOf,
  type CompactBoundary,
} from "../../core/tree/loader.ts";
import type { SessionEntry } from "../../core/session/file.ts";
import {
  formatTreeNodeRef,
  parseTreeNodeRef,
  type ParentMap,
  type TreeNodeRef,
  type TreeNodeStr,
} from "../../core/tree/nodes.ts";
import { treeChildren } from "../../core/tree/parent-map.ts";
import { dagLineText, type DagLine } from "../../format/dag-lines.ts";
import { extractTextContent } from "../../format/generated/text.ts";
import {
  collectFinalAssistantIds,
  collectToolNames,
  isHumanPrompt,
  passesFilter,
  treeLines,
} from "../../format/tree.ts";
import { theme } from "../theme.ts";

const MAX_VISIBLE_LINES = 15;

/** A pick is always a rewind: `rewindTo` names the occurrence whose
 *  context becomes the session's (null: the empty context); `editorText`
 *  prefills the editor. */
export interface TreePick {
  rewindTo: TreeNodeRef | null;
  editorText?: string;
}

/** The state right after `boundary` took effect — the last row of its
 *  block: up_to (anchor = summary) prefers the last preserved relinked row
 *  over the summary, the other shapes the summary over the last preserved
 *  row; null when neither is a context-tree occurrence (a wipe, or a
 *  rejected relink without a summary). */
function compactionTip(
  contextTree: ContextTree,
  boundary: CompactBoundary,
  summaryUuid: UUID | undefined,
): TreeNodeRef | null {
  const lastPreserved = boundary.preservedMessages.uuids.at(-1);
  const preservedTip: TreeNodeRef[] =
    lastPreserved === undefined
      ? []
      : [{ uuid: lastPreserved, viaBoundary: boundary.uuid }];
  const summaryTip: TreeNodeRef[] =
    summaryUuid === undefined ? [] : [{ uuid: summaryUuid }];
  const anchorIsSummary =
    boundary.preservedMessages.anchorUuid !== boundary.uuid;
  const candidates = anchorIsSummary
    ? [...preservedTip, ...summaryTip]
    : [...summaryTip, ...preservedTip];
  return (
    candidates.find((tip) =>
      contextTree.parentMap.has(formatTreeNodeRef(tip)),
    ) ?? null
  );
}

/**
 * What a picked row asks for, in context-tree terms.
 *  * Summary or boundary → the compaction stays in effect: its `compactionTip`
 *  * A human prompt (`isHumanPrompt`) → the state just before it, its
 *    context-tree parent (null at a root), with the prompt's text as
 *    editorText so it can be edited and re-sent
 *  * Anything else (assistant, non-human user entry, tool result, system or
 *    attachment entry) → itself, no editorText
 *
 * NOTE: For an "up_to" summary, the summary appears in the assistant's
 * context _before_ the preserved uuids. However, it's presented to the user
 * as appearing _after_ the preserved uuids. So if the user picks the
 * summary, their expectation is that the preserved uuids remain in context.
 */
export function resolveTreePick(
  contextTree: ContextTree,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
  pick: TreeNodeRef,
): TreePick {
  const picked = byUuid.get(pick.uuid);
  if (picked?.subtype === "compact_boundary") {
    const summary = [...byUuid.values()].find(
      (entry) =>
        entry.isCompactSummary === true && entry.parentUuid === pick.uuid,
    );
    return {
      rewindTo: compactionTip(
        contextTree,
        compactBoundaryOf(picked),
        summary?.uuid,
      ),
    };
  }
  const boundary =
    picked?.isCompactSummary === true && picked.parentUuid != null
      ? byUuid.get(picked.parentUuid)
      : undefined;
  if (boundary?.subtype === "compact_boundary") {
    return {
      rewindTo: compactionTip(
        contextTree,
        compactBoundaryOf(boundary),
        pick.uuid,
      ),
    };
  }
  if (picked === undefined || !isHumanPrompt(picked)) {
    return { rewindTo: pick };
  }
  const parent = contextTree.parentMap.get(formatTreeNodeRef(pick)) ?? null;
  return {
    rewindTo: parent === null ? null : parseTreeNodeRef(parent),
    editorText: extractTextContent(
      (picked.message as { content?: unknown }).content,
    ),
  };
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
  private lastSelectedId: TreeNodeStr | null;
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
  private nearestVisibleIndex(id: TreeNodeStr): number {
    const indexById = new Map<TreeNodeStr, number>();
    for (const [index, line] of this.lines.entries()) {
      if (line.rowId !== undefined) {
        indexById.set(line.rowId, index);
      }
    }
    let currentId: TreeNodeStr | null = id;
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
