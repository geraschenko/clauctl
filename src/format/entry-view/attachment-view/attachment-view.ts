/**
 * Piece views for attachment payloads (`entry.attachment` of an
 * `attachment` entry): the one-line summary shown after `<type>: ` in the
 * tree and `format entries`, and the payload's approximate model-visible
 * size in chars (see docs/specs/entry-views.md). Payload shapes are the
 * CLI's and untrusted; every view reads its fields defensively and falls
 * back rather than throwing. Unknown types take `defaultAttachmentView`.
 */

import { oneLinePrefix } from "../../../core/generated/text.ts";
import { recordCharCount, stringField } from "../payload.ts";

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
