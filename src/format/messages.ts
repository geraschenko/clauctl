/**
 * `format messages`: the session-entry stream (get-messages / get-entries
 * output or a raw session file). Individual SDK messages render via the
 * shared sdk-message.ts; this file adds the messages-mode-only inferred
 * change lines and the entry-stream driver. Lenient — verbatim entries drift
 * with Anthropic CLI versions, so unrecognized types are skipped rather than
 * rejected.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionEntry } from "../core/session/file.ts";
import { formatSdkMessage, joinChunks, newFormatState } from "./sdk-message.ts";
import type { FormatState } from "./sdk-message.ts";
import type { MessageFormatOptions } from "./types.ts";

/**
 * `[model: old -> new]` inferred from consecutive assistant entries; nothing
 * for the first assistant message. Messages-mode only — in events mode the
 * change is explicit as `controlApplied: set-model`.
 */
function modelChangeLine(
  message: SDKAssistantMessage,
  formatState: FormatState,
): string | undefined {
  const model = message.message.model;
  const previous = formatState.lastModel;
  formatState.lastModel = model;
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
  entry: SessionEntry,
  formatState: FormatState,
): string | undefined {
  const mode = entry.permissionMode;
  if (typeof mode !== "string") {
    return undefined;
  }
  const previous = formatState.lastPermissionMode;
  formatState.lastPermissionMode = mode;
  return previous === undefined || previous === mode
    ? undefined
    : `[permission-mode: ${previous} -> ${mode}]`;
}

/** Whole-input formatter for `format messages`. */
export function formatSessionEntries(
  entries: readonly SessionEntry[],
  options: MessageFormatOptions,
): string {
  const formatState = newFormatState();
  const chunks: string[] = [];
  for (const entry of entries) {
    if (entry.type === "permission-mode") {
      const change = permissionModeChangeLine(entry, formatState);
      if (change !== undefined) {
        chunks.push(change);
      }
      continue;
    }
    if (
      entry.type !== "user" &&
      entry.type !== "assistant" &&
      entry.type !== "system"
    ) {
      continue; // unknown session-entry types (attachment, …) are skipped
    }
    // A SessionMessage carries every field its SDKMessage variant requires
    // (`type`, `message`, `uuid`, `session_id`, `parent_tool_use_id`), so
    // the cast is a narrowing of `message: unknown`, not a fabrication.
    const message = entry as unknown as SDKMessage;
    if (message.type === "assistant") {
      const change = modelChangeLine(message, formatState);
      if (change !== undefined) {
        chunks.push(change);
      }
    }
    const chunk = formatSdkMessage(message, formatState, options);
    if (chunk !== undefined && chunk !== "") {
      chunks.push(chunk);
    }
  }
  return joinChunks(chunks);
}
