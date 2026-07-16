/**
 * `format messages`: the session-message stream (get-messages output or a raw
 * session file). Individual SDK messages render via the shared sdk-message.ts;
 * this file adds the messages-mode-only inferred change lines and the
 * record-stream driver.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { formatSdkMessage, joinChunks, newFormatState } from "./sdk-message.ts";
import type { FormatState } from "./sdk-message.ts";
import type { MessageFormatOptions, SessionRecord } from "./types.ts";

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
  record: SessionRecord,
  formatState: FormatState,
): string | undefined {
  const mode = record.permissionMode;
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
export function formatSessionRecords(
  records: readonly SessionRecord[],
  options: MessageFormatOptions,
): string {
  const formatState = newFormatState();
  const chunks: string[] = [];
  for (const record of records) {
    if (record.type === "permission-mode") {
      const change = permissionModeChangeLine(record, formatState);
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
