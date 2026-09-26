// The file-like attachments (`file`, `edited_text_file`,
// `compact_file_reference`, `nested_memory`, `already_read_file`,
// `directory`): summarized by their path.

import type { AttachmentView } from "./attachment-view.ts";
import { stringField } from "../payload.ts";
import { oneLinePrefix } from "../../../core/generated/text.ts";

interface FileAttachmentPayload {
  displayPath?: string;
  filename?: string;
  path?: string;
}

export const fileView: AttachmentView<FileAttachmentPayload> = {
  summary(payload, maxChars) {
    return oneLinePrefix(
      stringField(payload, "displayPath") ??
        stringField(payload, "filename") ??
        stringField(payload, "path") ??
        "",
      maxChars,
    );
  },
};
