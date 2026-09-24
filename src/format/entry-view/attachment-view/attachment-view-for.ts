/** The attachment-view registry: the only module that imports the views. */

import {
  type AttachmentView,
  defaultAttachmentView,
} from "./attachment-view.ts";
import { dateChangeView } from "./date-change.ts";
import { deferredToolsDeltaView } from "./deferred-tools-delta.ts";
import { fileView } from "./file.ts";
import { hookSuccessView } from "./hook-success.ts";
import { skillListingView } from "./skill-listing.ts";
import { todoReminderView } from "./todo-reminder.ts";
import { totalTokensReminderView } from "./total-tokens-reminder.ts";

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
