import type { AgentState, AgentEvent } from "../core/protocol/index.ts";

export interface MessageFormatOptions {
  toolResults: "summary" | "none" | "full";
  maxToolArgChars: number;
  maxErrorLines: number;
}

/** One line of `format events` input: tail's framing. (`format messages`
 * input lines are core/session/file.ts `SessionEntry`s.) */
export type TailRecord = { snapshot: AgentState } | { event: AgentEvent };
