/**
 * Incremental renderer for canonical message records (`format messages` and
 * the future formatted `tail`/`prompt`). Individual SDK messages render via
 * the shared sdk-message.ts; this file adds control-record rendering and the
 * push/end stream driver. Lenient — unknown message types degrade to
 * formatSdkMessage's generic annotation rather than being rejected.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  MessageControl,
  MessageRecord,
} from "../core/session/messages.ts";
import { annotation, formatSdkMessage, newFormatState } from "./sdk-message.ts";
import type { MessageFormatOptions } from "./types.ts";
import { displayUuid } from "./uuid.ts";

function renderControl(control: MessageControl): string {
  switch (control.kind) {
    case "model_changed":
      return `[model: ${control.from} -> ${control.to}]`;
    case "permission_mode_changed":
      return `[permission-mode: ${control.from} -> ${control.to}]`;
    case "compaction": {
      const parts = [
        ...(control.trigger === undefined ? [] : [control.trigger]),
        ...(control.preTokens === undefined
          ? []
          : [`${control.preTokens} preTokens`]),
      ];
      return parts.length === 0
        ? "[compaction]"
        : `[compaction: ${parts.join(", ")}]`;
    }
    case "queued_input":
      return annotation(`queued: ${control.text}`);
  }
}

/** Incremental renderer for canonical message records. The concatenation of
 *  every push() and the final end() return value is the stream's formatted
 *  output: chunks separated by blank lines, exactly one trailing newline,
 *  cursor line last — byte-equal to formatting the same finite record
 *  sequence whole. */
export class MessageFormatter {
  private readonly options: MessageFormatOptions;
  private readonly formatState = newFormatState();
  private emitted = false;
  private lastUuid: string | undefined;

  constructor(options: MessageFormatOptions) {
    this.options = options;
  }

  /** The record's formatted chunk (with any separator), "" when it renders
   *  to nothing. Tracks the last uuid consumed regardless of rendering. */
  push(record: MessageRecord): string {
    if (typeof record.uuid === "string") {
      this.lastUuid = record.uuid;
    }
    const chunk =
      record.type === "control"
        ? renderControl(record.control)
        : formatSdkMessage(
            record as SDKMessage,
            this.formatState,
            this.options,
          );
    if (chunk === undefined || chunk === "") {
      return "";
    }
    const separated = this.emitted ? `\n\n${chunk}` : chunk;
    this.emitted = true;
    return separated;
  }

  /** Flush: the cursor line when any uuid-bearing record was consumed, plus
   *  final-newline bookkeeping; "" for a stream that rendered nothing and
   *  carried no uuids. */
  end(): string {
    if (this.lastUuid === undefined) {
      return this.emitted ? "\n" : "";
    }
    const cursor = `[cursor: ${displayUuid(this.lastUuid)}]`;
    return this.emitted ? `\n\n${cursor}\n` : `${cursor}\n`;
  }
}
