/**
 * Generic DAG-to-lines layer over `@geraschenko/renderdag`: a chronological
 * row list with a distinguished active chain becomes git-log-style text
 * lines, time flowing down. Imports nothing clauctl-specific (only renderdag
 * and the pictl-shared text helpers) so pictl can adopt it.
 */

import {
  Ancestor,
  isRepeatable,
  pipeline,
  type PrefixLine,
} from "@geraschenko/renderdag";
import {
  formatSize,
  padEndCodePoints,
  truncateText,
} from "./generated/text.ts";

export interface DagRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly glyph: string;
  readonly label: string;
  /** Right-aligned char count (formatSize); undefined or 0 shows none. */
  readonly size: number | undefined;
}

/** One output line. `rowId` is set on the line carrying a row's glyph and
 *  label; undefined on connector/separator lines (filler), whose whole
 *  text is `prefix`. The glyph is split out so a sink can style it (the
 *  TUI dims it on relinked rows). */
export interface DagLine {
  readonly rowId: string | undefined;
  /** Graph columns before the glyph. */
  readonly prefix: string;
  /** "" on filler lines. */
  readonly glyph: string;
  /** Graph columns after the glyph, through the trailing space; "" on
   *  filler lines. */
  readonly suffix: string;
  /** "" on filler lines. */
  readonly label: string;
  /** undefined on filler lines. */
  readonly size: number | undefined;
}

/** A column holder that is never fed as a node, so renderdag keeps its
 *  column blank for the rest of the graph. "\0" cannot occur in a row id. */
const RESERVED_COLUMN_ID = "\0reserved";

function fillerLine(prefix: string): DagLine {
  return {
    rowId: undefined,
    prefix,
    glyph: "",
    suffix: "",
    label: "",
    size: undefined,
  };
}

function prefixLineText(line: PrefixLine, glyph: string): string {
  return line.parts
    .map((part) => (part.type === "text" ? part.text : glyph))
    .join("");
}

/** The row's own line: graph text split around the node glyph slot; the
 *  suffix keeps renderdag's single separating space before the message. */
function rowLine(line: PrefixLine, row: DagRow): DagLine {
  const glyphIndex = line.parts.findIndex((part) => part.type === "nodeGlyph");
  const textOf = (parts: readonly PrefixLine["parts"][number][]): string =>
    parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  return {
    rowId: row.id,
    prefix: textOf(line.parts.slice(0, glyphIndex)),
    glyph: row.glyph,
    suffix: `${textOf(line.parts.slice(glyphIndex + 1))} `,
    label: row.label,
    size: row.size,
  };
}

/** Lines in row order. Preconditions (throw otherwise): every row's
 *  parent precedes it; `leafId`, when non-null, is a row id. The active
 *  chain is `leafId` and its ancestors; its root is `reserve`d before any
 *  row is fed, so it takes column 0 even when an earlier root exists;
 *  among a row's children, the one on the chain is fed first, so renderdag
 *  keeps it in the parent's column; the chain's last member (`leafId`) is
 *  fed with an anonymous ancestor ahead of its children when it has any,
 *  and a never-fed sentinel column is reserved right after its row, so
 *  column 0 stays empty below it. The 'node' prefix line becomes the row's
 *  line, every other non-repeatable prefix line a filler line. */
