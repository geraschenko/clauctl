/**
 * `format events`: the tail stream. SDK messages share formatSdkMessage;
 * the subscribe snapshot and the daemon-synthesized events render as one-line
 * annotations. A queued prompt renders as a truncated one-liner at its
 * `userMessageQueued` and in full at its `userMessageDequeued` — the full
 * text appears where it logically enters context, while the queued line
 * preserves when it arrived. A dequeue of several uuids is one merged run,
 * rendered as the one joined message claude files for it.
 */

import type { UUID } from "node:crypto";
import {
  classOf,
  joinedPrompt,
  type AgentState,
} from "../core/agent-state/agent-state.ts";
import { type AgentEvent, eventUuid } from "../core/protocol.ts";
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
  for (const { uuid, message } of agentState.queuedMessages) {
    formatState.queuedMessages.set(uuid, message);
    lines.push(annotation(`queued ${uuid}: ${userText(message)}`));
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

/** The record's chunks; the first carries the event's merge node
 *  (`eventUuid`) so the tail can be read against the pending lists. */
function eventChunks(
  event: AgentEvent,
  formatState: FormatState,
  options: MessageFormatOptions,
): string[] {
  const chunks = eventBodyChunks(event, formatState, options);
  return chunks.length === 0
    ? chunks
    : [`[event ${eventUuid(event)}]\n${chunks[0]}`, ...chunks.slice(1)];
}

function eventBodyChunks(
  event: AgentEvent,
  formatState: FormatState,
  options: MessageFormatOptions,
): string[] {
  switch (event.kind) {
    case "userMessageQueued": {
      const promptUuid = event.message.uuid as UUID;
      formatState.queuedMessages.set(promptUuid, event.message);
      return [annotation(`queued ${promptUuid}: ${userText(event.message)}`)];
    }
    case "userMessageDequeued": {
      const dequeued = `[dequeued (${event.delivery}): ${event.uuids.join(", ")}]`;
      // Unseen uuids drop out: the annotation alone still records the dequeue.
      const prompt = joinedPrompt(
        event.uuids.flatMap((uuid) => {
          const message = formatState.queuedMessages.get(uuid);
          formatState.queuedMessages.delete(uuid);
          return message === undefined ? [] : [message];
        }),
      );
      const rendered =
        prompt === undefined
          ? undefined
          : formatSdkMessage(prompt, formatState, options);
      // The render attaches to the annotation: one logical record.
      return rendered === undefined || rendered === ""
        ? [dequeued]
        : [`${dequeued}\n${rendered}`];
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
    case "querySessionChanged":
      return [annotation(`query session: ${event.sessionId}`)];
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
