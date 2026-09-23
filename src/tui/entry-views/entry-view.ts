// TDC: It doesn't seem like entry-view belongs in this barrel. All the other files in this directory are about attachment view, so the directory should be called attachment-view, not entry-view. If there are entry-view-specific things we want to keep isolated (maybe payload.ts?), perhaps entry-view should be its own barrel which contains tool-view and attachment-view as nested barrels.
/**
 * Entry views: the one classification of a session entry into a glyph
 * (glyphs.ts vocabulary), a one-line summary and an approximate size in
 * model-visible chars, shared by `format tree`, `/tree` and `format
 * entries` (docs/specs/entry-views.md). Composed from the piece views —
 * `ToolView` per tool_use block, `AttachmentView` per attachment payload.
 * Also home of the entry predicates the tree filters share with the
 * classification (`isHumanPrompt`, `isPromptEntry`) and the tool_use id →
 * name bookkeeping that names tool results.
 */

import { isRecord } from "../../core/generated/util.ts";
import {
  queuedCommandPrompt,
  type SessionEntry,
} from "../../core/session/file.ts";
import {
  contentBlocks,
  extractTextContent,
  hasContentBlock,
} from "../../format/generated/text.ts";
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
import { toolViewFor } from "../tool-views/tool-view.ts";
import { attachmentViewFor } from "./attachment-view.ts";
import { oneLinePrefix } from "../../format/generated/text.ts";
import { jsonLength, recordCharCount } from "./payload.ts";

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

export function messageContent(entry: SessionEntry): unknown {
  return isRecord(entry.message) ? entry.message.content : undefined;
}

function recordBlocks(entry: SessionEntry): Record<string, unknown>[] {
  return contentBlocks(messageContent(entry)).filter(isRecord);
}

export function hasText(entry: SessionEntry): boolean {
  return extractTextContent(messageContent(entry)).trim() !== "";
}

/** The stop_reason when it signals an abnormal end: present and neither of
 *  the two ordinary values. Aborted/errored turns are kept visible by the
 *  filters through this. */
export function abnormalStopReason(entry: SessionEntry): string | undefined {
  const stopReason = isRecord(entry.message)
    ? entry.message.stop_reason
    : undefined;
  return typeof stopReason === "string" &&
    stopReason !== "end_turn" &&
    stopReason !== "tool_use"
    ? stopReason
    : undefined;
}

export function toolResultOnly(entry: SessionEntry): boolean {
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
export function isPromptEntry(entry: SessionEntry): boolean {
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

/** Streaming counterpart of collectToolNames: records this entry's
 *  tool_use ids. The map is kept for the whole stream. */
// TDC: completely wrong place for this function.
export function trackToolNames(
  entry: SessionEntry,
  toolNames: Map<string, string>,
): void {
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

/** tool_use id → name over ALL entries (visible or not), so tool_result
 *  lines can name their tool after filtering hides the call. A flat scan —
 *  needs no tree. */
// TDC: Use of this function should be considered a red flag, so I'd prefer to not have it at all.
export function collectToolNames(
  entries: readonly SessionEntry[],
): Map<string, string> {
  const toolNames = new Map<string, string>();
  for (const entry of entries) {
    trackToolNames(entry, toolNames);
  }
  return toolNames;
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

const compactBoundaryView: EntryView = {
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

const compactSummaryView: EntryView = {
  glyph: COMPACT_SUMMARY_GLYPH,
  summary: (entry, _toolNames, maxChars) =>
    oneLinePrefix(entryText(entry), maxChars),
  size: messageTextLength,
};

const promptView: EntryView = {
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

const attachmentEntryView: EntryView = {
  glyph: ATTACHMENT_GLYPH,
  summary(entry, _toolNames, maxChars) {
    const type = attachmentType(entry);
    const summary = attachmentViewFor(type).summary(entry.attachment, maxChars);
    return summary === "" ? type : `${type}: ${summary}`;
  },
  size: (entry) =>
    attachmentViewFor(attachmentType(entry)).size(entry.attachment),
};

function toolResultBlocks(entry: SessionEntry): Record<string, unknown>[] {
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

const toolResultView: EntryView = {
  glyph: TOOL_RESULT_GLYPH,
  summary: toolResultSummary,
  size: toolResultSize,
};

const toolResultErrorView: EntryView = {
  glyph: TOOL_RESULT_ERROR_GLYPH,
  summary: toolResultSummary,
  size: toolResultSize,
};

const userTextView: EntryView = {
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
  const header = view.header(block.input, cwd);
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

const assistantToolCallView: EntryView = {
  glyph: TOOL_CALL_GLYPH,
  summary: assistantSummary,
  size: assistantSize,
};

const assistantView: EntryView = {
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

const otherView: EntryView = {
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

/** The one classification chain, first match wins: compact boundary →
 *  compact summary → prompt (human `user` text or `queued_command`) →
 *  attachment → tool_result-only user (error glyph when any is_error) →
 *  user with text → assistant (tool-call glyph when a tool_use block) →
 *  other. */
export function entryViewFor(entry: SessionEntry): EntryView {
  if (entry.subtype === "compact_boundary") {
    return compactBoundaryView;
  }
  if (entry.isCompactSummary === true) {
    return compactSummaryView;
  }
  if (isPromptEntry(entry)) {
    return promptView;
  }
  if (entry.type === "attachment") {
    return attachmentEntryView;
  }
  if (entry.type === "user") {
    if (toolResultOnly(entry)) {
      return toolResultBlocks(entry).some((block) => block.is_error === true)
        ? toolResultErrorView
        : toolResultView;
    }
    if (hasText(entry)) {
      return userTextView;
    }
  }
  if (entry.type === "assistant") {
    return hasContentBlock(messageContent(entry), "tool_use")
      ? assistantToolCallView
      : assistantView;
  }
  return otherView;
}

// TDC: yeah, this file is definitely big enough and there are enough sort-of-related-but-pretty-distinct responsibilities in it that we should make it a barrel. That way it presents a clearer interface to its clients.
