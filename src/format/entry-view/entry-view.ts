/**
 * Entry views: the one classification of a session entry into a glyph
 * (glyphs.ts vocabulary), a one-line summary and an approximate size in
 * model-visible chars, shared by `format tree`, `/tree` and `format
 * entries` (docs/specs/entry-views.md). Composed from the piece views —
 * `ToolView` per tool_use block, `AttachmentView` per attachment payload.
 */

import { isRecord } from "../../core/generated/util.ts";
import { abnormalStopReason } from "../../core/session/entry-predicates.ts";
import {
  messageContent,
  queuedCommandPrompt,
  type SessionEntry,
} from "../../core/session/file.ts";
import {
  contentBlocks,
  extractTextContent,
} from "../../core/generated/text.ts";
import {
  ASSISTANT_GLYPH,
  ATTACHMENT_GLYPH,
  COMPACT_BOUNDARY_GLYPH,
  COMPACT_SUMMARY_GLYPH,
  OTHER_ENTRY_GLYPH,
  TOOL_CALL_GLYPH,
  TOOL_RESULT_ERROR_GLYPH,
  TOOL_RESULT_GLYPH,
  USER_BUT_NON_HUMAN_GLYPH,
  USER_GLYPH,
} from "../glyphs.ts";
import { toolViewFor } from "./tool-view/index.ts";
import { attachmentViewFor } from "./attachment-view/index.ts";
import { oneLinePrefix } from "../../core/generated/text.ts";
import { jsonLength, recordCharCount } from "./payload.ts";
import { PLAIN_STYLE } from "../style.ts";

export interface EntryView {
  readonly glyph: string;
  /** One line; `maxChars` is the sink's width — an upper bound on what it
   *  can show (the sink still truncates: it alone knows its columns). Text-
   *  bearing parts go through oneLinePrefix(text, maxChars). */
  summary(
    entry: SessionEntry,
    toolNames: ReadonlyMap<string, string>,
    maxChars: number,
  ): string;
  size(entry: SessionEntry): number;
}

function recordBlocks(entry: SessionEntry): Record<string, unknown>[] {
  return contentBlocks(messageContent(entry)).filter(isRecord);
}

function entryText(entry: SessionEntry): string {
  return extractTextContent(messageContent(entry));
}

/** Chars of the message's text: a string content, or its text blocks —
 *  summed, never joined. */
function messageTextLength(entry: SessionEntry): number {
  const content = messageContent(entry);
  if (typeof content === "string") {
    return content.length;
  }
  let length = 0;
  for (const block of contentBlocks(content)) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      length += block.text.length;
    }
  }
  return length;
}

export const compactBoundaryView: EntryView = {
  glyph: COMPACT_BOUNDARY_GLYPH,
  summary(entry) {
    const preTokens = isRecord(entry.compactMetadata)
      ? entry.compactMetadata.preTokens
      : undefined;
    return typeof preTokens === "number"
      ? `[compaction: ${Math.round(preTokens / 1000)}k tokens]`
      : "[compaction]";
  },
  size: () => 0,
};

export const compactSummaryView: EntryView = {
  glyph: COMPACT_SUMMARY_GLYPH,
  summary: (entry, _toolNames, maxChars) =>
    oneLinePrefix(entryText(entry), maxChars),
  size: messageTextLength,
};

export const promptView: EntryView = {
  glyph: USER_GLYPH,
  summary: (entry, _toolNames, maxChars) =>
    oneLinePrefix(queuedCommandPrompt(entry) ?? entryText(entry), maxChars),
  size: (entry) =>
    queuedCommandPrompt(entry)?.length ?? messageTextLength(entry),
};

/** The entry's type when the payload names none (a malformed entry). */
function attachmentType(entry: SessionEntry): string {
  return isRecord(entry.attachment) && typeof entry.attachment.type === "string"
    ? entry.attachment.type
    : "attachment";
}

export const attachmentEntryView: EntryView = {
  glyph: ATTACHMENT_GLYPH,
  summary(entry, _toolNames, maxChars) {
    const type = attachmentType(entry);
    const summary = attachmentViewFor(type).summary(entry.attachment, maxChars);
    return summary === "" ? type : `${type}: ${summary}`;
  },
  size: (entry) =>
    attachmentViewFor(attachmentType(entry)).size(entry.attachment),
};

export function toolResultBlocks(
  entry: SessionEntry,
): Record<string, unknown>[] {
  return recordBlocks(entry).filter((block) => block.type === "tool_result");
}

