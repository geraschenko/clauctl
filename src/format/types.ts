import type { AgentState } from "../core/agent-state.ts";
import type { SdkEvent } from "../core/sdk-socket.ts";

// TDC: shouldn't MessageFormatOptions (and the default) be in src/format/messages.ts instead?
export interface MessageFormatOptions {
  toolResults: "summary" | "none" | "full";
  maxToolArgChars: number;
  maxErrorLines: number;
}

/** The defaults `format messages`/`format events` apply for omitted flags,
 *  and everything tail renders with — shared so tail's formatted output is
 *  byte-equal to its `--json` output piped through `format`. */
export const DEFAULT_MESSAGE_FORMAT_OPTIONS: MessageFormatOptions = {
  toolResults: "summary",
  maxToolArgChars: 120,
  maxErrorLines: 10,
};

/** One line of `format events` input: tail's framing. (`format messages`
 * input lines are core/session/file.ts `SessionEntry`s.) */
export type TailRecord = { snapshot: AgentState } | { event: SdkEvent };
