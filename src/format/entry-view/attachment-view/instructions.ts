// `instructions`: `{files: [{path, type, content}]}` — each file by its
// last two path segments (`memory/MEMORY.md`), which tells a user
// CLAUDE.md from a project one.

import { isRecord } from "../../../core/generated/util.ts";
import type { AttachmentView } from "./attachment-view.ts";
import { stringField } from "../payload.ts";
import { oneLinePrefix } from "../../../core/generated/text.ts";

interface InstructionsPayload {
  files?: unknown;
}

export const instructionsView: AttachmentView<InstructionsPayload> = {
  summary(payload, maxChars) {
    const files = isRecord(payload) ? payload.files : undefined;
    const names = (Array.isArray(files) ? files : []).flatMap((file) => {
      const path = stringField(file, "path");
      return path === undefined ? [] : [path.split("/").slice(-2).join("/")];
    });
    return oneLinePrefix(names.join(", "), maxChars);
  },
};