function toolResultSummary(
  entry: SessionEntry,
  toolNames: ReadonlyMap<string, string>,
): string {
  const results = toolResultBlocks(entry);
  const toolUseId = results[0]?.tool_use_id;
  const name =
    (typeof toolUseId === "string" ? toolNames.get(toolUseId) : undefined) ??
    "tool";
  const isError = results.some((block) => block.is_error === true);
  return `${name}: ${isError ? "error" : "ok"}`;
}

/** A result's content is a string or text blocks; anything else counts by
 *  its JSON. */
function toolResultSize(entry: SessionEntry): number {
  let size = 0;
  for (const block of toolResultBlocks(entry)) {
    const content = block.content;
    if (typeof content === "string") {
      size += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        size +=
          isRecord(part) && typeof part.text === "string"
            ? part.text.length
            : jsonLength(part);
      }
    } else {
      size += jsonLength(content);
    }
  }
  return size;
}

export const toolResultView: EntryView = {
  glyph: TOOL_RESULT_GLYPH,
  summary: toolResultSummary,
  size: toolResultSize,
};

export const toolResultErrorView: EntryView = {
  glyph: TOOL_RESULT_ERROR_GLYPH,
  summary: toolResultSummary,
  size: toolResultSize,
};

export const userTextView: EntryView = {
  glyph: USER_BUT_NON_HUMAN_GLYPH,
  summary: (entry, _toolNames, maxChars) =>
    oneLinePrefix(entryText(entry), maxChars),
  size: messageTextLength,
};

/** `[Name: description — arg]`, absent parts (and the `—`) omitted. */
function toolCallPart(
  block: Record<string, unknown>,
  cwd: string | undefined,
  maxChars: number,
): string {
  const name = typeof block.name === "string" ? block.name : "tool";
  const view = toolViewFor(name);
  const header = view.header(block.input, { cwd, style: PLAIN_STYLE });
  const parts = [header.description, header.arg]
    .filter((part): part is string => part !== undefined)
    .map((part) => oneLinePrefix(part, maxChars));
  const displayName = view.displayName ?? name;
  return parts.length === 0
    ? `[${displayName}]`
    : `[${displayName}: ${parts.join(" — ")}]`;
}

function assistantSummary(
  entry: SessionEntry,
  _toolNames: ReadonlyMap<string, string>,
  maxChars: number,
): string {
  const cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
  const parts: string[] = [];
  for (const block of recordBlocks(entry)) {
    if (block.type === "thinking") {
      const thought =
        typeof block.thinking === "string"
          ? oneLinePrefix(block.thinking, maxChars)
          : "";
      parts.push(thought === "" ? "[thinking]" : `[thinking] ${thought}`);
    } else if (block.type === "tool_use") {
      parts.push(toolCallPart(block, cwd, maxChars));
    }
  }
  const text = oneLinePrefix(entryText(entry), maxChars);
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

function assistantSize(entry: SessionEntry): number {
  const content = messageContent(entry);
  let size = typeof content === "string" ? content.length : 0;
  for (const block of recordBlocks(entry)) {
    if (block.type === "thinking" && typeof block.thinking === "string") {
      size += block.thinking.length;
    } else if (block.type === "text" && typeof block.text === "string") {
      size += block.text.length;
    } else if (block.type === "tool_use") {
      size += recordCharCount(block.input);
    }
  }
  return size;
}

export const assistantToolCallView: EntryView = {
  glyph: TOOL_CALL_GLYPH,
  summary: assistantSummary,
  size: assistantSize,
};

export const assistantView: EntryView = {
  glyph: ASSISTANT_GLYPH,
  summary: assistantSummary,
  size: assistantSize,
};

function stringField(entry: SessionEntry, key: string): string {
  const value = entry[key];
  return typeof value === "string" ? value : "";
}

/** The bookkeeping types' summaries; "" when the type has none (`system`
 *  entries read `system: <subtype>` through the generic fallback). */
function bookkeepingSummary(entry: SessionEntry): string {
  switch (entry.type) {
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
      return "";
  }
}

export const otherView: EntryView = {
  glyph: OTHER_ENTRY_GLYPH,
  summary(entry, _toolNames, maxChars) {
    const summary = bookkeepingSummary(entry);
    if (summary !== "") {
      return oneLinePrefix(summary, maxChars);
    }
    const type = entry.type ?? "unknown";
    return entry.subtype === undefined ? type : `${type}: ${entry.subtype}`;
  },
  size: () => 0,
};