export function renderDagLines(
  rows: readonly DagRow[],
  leafId: string | null,
): DagLine[] {
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parentId !== null) {
      if (!parentOf.has(row.parentId)) {
        throw new Error(
          `renderDagLines: row ${row.id} precedes its parent ${row.parentId}`,
        );
      }
      const siblings = childrenOf.get(row.parentId);
      if (siblings === undefined) {
        childrenOf.set(row.parentId, [row.id]);
      } else {
        siblings.push(row.id);
      }
    }
    parentOf.set(row.id, row.parentId);
  }
  if (leafId !== null && !parentOf.has(leafId)) {
    throw new Error(`renderDagLines: leaf ${leafId} is not a row`);
  }

  const shaper = new pipeline.GraphRowShaper<string>();
  shaper.optionsMut().minRowHeight = 1;
  const boxDrawing = new pipeline.BoxDrawing();
  const activeChainIds = new Set<string>();
  if (leafId !== null) {
    let activeRoot = leafId;
    activeChainIds.add(activeRoot);
    for (
      let parent = parentOf.get(activeRoot);
      parent !== null && parent !== undefined;
      parent = parentOf.get(activeRoot)
    ) {
      activeChainIds.add(parent);
      activeRoot = parent;
    }
    shaper.reserve(activeRoot);
  }

  // Mirrors renderdag's PrefixLinesToText for one-line messages: a blank
  // separator only between two consecutive one-line rows, repeatable
  // (padding) lines dropped, except that a row with a terminator line
  // keeps one padding line under it so the terminated column reads as
  // ended before the next row. renderdag queues that pad line and flushes
  // it at the next row; emitting it immediately is the same text except
  // after the last row, which can never carry a terminator here (only the
  // leaf gets one, and only when children follow it).
  const lines: DagLine[] = [];
  let previousRowLineCount = 0;
  for (const row of rows) {
    // renderdag's arrows point from a node to its "parents", which it
    // draws below the node; with time flowing down, a row's CHILDREN are
    // what it must be linked to, so they are passed as Ancestor.parent.
    const rowChildren = childrenOf.get(row.id) ?? [];
    const children = [
      ...rowChildren.filter((child) => activeChainIds.has(child)),
      ...rowChildren.filter((child) => !activeChainIds.has(child)),
    ].map((child) => Ancestor.parent(child));
    if (row.id === leafId && children.length > 0) {
      children.unshift(Ancestor.anonymous<string>());
    }
    const shape = shaper.nextRowShape(row.id, children);
    const prefixLines = boxDrawing.nextPrefixLines(shape);
    const rowLines: DagLine[] = [];
    if (shape.separatorLine && previousRowLineCount === 1) {
      rowLines.push(fillerLine(""));
    }
    let repeatableLine: PrefixLine | undefined;
    let hasTermLine = false;
    for (const prefixLine of prefixLines) {
      if (isRepeatable(prefixLine.kind)) {
        repeatableLine = prefixLine;
      } else if (prefixLine.kind === "node") {
        rowLines.push(rowLine(prefixLine, row));
      } else {
        hasTermLine = hasTermLine || prefixLine.kind === "term";
        rowLines.push(fillerLine(prefixLineText(prefixLine, row.glyph)));
      }
    }
    if (hasTermLine && repeatableLine !== undefined) {
      rowLines.push(fillerLine(prefixLineText(repeatableLine, row.glyph)));
    }
    lines.push(...rowLines);
    previousRowLineCount = rowLines.length;
    if (row.id === leafId) {
      shaper.reserve(RESERVED_COLUMN_ID);
    }
  }
  return lines;
}

/** prefix + glyph + suffix + label truncated to `width` (truncateText),
 *  trailing whitespace trimmed; with a non-zero size, the text is truncated
 *  to `width - sizeText.length - 1` and the size right-aligned at `width`
 *  (the size survives any width: once no text column remains it stands
 *  alone). A 0 size shows nothing. */
export function dagLineText(line: DagLine, width: number): string {
  const text = `${line.prefix}${line.glyph}${line.suffix}${line.label}`;
  if (line.size === undefined || line.size === 0) {
    return truncateText(text, width).trimEnd();
  }
  const sizeText = formatSize(line.size);
  const textWidth = width - sizeText.length - 1;
  if (textWidth <= 0) {
    return sizeText.padStart(width);
  }
  const label = truncateText(text, textWidth).trimEnd();
  return `${padEndCodePoints(label, textWidth)} ${sizeText}`;
}
