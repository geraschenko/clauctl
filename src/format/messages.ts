/**
 * Plain-text rendering of the SDK message stream, shared by `format messages`
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
import type { MessageFormatOptions, SessionRecord } from "./types.ts";

/**
 * Mutable rendering context threaded through a whole stream: tool_use id →
 * tool name (results are named by their call), last-seen model / permission
 * mode (for inferred change lines).
 */
export interface FormatState {
  toolNames: Map<string, string>;
  /** Full text of queued prompts, rendered at their dequeue (events mode);
   * seeded from the snapshot's queuedMessages. */
  queuedMessages: Map<number, SDKUserMessage>;
  lastModel?: string;
  lastPermissionMode?: string;
}

export function newFormatState(): FormatState {
  return { toolNames: new Map(), queuedMessages: new Map() };
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
  state: FormatState,
  options: MessageFormatOptions,
): string | undefined {
  if (options.toolResults === "none") {
    return undefined;
  }
  const name = state.toolNames.get(result.toolCallId) ?? "tool";
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
  state: FormatState,
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
    const chunk = formatToolResult(result, state, options);
    if (chunk !== undefined) {
      chunks.push(chunk);
    }
  }
  return chunks.length === 0 ? undefined : chunks.join("\n\n");
}

function formatAssistant(
  message: SDKAssistantMessage,
  state: FormatState,
  options: MessageFormatOptions,
): string {
  const rendered = renderAssistant(message);
  const lines = ["== assistant =="];
  if (rendered.content.some((block) => block.type === "thinking")) {
    lines.push("[thinking]");
  }
  for (const block of rendered.content) {
    if (block.type === "toolCall") {
      state.toolNames.set(block.id, block.name);
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
  state: FormatState,
  options: MessageFormatOptions,
): string | undefined {
  switch (message.type) {
    case "user":
      if ("isReplay" in message && message.isReplay) {
        return undefined;
      }
      return formatUser(message, state, options);
    case "assistant":
      return formatAssistant(message, state, options);
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

/**
 * `[model: old -> new]` inferred from consecutive assistant entries; nothing
 * for the first assistant message. Messages-mode only — in events mode the
 * change is explicit as `controlApplied: set-model`.
 */
function modelChangeLine(
  message: SDKAssistantMessage,
  state: FormatState,
): string | undefined {
  const model = message.message.model;
  const previous = state.lastModel;
  state.lastModel = model;
  return previous === undefined || previous === model
    ? undefined
    : `[model: ${previous} -> ${model}]`;
}

/**
 * `[permission-mode: old -> new]` deduped from verbatim `permission-mode`
 * entries, which the CLI writes identically every turn. Only reachable on
 * get-entries input — getSessionMessages filters these entries out.
 */
function permissionModeChangeLine(
  record: SessionRecord,
  state: FormatState,
): string | undefined {
  const mode = record.permissionMode;
  if (typeof mode !== "string") {
    return undefined;
  }
  const previous = state.lastPermissionMode;
  state.lastPermissionMode = mode;
  return previous === undefined || previous === mode
    ? undefined
    : `[permission-mode: ${previous} -> ${mode}]`;
}

export function joinChunks(chunks: readonly string[]): string {
  return chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`;
}

/** Whole-input formatter for `format messages`. */
export function formatSessionRecords(
  records: readonly SessionRecord[],
  options: MessageFormatOptions,
): string {
  const state = newFormatState();
  const chunks: string[] = [];
  for (const record of records) {
    if (record.type === "permission-mode") {
      const change = permissionModeChangeLine(record, state);
      if (change !== undefined) {
        chunks.push(change);
      }
      continue;
    }
    if (
      record.type !== "user" &&
      record.type !== "assistant" &&
      record.type !== "system"
    ) {
      continue; // unknown session-record types (attachment, …) are skipped
    }
    // The same narrowing historyToSdkMessages performs: a SessionMessage
    // carries every field its SDKMessage variant requires.
    const message = record as unknown as SDKMessage;
    if (message.type === "assistant") {
      const change = modelChangeLine(message, state);
      if (change !== undefined) {
        chunks.push(change);
      }
    }
    const chunk = formatSdkMessage(message, state, options);
    if (chunk !== undefined && chunk !== "") {
      chunks.push(chunk);
    }
  }
  return joinChunks(chunks);
}
