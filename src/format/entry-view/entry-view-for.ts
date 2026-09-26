/** The entry-view registry: classification of a session entry to its view. */

import { contentBlocks, hasContentBlock } from "../../core/generated/text.ts";
import { isRecord } from "../../core/generated/util.ts";
import {
  hasText,
  isPromptEntry,
  toolResultOnly,
} from "../../core/session/entry-predicates.ts";
import { messageContent, type SessionEntry } from "../../core/session/file.ts";
import { renderAttachmentEntry } from "../api-messages/render-attachment.ts";
import {
  assistantThinkingOnlyView,
  assistantToolCallView,
  assistantView,
  attachmentEntryView,
  attachmentSilentView,
  compactBoundaryView,
  compactSummaryView,
  type EntryView,
  otherView,
  promptView,
  toolResultBlocks,
  toolResultErrorView,
  toolResultView,
  userTextView,
} from "./entry-view.ts";

/** The one classification chain, first match wins: compact boundary →
 *  compact summary → prompt (human `user` text or `queued_command`) →
 *  attachment (`·` when the CLI renders it to nothing) → tool_result-only
 *  user (error glyph when any is_error) → user with text → assistant
 *  (tool-call glyph when a tool_use block, `·` when all thinking) →
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
    return renderAttachmentEntry(entry) === undefined
      ? attachmentSilentView
      : attachmentEntryView;
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
    const content = messageContent(entry);
    if (hasContentBlock(content, "tool_use")) {
      return assistantToolCallView;
    }
    const blocks = contentBlocks(content);
    return blocks.length > 0 &&
      blocks.every(
        (block) =>
          isRecord(block) &&
          (block.type === "thinking" || block.type === "redacted_thinking"),
      )
      ? assistantThinkingOnlyView
      : assistantView;
  }
  return otherView;
}
