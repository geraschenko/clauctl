/**
 * `format events`: the tail stream. SDK messages share formatSdkMessage;
 * the subscribe snapshot and the daemon-synthesized events render as one-line
 * annotations. A queued prompt renders as a truncated one-liner at its
 * `userMessageQueued` and in full at its `userMessageDequeued` — the full
 * text appears where it logically enters context, while the queued line
 * preserves when it arrived.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "../core/agent-state.ts";
import type { SdkControlMutation, SdkEvent } from "../core/sdk-socket.ts";
import { userText } from "../tui/sdk-render.ts";
import { oneLine, truncateText } from "./generated/text.ts";
import {
  formatSdkMessage,
  joinChunks,
  newFormatState,
  type FormatState,
} from "./messages.ts";
import type { MessageFormatOptions, TailRecord } from "./types.ts";

const PROMPT_SUMMARY_CHARS = 80;

function promptSummary(message: SDKUserMessage): string {
  return truncateText(oneLine(userText(message)), PROMPT_SUMMARY_CHARS);
}

function snapshotChunk(snapshot: AgentState, state: FormatState): string {
  const parts: string[] = [snapshot.activity];
  if (snapshot.model !== undefined) {
    parts.push(`model ${snapshot.model}`);
  }
  if (snapshot.permissionMode !== undefined) {
    parts.push(`permissions ${snapshot.permissionMode}`);
  }
  if (snapshot.sessionId !== undefined) {
    parts.push(`session ${snapshot.sessionId}`);
  }
  const lines = [`[snapshot: ${parts.join(", ")}]`];
  // The snapshot is the authoritative queue state; anything remembered from
  // before it (a concatenated or restarted stream) is stale.
  state.queuedMessages.clear();
  for (const { id, message } of snapshot.queuedMessages) {
    state.queuedMessages.set(id, message);
    lines.push(`[queued #${id}: ${promptSummary(message)}]`);
  }
  for (const message of snapshot.deliveredMessages) {
    lines.push(`[delivered: ${promptSummary(message)}]`);
  }
  return lines.join("\n");
}

function formatControl(request: SdkControlMutation): string {
  const { type, ...rest } = request;
  const values = Object.values(rest).filter((value) => value !== undefined);
  if (values.length === 0) {
    return `[control: ${type}]`;
  }
  const detail = values.every(
    (value) =>
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
  )
    ? values.map(String).join(" ")
    : JSON.stringify(rest);
  return `[control: ${type} ${truncateText(oneLine(detail), PROMPT_SUMMARY_CHARS)}]`;
}

function eventChunks(
  event: SdkEvent,
  state: FormatState,
  options: MessageFormatOptions,
): string[] {
  switch (event.kind) {
    case "userMessageQueued":
      state.queuedMessages.set(event.id, event.message);
      return [`[queued #${event.id}: ${promptSummary(event.message)}]`];
    case "userMessageDequeued": {
      const ids = event.ids.map((id) => `#${id}`).join(", ");
      const annotation = `[dequeued (${event.delivery}): ${ids}]`;
      const renders: string[] = [];
      for (const id of event.ids) {
        const message = state.queuedMessages.get(id);
        if (message === undefined) {
          continue; // unseen id: the annotation alone still records the dequeue
        }
        state.queuedMessages.delete(id);
        const rendered = formatSdkMessage(message, state, options);
        if (rendered !== undefined && rendered !== "") {
          renders.push(rendered);
        }
      }
      // The first render attaches to the annotation (one logical record, per
      // the spec example); further messages of a merged bucket separate as
      // ordinary blank-line records.
      const [first, ...rest] = renders;
      return first === undefined
        ? [annotation]
        : [`${annotation}\n${first}`, ...rest];
    }
    case "compactSent":
      return ["[compact sent]"];
    case "interruptSent":
      return ["[interrupt sent]"];
    case "controlApplied":
      return [formatControl(event.request)];
    case "sdkMessage": {
      const chunk = formatSdkMessage(event.message, state, options);
      return chunk === undefined || chunk === "" ? [] : [chunk];
    }
  }
}

/** Whole-input formatter for `format events`. */
export function formatTailRecords(
  records: readonly TailRecord[],
  options: MessageFormatOptions,
): string {
  const state = newFormatState();
  const chunks: string[] = [];
  for (const record of records) {
    if ("snapshot" in record) {
      chunks.push(snapshotChunk(record.snapshot, state));
    } else {
      chunks.push(...eventChunks(record.event, state, options));
    }
  }
  return joinChunks(chunks);
}
