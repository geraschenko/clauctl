/**
 * Predicates over session entries that the tree filters, the entry views
 * and the TUI share: what a human typed (`isHumanPrompt`, `isPromptEntry`),
 * what an entry's message contains (`hasText`, `toolResultOnly`) and
 * whether a turn ended abnormally (`abnormalStopReason`).
 */

import { isRecord } from "../generated/util.ts";
import { extractTextContent, hasContentBlock } from "../generated/text.ts";
import {
  messageContent,
  queuedCommandPrompt,
  type SessionEntry,
} from "./file.ts";

export function hasText(entry: SessionEntry): boolean {
  return extractTextContent(messageContent(entry)).trim() !== "";
}

/** The stop_reason when it signals an abnormal end: present and neither of
 *  the two ordinary values. Aborted/errored turns are kept visible by the
 *  filters through this. */
export function abnormalStopReason(entry: SessionEntry): string | undefined {
  const stopReason = isRecord(entry.message)
    ? entry.message.stop_reason
    : undefined;
  return typeof stopReason === "string" &&
    stopReason !== "end_turn" &&
    stopReason !== "tool_use"
    ? stopReason
    : undefined;
}

export function toolResultOnly(entry: SessionEntry): boolean {
  return (
    hasContentBlock(messageContent(entry), "tool_result") && !hasText(entry)
  );
}

/** The first CLI version that writes `origin` on user entries. Entries
 *  written earlier take the pre-origin fallback. */
const ORIGIN_FIELD_SINCE = "2.1.190";

/** A prompt the human typed. Entries whose writer (`entry.version`) knew
 *  the field carry the CLI's verdict in `origin`; older entries go through
 *  the pre-origin fallback (see docs/follow-ups/subagent-activity.md). */
export function isHumanPrompt(entry: SessionEntry): boolean {
  return (
    entry.type === "user" &&
    (writtenBefore(entry, ORIGIN_FIELD_SINCE)
      ? preOriginHumanPrompt(entry)
      : isRecord(entry.origin) && entry.origin.kind === "human")
  );
}

/** A prompt the human typed, whichever way the CLI recorded it: a `user`
 *  entry (submitted idle) or a `queued_command` attachment (steered
 *  mid-turn). Compact summaries are prompt rows too for the filters, but
 *  not prompts. */
export function isPromptEntry(entry: SessionEntry): boolean {
  return isHumanPrompt(entry) || queuedCommandPrompt(entry) !== undefined;
}

/** `entry.version` (dotted numeric) is older than `version`; a missing or
 *  unparsable version counts as older. */
function writtenBefore(entry: SessionEntry, version: string): boolean {
  if (typeof entry.version !== "string") {
    return true;
  }
  const parse = (dotted: string): number[] | undefined => {
    const parts = dotted.split(".").map(Number);
    return parts.every(Number.isInteger) ? parts : undefined;
  };
  const written = parse(entry.version);
  const since = parse(version);
  if (written === undefined || since === undefined) {
    return true;
  }
  for (let i = 0; i < Math.max(written.length, since.length); i += 1) {
    const a = written[i] ?? 0;
    const b = since[i] ?? 0;
    if (a !== b) {
      return a < b;
    }
  }
  return false;
}

// TEMPORARY — pre-2.1.190 fallback. Delete this block, ORIGIN_FIELD_SINCE
// and writtenBefore once sessions older than 2.1.190 no longer matter.
const PRE_ORIGIN_NON_HUMAN_PREFIXES = [
  "<command-",
  "<local-command-",
  "<bash-",
  "[Request interrupted",
];
/** Not isMeta, has text, text not starting with a known non-human prefix.
 *  Callers guard `type === "user"`. */
function preOriginHumanPrompt(entry: SessionEntry): boolean {
  const text = extractTextContent(messageContent(entry)).trim();
  return (
    entry.isMeta !== true &&
    text !== "" &&
    !PRE_ORIGIN_NON_HUMAN_PREFIXES.some((prefix) => text.startsWith(prefix))
  );
}
