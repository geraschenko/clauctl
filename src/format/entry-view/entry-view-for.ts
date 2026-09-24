/** The entry-view registry: classification of a session entry to its view. */

import { hasContentBlock } from "../../core/generated/text.ts";
import {
  hasText,
  isPromptEntry,
  toolResultOnly,
} from "../../core/session/entry-predicates.ts";
import { messageContent, type SessionEntry } from "../../core/session/file.ts";
import {
  assistantToolCallView,
  assistantView,
  attachmentEntryView,
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
