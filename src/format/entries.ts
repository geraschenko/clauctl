/**
 * `format entries`: one summary line per canonical session entry — uuid
 * column (the displayUuid seam), type, the entry view's one-line summary,
 * and its size right-aligned at the width. Stateless per line except for
 * the caller-owned tool-name map that lets a tool_result name its tool;
 * canonicalization happens upstream.
 */

import type { SessionEntry } from "../core/session/file.ts";
import {
  formatSize,
  padEndCodePoints,
  truncateText,
} from "../core/generated/text.ts";
import { displayUuid } from "../core/uuid.ts";
import { DEFAULT_FORMAT_WIDTH } from "../core/generated/constants.ts";
import { entryViewFor } from "./entry-view/index.ts";

export type EntryFormatOptions = Readonly<{
  /** Prefix each line with the entry timestamp. */
  timestamps: boolean;
  /** Append the raw entry JSON after the summary. */
  full: boolean;
  /** Line width budget; the summary is truncated to fit. */
  width: number;
}>;

/** The defaults `format entries` applies for omitted flags, and what tail
 *  renders with — shared so the two cannot diverge. */
export const DEFAULT_ENTRY_FORMAT_OPTIONS: EntryFormatOptions = {
  timestamps: false,
  full: false,
  width: DEFAULT_FORMAT_WIDTH,
};

/** displayUuid width; blank-padded for uuid-less entries so columns align. */
const UUID_COLUMN_WIDTH = 8;
/** The longest common short types; long bookkeeping names overflow. */
const TYPE_COLUMN_WIDTH = 10;
/** ISO-8601 with milliseconds and Z, as both writers stamp it. */
const TIMESTAMP_COLUMN_WIDTH = 24;
/** Never truncate a summary below something recognizable, however deep the
 *  prefix columns cut into a narrow width. */
const MIN_SUMMARY_CHARS = 16;

function stringField(entry: SessionEntry, key: string): string {
  const value = entry[key];
  return typeof value === "string" ? value : "";
}

/** One line: `<displayUuid(uuid) | blank-padded> <type> <summary> <size>`,
 *  the size right-aligned at `options.width` (the line overflows rather
 *  than shrink the summary below MIN_SUMMARY_CHARS; a 0 size shows no
 *  column at all), without a trailing newline. `toolNames` is the stream's
 *  tool_use id → name map so far (trackToolNames). */
export function formatEntryLine(
  entry: SessionEntry,
  options: EntryFormatOptions,
  toolNames: ReadonlyMap<string, string>,
): string {
  const columns: string[] = [];
  if (options.timestamps) {
    columns.push(
      stringField(entry, "timestamp").padEnd(TIMESTAMP_COLUMN_WIDTH),
    );
  }
  columns.push(
    typeof entry.uuid === "string"
      ? displayUuid(entry.uuid).padEnd(UUID_COLUMN_WIDTH)
      : " ".repeat(UUID_COLUMN_WIDTH),
  );
  const type = typeof entry.type === "string" ? entry.type : "unknown";
  columns.push(type.padEnd(TYPE_COLUMN_WIDTH));
  const head = `${columns.join(" ")} `;
  const view = entryViewFor(entry);
  const size = view.size(entry);
  const sizeColumn = size === 0 ? "" : ` ${formatSize(size)}`;
  const bodyWidth = options.width - sizeColumn.length;
  const summary = truncateText(
    view.summary(entry, toolNames, options.width),
    Math.max(bodyWidth - head.length, MIN_SUMMARY_CHARS),
  );
  const body = `${head}${summary}`.trimEnd();
  const line =
    sizeColumn === ""
      ? body
      : `${padEndCodePoints(body, bodyWidth)}${sizeColumn}`;
  return options.full ? `${line} ${JSON.stringify(entry)}` : line;
}
