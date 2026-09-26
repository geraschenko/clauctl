// `total_tokens_reminder`: `{text: "<total_tokens>N tokens left</total_tokens>"}`.

import type { AttachmentView } from "./attachment-view.ts";
import { sourcePrefix, stringField } from "../payload.ts";
import { oneLinePrefix } from "../../../core/generated/text.ts";

interface TotalTokensReminderPayload {
  text?: string;
}

/** Slack the tag-strip needs beyond maxChars so stripping the wrapping tags
 *  still leaves a full maxChars + 1 of text to summarize. */
const TAGS_LENGTH = "<total_tokens></total_tokens>".length;

export const totalTokensReminderView: AttachmentView<TotalTokensReminderPayload> =
  {
    summary(payload, maxChars) {
      const text = sourcePrefix(
        stringField(payload, "text") ?? "",
        maxChars + TAGS_LENGTH,
      );
      return oneLinePrefix(text.replace(/<\/?total_tokens>/gu, ""), maxChars);
    },
  };
