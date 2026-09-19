/**
 * `format events`: the tail stream. SDK messages share formatSdkMessage;
 * the subscribe snapshot and the daemon-synthesized events render as one-line
 * annotations. A queued prompt renders as a truncated one-liner at its
 * `userMessageQueued` and in full at its `userMessageDequeued` — the full
 * text appears where it logically enters context, while the queued line
 * preserves when it arrived.
 */

import { classOf, type AgentState } from "../core/agent-state/agent-state.ts";
import type { AgentEvent } from "../core/protocol.ts";
import { compactionMetadata } from "../core/session/file.ts";
import { userText } from "../tui/sdk-render.ts";
import {
  annotation,
  formatSdkMessage,
  newFormatState,
  type FormatState,
} from "./sdk-message.ts";
import type { MessageFormatOptions, TailRecord } from "./types.ts";

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
  if (agentState.querySessionId !== undefined) {
    parts.push(`session ${agentState.querySessionId}`);
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

/** `[label: type detail]` for a request-carrying event (controlApplied):
 * primitive-only payloads print their values space-joined, anything
 * structured falls back to one-line JSON. */
function requestAnnotation(label: string, request: { type: string }): string {
  const { type, ...rest } = request;
  const values = Object.values(rest).filter((value) => value !== undefined);
  if (values.length === 0) {
    return `[${label}: ${type}]`;
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
  return annotation(`${label}: ${type} ${detail}`);
}

function eventChunks(
  event: AgentEvent,
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
      return [requestAnnotation("control", event.request)];
    case "contextChanged": {
      const metadata = formatState.boundaryMetadata.get(event.boundary);
      const parts = [
        `boundary ${event.boundary}`,
        ...(metadata?.trigger === undefined ? [] : [metadata.trigger]),
        ...(metadata?.preTokens === undefined
          ? []
          : [`${metadata.preTokens} preTokens`]),
      ];
      return [`[context changed: ${parts.join(", ")}]`];
    }
    case "shutdown":
      return [`[agent ${event.reason}]`];
    // Identity only: a shared entry's payload prints at its sdkMessage
    // twin, and no session-only entry has a rendering yet (a steered
    // prompt prints at its userMessageDequeued; an attachment the harness
    // injects into the context is a candidate). Two uuids exceed the
    // annotation width, and nothing here is free text that needs
    // truncating.
    case "sessionEntry": {
      const entry = event.entry;
      if (entry.subtype === "compact_boundary" && entry.uuid !== undefined) {
        formatState.boundaryMetadata.set(entry.uuid, compactionMetadata(entry));
      }
      const parts = [
        `entry ${entry.uuid ?? "?"}`,
        classOf(entry),
        event.expectsSdkMessage ? "sdk twin" : "session-only",
        `leaf ${event.leaf?.uuid ?? "none"}`,
      ];
      return [`[${parts.join(" ")}]`];
    }
    case "sessionFileChanged":
      return [annotation(`session file: ${event.sessionId}`)];
    case "scanComplete":
      return ["[scan complete]"];
    case "sessionAppended":
      return [annotation(`appended: ${event.message.uuid ?? "?"}`)];
    case "trackerAnomaly":
      return [
        annotation(`anomaly ${event.anomaly.kind}: ${event.anomaly.detail}`),
      ];
    case "sdkMessage": {
      const chunk = formatSdkMessage(event.message, formatState, options);
      return chunk === undefined || chunk === "" ? [] : [chunk];
    }
  }
}

/** Same push/end contract as MessageFormatter over TailRecord; no cursor
 *  (events carry no resumable identity), so end() is final-newline
 *  bookkeeping only. */
export class EventFormatter {
  private readonly options: MessageFormatOptions;
  private readonly formatState = newFormatState();
  private emitted = false;

  constructor(options: MessageFormatOptions) {
    this.options = options;
  }

  push(record: TailRecord): string {
    const chunks =
      "snapshot" in record
        ? [agentStateChunk(record.snapshot, this.formatState)]
        : eventChunks(record.event, this.formatState, this.options);
    let output = "";
    for (const chunk of chunks) {
      output += this.emitted ? `\n\n${chunk}` : chunk;
      this.emitted = true;
    }
    return output;
  }

  end(): string {
    return this.emitted ? "\n" : "";
  }
}
