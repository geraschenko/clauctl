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
// TDC: I wonder if "messages" is bad terminology, and we should use "records" instead. What do you think? This represents entries in the session file, right? What terminology does the claude agent sdk use for entries in the session file. It looks like it uses "message", so maybe "messages" is good after all, but it's confusing that "format messages" is used for SessionRecords and "format events" is used for TailRecords. Maybe we should raname TailRecord to TailEvent and SessionRecord to SessionMessage?
export type SessionRecord = Record<string, unknown> & { type: string };

/** One line of `format events` input: tail's framing. */
// TDC: change "snapshot" to "agent-state"?
export type TailRecord = { snapshot: AgentState } | { event: SdkEvent };
