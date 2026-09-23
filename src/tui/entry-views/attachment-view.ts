// TDC: it looks like there should be an attachment-view barrel, since nothing but this file is supposed to import any of the individual attachment views. I _think_ the only things this barrel should expose are AttachmentView and attachmentViewFor. Is that correct?
/**
 * Piece views for attachment payloads (`entry.attachment` of an
 * `attachment` entry): the one-line summary shown after `<type>: ` in the
 * tree and `format entries`, and the payload's approximate model-visible
 * size in chars (see docs/specs/entry-views.md). Payload shapes are the
 * CLI's and untrusted; every view reads its fields defensively and falls
 * back rather than throwing. Unknown types take `defaultAttachmentView`.
 */

import { dateChangeView } from "./date-change.ts";
import { deferredToolsDeltaView } from "./deferred-tools-delta.ts";
import { fileView } from "./file.ts";
import { hookSuccessView } from "./hook-success.ts";
import { oneLinePrefix } from "../../format/generated/text.ts";
import { recordCharCount, stringField } from "./payload.ts";
import { skillListingView } from "./skill-listing.ts";
import { todoReminderView } from "./todo-reminder.ts";
import { totalTokensReminderView } from "./total-tokens-reminder.ts";

export interface AttachmentView<P> {
  /** Text after `<type>: `; at most maxChars + 1 chars (see oneLinePrefix). */
  summary(payload: P, maxChars: number): string;
  size(payload: P): number;
}

/** first string among `text`, `content`, else the payload JSON. */
export const defaultAttachmentView: AttachmentView<unknown> = {
  summary(payload, maxChars) {
    const text =
      stringField(payload, "text") ??
      stringField(payload, "content") ??
      JSON.stringify(payload) ??
      "";
    return oneLinePrefix(text, maxChars);
  },
  size: recordCharCount,
};

export const attachmentViews: Readonly<
  Record<string, AttachmentView<unknown>>
> = {
  total_tokens_reminder: totalTokensReminderView,
  todo_reminder: todoReminderView,
  task_reminder: todoReminderView,
  file: fileView,
  edited_text_file: fileView,
  compact_file_reference: fileView,
  nested_memory: fileView,
  already_read_file: fileView,
  directory: fileView,
  hook_success: hookSuccessView,
  date_change: dateChangeView,
  deferred_tools_delta: deferredToolsDeltaView,
  skill_listing: skillListingView,
};

/** Own-property lookup: a type named like an Object.prototype member
 *  (`constructor`) is unknown, not a function. */
export function attachmentViewFor(type: string): AttachmentView<unknown> {
  const view = Object.hasOwn(attachmentViews, type)
    ? attachmentViews[type]
    : undefined;
  return view ?? defaultAttachmentView;
}
