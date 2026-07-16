/**
 * `format events`: the tail stream. SDK messages share formatSdkMessage;
 * the subscribe snapshot and the daemon-synthesized events render as one-line
 * annotations. A queued prompt renders as a truncated one-liner at its
 * `userMessageQueued` and in full at its `userMessageDequeued` — the full
 * text appears where it logically enters context, while the queued line
 * preserves when it arrived.
 */

import type { AgentState } from "../core/agent-state.ts";
import type { SdkControlMutation, SdkEvent } from "../core/sdk-socket.ts";
import { userText } from "../tui/sdk-render.ts";
import { oneLine, truncateText } from "./generated/text.ts";
import {
  formatSdkMessage,
  joinChunks,
  newFormatState,
  type FormatState,
} from "./sdk-message.ts";
import type { MessageFormatOptions, TailRecord } from "./types.ts";

const ANNOTATION_CHARS = 80;

/** `[content]`, one-lined and truncated as a whole so every annotation line
 * caps at the same width regardless of its prefix. */
function annotation(content: string): string {
  return `[${truncateText(oneLine(content), ANNOTATION_CHARS)}]`;
}

function agentStateChunk(
  agentState: AgentState,
  formatState: FormatState,
): string {
  const parts: string[] = [agentState.activity];
  if (agentState.model !== undefined) {
    parts.push(`model ${agentState.model}`);
  }
  if (agentState.permissionMode !== undefined) {
    parts.push(`permissions ${agentState.permissionMode}`);
  }
  if (agentState.sessionId !== undefined) {
    parts.push(`session ${agentState.sessionId}`);
  }
  const lines = [`[snapshot: ${parts.join(", ")}]`];
  // A snapshot record carries the authoritative queue state; anything
  // remembered from before it (a concatenated or restarted stream) is stale.
  formatState.queuedMessages.clear();
  for (const { id, message } of agentState.queuedMessages) {
    formatState.queuedMessages.set(id, message);
    lines.push(annotation(`queued #${id}: ${userText(message)}`));
  }
  for (const message of agentState.deliveredMessages) {
    lines.push(annotation(`delivered: ${userText(message)}`));
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
  return annotation(`control: ${type} ${detail}`);
}

function eventChunks(
  event: SdkEvent,
  formatState: FormatState,
  options: MessageFormatOptions,
): string[] {
  switch (event.kind) {
    case "userMessageQueued":
      formatState.queuedMessages.set(event.id, event.message);
      return [annotation(`queued #${event.id}: ${userText(event.message)}`)];
    case "userMessageDequeued": {
      const ids = event.ids.map((id) => `#${id}`).join(", ");
      const dequeued = `[dequeued (${event.delivery}): ${ids}]`;
      const renders: string[] = [];
      for (const id of event.ids) {
        const message = formatState.queuedMessages.get(id);
        if (message === undefined) {
          continue; // unseen id: the annotation alone still records the dequeue
        }
        formatState.queuedMessages.delete(id);
        const rendered = formatSdkMessage(message, formatState, options);
        if (rendered !== undefined && rendered !== "") {
          renders.push(rendered);
        }
      }
      // The first render attaches to the annotation (one logical record, per
      // the spec example); further messages of a merged bucket separate as
      // ordinary blank-line records.
      const [first, ...rest] = renders;
      return first === undefined
        ? [dequeued]
        : [`${dequeued}\n${first}`, ...rest];
    }
    case "compactSent":
      return ["[compact sent]"];
    case "interruptSent":
      return ["[interrupt sent]"];
    case "controlApplied":
      return [formatControl(event.request)];
    case "sdkMessage": {
      const chunk = formatSdkMessage(event.message, formatState, options);
      return chunk === undefined || chunk === "" ? [] : [chunk];
    }
  }
}

/** Whole-input formatter for `format events`. */
export function formatTailRecords(
  records: readonly TailRecord[],
  options: MessageFormatOptions,
): string {
  const formatState = newFormatState();
  const chunks: string[] = [];
  for (const record of records) {
    if ("snapshot" in record) {
      chunks.push(agentStateChunk(record.snapshot, formatState));
    } else {
      chunks.push(...eventChunks(record.event, formatState, options));
    }
  }
  return joinChunks(chunks);
}
