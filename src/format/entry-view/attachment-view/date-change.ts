// `date_change`: `{newDate}`.

import type { AttachmentView } from "./attachment-view.ts";
import { stringField } from "../payload.ts";
import { oneLinePrefix } from "../../../core/generated/text.ts";

interface DateChangePayload {
  newDate?: string;
}

export const dateChangeView: AttachmentView<DateChangePayload> = {
  summary(payload, maxChars) {
    return oneLinePrefix(stringField(payload, "newDate") ?? "", maxChars);
  },
};
