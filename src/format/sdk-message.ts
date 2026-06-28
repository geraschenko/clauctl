/**
 * Plain-text rendering of individual SDK messages, shared by `format messages`
 * and `format events`. Conversions from SDK shapes reuse src/tui/sdk-render.ts
 * (single source of truth with the TUI); this file only decides what the text
 * looks like. No ANSI/color ever — the output is consumed by LLMs.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { RenderToolResult } from "../tui/render-types.ts";
import { renderAssistant, toolResultsOf, userText } from "../tui/sdk-render.ts";
import {
  countLines,
  oneLine,
  summarizeUnknown,
  truncateText,
} from "./generated/text.ts";
import type { MessageFormatOptions } from "./types.ts";

/**
 * Mutable rendering context threaded through a whole stream: tool_use id →
 * tool name (results are named by their call).
 */
export interface FormatState {
  toolNames: Map<string, string>;
  /** Full text of queued prompts, rendered at their dequeue (events mode);
   * seeded from a snapshot record's queued messages. */
  queuedMessages: Map<number, SDKUserMessage>;
}

export function newFormatState(): FormatState {
  return { toolNames: new Map(), queuedMessages: new Map() };
}

const ANNOTATION_CHARS = 80;

/** `[content]`, one-lined and truncated as a whole so every annotation line
 * caps at the same width regardless of its prefix. */
export function annotation(content: string): string {
  return `[${truncateText(oneLine(content), ANNOTATION_CHARS)}]`;
}

function formatToolArguments(args: unknown, maxChars: number): string {
  if (typeof args !== "object" || args === null) {
    return summarizeUnknown(args, maxChars);
  }
  const record = args as Record<string, unknown>;
  const preferredKeys = ["path", "file_path", "command", "pattern"];
  const preferred = preferredKeys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${key}: ${String(record[key])}`);
  const text =
    preferred.length > 0 ? preferred.join(", ") : JSON.stringify(args);
  return truncateText(oneLine(text ?? "{}"), maxChars);
}

function formatToolResult(
  result: RenderToolResult,
  formatState: FormatState,
  options: MessageFormatOptions,
): string | undefined {
  if (options.toolResults === "none") {
    return undefined;
  }
  const name = formatState.toolNames.get(result.toolCallId) ?? "tool";
  const status = result.isError ? "error" : "ok";
  const text = result.content;
  const summary = `[${name}:${status} ${countLines(text)} lines, ${Buffer.byteLength(text, "utf8")} bytes]`;
  if (options.toolResults === "summary" && !result.isError) {
    return summary;
  }
  const snippet =
    options.toolResults === "summary"
      ? text.split("\n").slice(0, options.maxErrorLines).join("\n")
      : text;
  return snippet === "" ? summary : `${summary}\n${snippet}`;
}

function formatUser(
  message: SDKUserMessage,
  formatState: FormatState,
  options: MessageFormatOptions,
): string | undefined {
  const results = toolResultsOf(message);
  if (results.length === 0) {
    return `== user ==\n${userText(message)}`;
  }
  // Mixed content (text alongside tool_result blocks) renders both; a
  // results-only message gets no user header.
  const text = userText(message);
  const chunks = text === "" ? [] : [`== user ==\n${text}`];
  for (const result of results) {
    const chunk = formatToolResult(result, formatState, options);
    if (chunk !== undefined) {
      chunks.push(chunk);
    }
  }
  return chunks.length === 0 ? undefined : chunks.join("\n\n");
}

function formatAssistant(
  message: SDKAssistantMessage,
  formatState: FormatState,
  options: MessageFormatOptions,
): string {
  const rendered = renderAssistant(message);
  const lines = ["== assistant =="];
  if (rendered.content.some((block) => block.type === "thinking")) {
    lines.push("[thinking]");
  }
  for (const block of rendered.content) {
    if (block.type === "toolCall") {
      formatState.toolNames.set(block.id, block.name);
      const args = formatToolArguments(
        block.arguments,
        options.maxToolArgChars,
      );
      lines.push(
        args === "" ? `[tool:${block.name}]` : `[tool:${block.name} ${args}]`,
      );
    } else if (block.type === "text" && block.text !== "") {
      lines.push(block.text);
    }
  }
  if (rendered.errorMessage !== undefined) {
    lines.push(`[error: ${rendered.errorMessage}]`);
  }
  return lines.join("\n");
}

function formatResult(message: SDKMessage & { type: "result" }): string {
  const turns = `${message.num_turns} turn${message.num_turns === 1 ? "" : "s"}`;
  const duration = `${(message.duration_ms / 1000).toFixed(1)}s`;
  const cost = `$${message.total_cost_usd.toFixed(4)}`;
  return `[result: ${message.subtype}, ${turns}, ${duration}, ${cost}]`;
}

/** The no-per-variant-renderer fallback for the SDKMessage long tail. */
function genericAnnotation(message: SDKMessage): string {
  const subtype = (message as { subtype?: unknown }).subtype;
  return typeof subtype === "string"
    ? `[${message.type}: ${subtype}]`
    : `[${message.type}]`;
}

/** Render one SDK message; undefined = dropped (noisy-and-worthless variants). */
export function formatSdkMessage(
  message: SDKMessage,
  formatState: FormatState,
  options: MessageFormatOptions,
): string | undefined {
  switch (message.type) {
    case "user":
      if ("isReplay" in message && message.isReplay) {
        return undefined;
      }
      return formatUser(message, formatState, options);
    case "assistant":
      return formatAssistant(message, formatState, options);
    case "result":
      return formatResult(message);
    case "stream_event":
    case "rate_limit_event":
      return undefined;
    case "system":
      if (message.subtype === "init") {
        return undefined;
      }
      return genericAnnotation(message);
    default:
      return genericAnnotation(message);
  }
}
