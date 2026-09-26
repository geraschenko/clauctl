/**
 * The transcript presentation of API messages (docs/specs/api-messages.md
 * Examples): role headers, text verbatim, structured blocks as one-line
 * brackets. The headers and brackets are reader conventions; the spec
 * records why.
 */

import type { ApiContentBlock, ApiMessage } from "./to-api-messages.ts";

const ROLE_HEADERS = {
  user: "USER:",
  assistant: "ASSISTANT:",
  system: "SYSTEM:",
} as const;

function blockText(block: ApiContentBlock): string {
  return typeof block.text === "string" ? block.text : "";
}

/** A tool result's content: its string, or its text blocks' texts joined
 *  by newlines with non-text blocks as brackets. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((block: unknown) =>
          typeof block === "object" && block !== null && "type" in block
            ? formatBlock(block as ApiContentBlock)
            : "",
        )
        .join("\n")
    : "";
}

function formatBlock(block: ApiContentBlock): string {
  switch (block.type) {
    case "text":
      return blockText(block);
    case "thinking":
      return `[thinking]\n${typeof block.thinking === "string" ? block.thinking : blockText(block)}`;
    case "tool_use":
      return `[tool_use ${String(block.name)} ${String(block.id)} ${JSON.stringify(block.input)}]`;
    case "tool_result": {
      const header = `[tool_result ${String(block.tool_use_id)}${block.is_error === true ? " is_error" : ""}]`;
      const text = toolResultText(block.content);
      return text === "" ? header : `${header}\n${text}`;
    }
    default:
      return `[${block.type}]`;
  }
}

export function formatApiMessages(messages: readonly ApiMessage[]): string {
  return messages
    .map(
      (message) =>
        `${ROLE_HEADERS[message.role]}\n${message.content.map(formatBlock).join("\n")}\n`,
    )
    .join("\n");
}
