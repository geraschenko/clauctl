import type { AgentState } from "../core/agent-state.ts";
import type { SdkEvent } from "../core/sdk-socket.ts";

export interface MessageFormatOptions {
  toolResults: "summary" | "none" | "full";
  maxToolArgChars: number;
  maxErrorLines: number;
}

/**
 * One line of `format messages` input: a SessionMessage or a verbatim
 * session-file entry (future get-entries). Lenient — only `type` is required;
 * verbatim entries drift with Anthropic CLI versions, so unrecognized types
 * are skipped rather than rejected.
 */
export type SessionRecord = Record<string, unknown> & { type: string };

/** One line of `format events` input: tail's framing. */
export type TailRecord = { snapshot: AgentState } | { event: SdkEvent };
