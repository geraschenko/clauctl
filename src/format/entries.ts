/**
 * `format entries`: one summary line per canonical session entry — uuid
 * column (the displayUuid seam), type, one-line summary. Stateless per line;
 * canonicalization happens upstream. Known bookkeeping types get concise
 * summaries; unknown types degrade to a generic summary rather than
 * disappearing.
 */

import { isRecord } from "../core/generated/util.ts";
import type { SessionEntry } from "../core/session/file.ts";
import { contentBlocks, oneLine, truncateText } from "./generated/text.ts";
import { displayUuid } from "../core/uuid.ts";
import { DEFAULT_FORMAT_WIDTH } from "../core/generated/constants.ts";

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

/** Full-uuid width; blank-padded for uuid-less entries so columns align. */
const UUID_COLUMN_WIDTH = 36;
/** The longest common short types; long bookkeeping names overflow. */
const TYPE_COLUMN_WIDTH = 10;
/** ISO-8601 with milliseconds and Z, as both writers stamp it. */
const TIMESTAMP_COLUMN_WIDTH = 24;
/** Never truncate a summary below something recognizable, however deep the
 *  prefix columns cut into a narrow width. */
const MIN_SUMMARY_CHARS = 16;

function contentBlockMarker(block: unknown): string {
  if (!isRecord(block)) {
    return "[content]";
  }
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "[text]";
    case "thinking":
      return "[thinking]";
    case "tool_use":
      return `[tool:${typeof block.name === "string" ? block.name : "unknown"}]`;
    case "tool_result":
      return "[tool_result]";
    case "image":
      return "[image]";
    default:
      return `[${typeof block.type === "string" ? block.type : "content"}]`;
  }
}

function messageSummary(entry: SessionEntry): string {
  const message = isRecord(entry.message) ? entry.message : undefined;
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  return contentBlocks(content).map(contentBlockMarker).join(" ");
}

function stringField(entry: SessionEntry, key: string): string {
  const value = entry[key];
  return typeof value === "string" ? value : "";
}

function entrySummary(entry: SessionEntry): string {
  switch (entry.type) {
    case "user":
    case "assistant":
      return messageSummary(entry);
    case "system":
      return stringField(entry, "subtype");
    case "permission-mode":
      return stringField(entry, "permissionMode");
    case "mode":
      return stringField(entry, "mode");
    case "ai-title":
      return stringField(entry, "aiTitle");
    case "custom-title":
      return stringField(entry, "customTitle");
    case "last-prompt":
      return stringField(entry, "lastPrompt");
    case "queue-operation": {
      const operation = stringField(entry, "operation");
      return operation === "enqueue" && typeof entry.content === "string"
        ? `enqueue: ${entry.content}`
        : operation;
    }
    case "attachment":
      return isRecord(entry.attachment) &&
        typeof entry.attachment.type === "string"
        ? entry.attachment.type
        : "";
    case "file-history-snapshot": {
      const backups =
        isRecord(entry.snapshot) && isRecord(entry.snapshot.trackedFileBackups)
          ? Object.keys(entry.snapshot.trackedFileBackups).length
          : 0;
      return `${backups} tracked file backup${backups === 1 ? "" : "s"}`;
    }
    case "file-history-delta":
      return stringField(entry, "trackingPath");
    default:
      return JSON.stringify(entry) ?? "";
  }
}

/** One line: `<displayUuid(uuid) | blank-padded> <type> <summary>`, without
 *  a trailing newline. */
export function formatEntryLine(
  entry: SessionEntry,
  options: EntryFormatOptions,
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
  const budget = Math.max(options.width - head.length, MIN_SUMMARY_CHARS);
  const summary = truncateText(oneLine(entrySummary(entry)), budget);
  const line = `${head}${summary}`.trimEnd();
  return options.full ? `${line} ${JSON.stringify(entry)}` : line;
}
