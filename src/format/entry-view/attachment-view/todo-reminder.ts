// `todo_reminder` / `task_reminder`: `{content: [...], itemCount: N}`.

import { isRecord } from "../../../core/generated/util.ts";
import type { AttachmentView } from "./attachment-view.ts";
import { jsonLength, numberField } from "../payload.ts";

interface TodoReminderPayload {
  content?: unknown;
  itemCount?: number;
}

export const todoReminderView: AttachmentView<TodoReminderPayload> = {
  summary(payload) {
    const content = isRecord(payload) ? payload.content : undefined;
    const count =
      numberField(payload, "itemCount") ??
      (Array.isArray(content) ? content.length : 0);
    return `${count} item${count === 1 ? "" : "s"}`;
  },
  size(payload) {
    return isRecord(payload) && payload.content !== undefined
      ? jsonLength(payload.content)
      : 0;
  },
};
