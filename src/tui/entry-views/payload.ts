/**
 * Shared helpers for the attachment views. A separate module (not
 * attachment-view.ts) so views need no runtime import from the registry
 * that imports them — only the erased `import type { AttachmentView }` —
 * keeping module evaluation order-independent.
 */

import { isRecord } from "../../core/generated/util.ts";

/** Defensive string-field read of an untrusted payload. */
export function stringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/** Defensive number-field read of an untrusted payload. */
export function numberField(payload: unknown, key: string): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}

/** Defensive string-list read of an untrusted payload: non-string items are
 *  dropped, anything but an array reads as empty. */
export function stringList(payload: unknown, key: string): string[] {
  const value = isRecord(payload) ? payload[key] : undefined;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The prefix of `text` a summary needs before any per-character work:
 *  at least `maxChars + 1` code points (astral characters are two UTF-16
 *  units) with a split surrogate pair at the cut dropped. Whitespace runs
 *  in the prefix still count against it, so a whitespace-heavy prefix can
 *  summarize shorter than the collapsed text would. */
export function sourcePrefix(text: string, maxChars: number): string {
  const prefix = text.slice(0, 2 * (maxChars + 1));
  const last = prefix.charCodeAt(prefix.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
}

export function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** Chars of a record's own fields: string values by length, anything else
 *  by its JSON length (a size estimate that never scans string content). */
export function recordCharCount(value: unknown): number {
  if (!isRecord(value)) {
    return jsonLength(value);
  }
  let count = 0;
  for (const field of Object.values(value)) {
    count += typeof field === "string" ? field.length : jsonLength(field);
  }
  return count;
}
