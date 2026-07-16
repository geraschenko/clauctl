// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

const DEFAULT_SUMMARY_CHARS = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function oneLine(text: string): string {
  return text
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
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
