/**
 * Decoders for the two `format` input shapes. Both take whole JSONL input and
 * fail with a cross-pointing UsageError when fed the other subcommand's
 * output, so a swapped pipe is a one-line fix instead of silence.
 */

import { parseJsonlInput } from "../core/generated/read-input.ts";
import { UsageError } from "../core/generated/util.ts";
import type { SessionRecord, TailRecord } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// TDC: wait a second, these functions are assuming we have the full input. They can't stream? This is going to be a problem, because when we do something like `clauctl query XXX | clauctl format messages`, the query command could take a long time because it emits messages as they arrive on the sdk socket. We need `format` to be able to consume a stream and emit a stream.
export function parseSessionRecords(input: string): readonly SessionRecord[] {
  const lines = parseJsonlInput(input);
  return lines.map((line, index) => {
    if (isRecord(line) && typeof line.type === "string") {
      // A `type` field wins over `snapshot`/`event` keys: session entries
      // like file-history-snapshot carry a top-level `snapshot` payload,
      // while genuine tail records never carry a `type`.
      return line as SessionRecord;
    }
    if (isRecord(line) && ("snapshot" in line || "event" in line)) {
      throw new UsageError(
        `record ${index + 1} looks like tail output; use \`clauctl format events\``,
      );
    }
    throw new UsageError(
      `record ${index + 1} is not a session record (expected a "type" field)`,
    );
  });
}

export function parseTailRecords(input: string): readonly TailRecord[] {
  const lines = parseJsonlInput(input);
  return lines.map((line, index) => {
    if (isRecord(line) && typeof line.type === "string") {
      throw new UsageError(
        `record ${index + 1} looks like message output; use \`clauctl format messages\``,
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
