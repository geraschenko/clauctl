import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionEntry } from "../session/file.ts";
import { isToolResultEntry } from "../tree/loader.ts";

/** `type/subtype` of a query message or log entry, for anomaly details
 *  and event annotations. */
export function classOf(item: { type?: string; subtype?: string }): string {
  return item.subtype === undefined
    ? (item.type ?? "?")
    : `${item.type}/${item.subtype}`;
}

/** The classification table, one function per side: whether the other
 *  stream never carries this occurrence. Uuid-less occurrences are not
 *  asked. `excludedFromQuery` needs the complete entry (it reads
 *  `message.content`), so the tracker calls it once per entry and
 *  publishes the answer as the event's `expectsSdkMessage`; the fold reads
 *  that. */
export function excludedFromSession(message: SDKMessage): boolean {
  switch (message.type) {
    case "assistant":
    case "user":
      return false;
    case "system":
      return message.subtype !== "compact_boundary";
    default:
      return true;
  }
}
export function excludedFromQuery(entry: SessionEntry): boolean {
  switch (entry.type) {
    case "assistant":
      return false;
    case "user":
      return !(
        isToolResultEntry(entry) ||
        entry.isCompactSummary === true ||
        isLocalCommandStdout(entry)
      );
    case "system":
      return (
        entry.subtype !== "compact_boundary" &&
        entry.subtype !== "local_command"
      );
    default:
      return true;
  }
}

/** A slash command's output logged as a `user` entry, which the query
 *  stream replays (`isReplay`) — the shared `user` class that has no
 *  `tool_result` block (classification table). */
function isLocalCommandStdout(entry: SessionEntry): boolean {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return (
    typeof content === "string" && content.startsWith("<local-command-stdout>")
  );
}
