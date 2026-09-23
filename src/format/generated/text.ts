// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import { isRecord } from "../../core/generated/util.ts";

const DEFAULT_SUMMARY_CHARS = 80;

export function contentBlocks(content: unknown): readonly unknown[] {
  return Array.isArray(content) ? content : [];
}

export function hasContentBlock(content: unknown, type: string): boolean {
  return contentBlocks(content).some(
    (block) => isRecord(block) && block.type === type,
  );
}

export function oneLine(text: string): string {
  return text
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * oneLine's incremental form: collapses whitespace runs to one space while
 * walking `text`, stopping once `maxChars + 1` characters are emitted (so a
 * following truncateText still sees "too long" and appends `…`). Leading
 * whitespace is dropped, and so is a trailing run when the input is
 * exhausted; but a space that is the `maxChars + 1`th character is kept —
 * it is the overflow sentinel truncateText needs. Whitespace runs are
 * walked in full, so the cost is O(maxChars + whitespace walked before the
 * stop) — text length only matters through its whitespace.
 */
export function oneLinePrefix(text: string, maxChars: number): string {
  let out = "";
  let emitted = 0;
  let pendingSpace = false;
  for (const char of text) {
    if (/\s/u.test(char)) {
      pendingSpace = emitted > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      emitted += 1;
      pendingSpace = false;
      if (emitted > maxChars) {
        break;
      }
    }
    out += char;
    emitted += 1;
    if (emitted > maxChars) {
      break;
    }
  }
  return out;
}

/** `text` without its SGR escape sequences (colors, bold, …): the
 *  characters that occupy terminal columns. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  const chars = [...text];
  if (chars.length <= maxChars) {
    return text;
  }
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

/** `String.padEnd` counting code points, the unit truncateText counts, so
 *  an astral character does not shift a column aligned after the text. */
export function padEndCodePoints(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - [...text].length));
}

/** `348` / `1.2k` / `12k` — approximate char counts, so `< 10k` gets one
 *  decimal and larger counts none. */
export function formatSize(chars: number): string {
  if (chars < 1_000) {
    return String(chars);
  }
  if (chars < 10_000) {
    return `${(chars / 1_000).toFixed(1)}k`;
  }
  return `${Math.round(chars / 1_000)}k`;
}

export function countLines(text: string): number {
  if (text === "") {
    return 0;
  }
  return text.split("\n").length;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!isRecord(block) || block.type !== "text") {
        return "";
      }
      return typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

export function summarizeUnknown(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    return truncateText(oneLine(value), maxChars);
  }
  const json = JSON.stringify(value);
  return truncateText(oneLine(json ?? String(value)), maxChars);
}

export function summarizeContentBlock(block: unknown): string {
  if (!isRecord(block)) {
    return summarizeUnknown(block, DEFAULT_SUMMARY_CHARS);
  }
  if (block.type === "text") {
    return typeof block.text === "string"
      ? truncateText(oneLine(block.text), DEFAULT_SUMMARY_CHARS)
      : "[text]";
  }
  if (block.type === "image") {
    return `[image${typeof block.mimeType === "string" ? `:${block.mimeType}` : ""}]`;
  }
  if (block.type === "thinking") {
    return "[thinking]";
  }
  if (block.type === "toolCall") {
    return `[tool:${typeof block.name === "string" ? block.name : "unknown"}]`;
  }
  return `[${typeof block.type === "string" ? block.type : "content"}]`;
}
