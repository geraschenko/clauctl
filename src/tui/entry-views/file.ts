// The file-like attachments (`file`, `edited_text_file`,
// `compact_file_reference`, `nested_memory`, `already_read_file`,
// `directory`): a path plus, depending on the type, the text the model
// sees — `snippet`, a string `content`, `content.content` (nested_memory)
// or `content.file.content` (file). Size is that text's length, 0 when
// absent (`compact_file_reference` carries none).

import { isRecord } from "../../core/generated/util.ts";
import type { AttachmentView } from "./attachment-view.ts";
import { stringField } from "./payload.ts";
import { oneLinePrefix } from "../../format/generated/text.ts";

interface FileAttachmentPayload {
  displayPath?: string;
  filename?: string;
  path?: string;
  snippet?: string;
  content?: unknown;
}

function fileText(payload: unknown): string {
  // TDC: on what basis did you decide the implementation of this function? Is this what the assistant is actually presented when there's a file attachment?
  const snippet = stringField(payload, "snippet");
  if (snippet !== undefined) {
    return snippet;
  }
  const content = isRecord(payload) ? payload.content : undefined;
  if (typeof content === "string") {
    return content;
  }
  return (
    stringField(content, "content") ??
    stringField(isRecord(content) ? content.file : undefined, "content") ??
    ""
  );
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
  size(payload) {
    return fileText(payload).length;
  },
};
