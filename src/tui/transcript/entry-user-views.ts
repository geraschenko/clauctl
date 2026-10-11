import type {
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  queuedCommandPrompt,
  type SessionEntry,
} from "../../core/session/file.ts";
import {
  userTurnViews,
  userTurnViewsFromText,
  type UserTurnView,
} from "../../format/sdk-render.ts";

/** The views a session entry contributes to a user turn: a user message's
 *  text, a steered prompt's `queued_command` attachment, a
 *  system/local_command entry (slash commands and their stdout can live
 *  there — empirical: /login, /context; others arrive as user messages —
 *  which entryToSessionMessage drops). Empty otherwise. */
export function entryUserViews(
  entry: SessionEntry,
  message: (SessionMessage & SDKMessage) | undefined,
): UserTurnView[] {
  if (
    entry.type === "system" &&
    entry.subtype === "local_command" &&
    typeof entry.content === "string"
  ) {
    return userTurnViewsFromText(entry.content);
  }
  const steeredPrompt = queuedCommandPrompt(entry);
  if (steeredPrompt !== undefined) {
    // A steer's attachment is the prompt verbatim; a `/command` is never
    // steered (tests/sdk/steer-slash-command.test.ts), so no expansion.
    return [{ kind: "prompt", text: steeredPrompt }];
  }
  return message?.type === "user" ? userTurnViews(message) : [];
}
