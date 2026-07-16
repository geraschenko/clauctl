/**
 * Decoders for the two `format` input shapes. Both take whole JSONL input and
 * fail with a cross-pointing UsageError when fed the other subcommand's
 * output, so a swapped pipe is a one-line fix instead of silence.
 */

import { parseJsonlInput } from "../core/generated/read-input.ts";
import { UsageError } from "../core/generated/util.ts";
import type { SessionEntry } from "../core/session-file.ts";
import type { TailRecord } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Whole-input only: these block until stdin closes, so they cannot sit on the
// consuming end of a live pipe (`clauctl query … | clauctl format messages`).
// Formatted tail/query needs streaming parse-and-emit — see
// docs/thoughts/formatted-tail-and-query.md.

/** SessionEntry leaves `type` optional (a verbatim jsonl line guarantees
 * nothing), but every real session line carries one — requiring it here is
 * what tells session entries apart from tail framing and garbage input. */
export function parseSessionEntries(input: string): readonly SessionEntry[] {
  const lines = parseJsonlInput(input);
  return lines.map((line, index) => {
    if (isRecord(line) && typeof line.type === "string") {
      // A `type` field wins over `snapshot`/`event` keys: session entries
      // like file-history-snapshot carry a top-level `snapshot` payload,
      // while genuine tail records never carry a `type`.
      return line as SessionEntry;
    }
    if (isRecord(line) && ("snapshot" in line || "event" in line)) {
      throw new UsageError(
        `record ${index + 1} looks like tail output; use \`clauctl format events\``,
      );
    }
    throw new UsageError(
      `record ${index + 1} is not a session entry (expected a "type" field)`,
    );
  });
}

export function parseTailRecords(input: string): readonly TailRecord[] {
  const lines = parseJsonlInput(input);
  return lines.map((line, index) => {
    if (isRecord(line) && typeof line.type === "string") {
      throw new UsageError(
        `record ${index + 1} looks like session-entry output; use \`clauctl format messages\``,
      );
    }
    if (isRecord(line)) {
      const keys = ["snapshot", "event"].filter((key) => key in line);
      if (keys.length === 1 && isRecord(line[keys[0]!])) {
        return line as TailRecord;
      }
    }
    throw new UsageError(
      `record ${index + 1} is not a tail record (expected exactly one of "snapshot" or "event")`,
    );
  });
}
