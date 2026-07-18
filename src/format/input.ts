/**
 * Decoders for the three `format` input shapes. All take whole input and
 * fail with a cross-pointing UsageError when fed another subcommand's
 * output, so a swapped pipe is a one-line fix instead of silence.
 */

import type { SessionTree } from "../core/tree.ts";
import { parseJsonlInput } from "../core/generated/read-input.ts";
import { UsageError } from "../core/generated/util.ts";
import type { SessionEntry } from "../core/session-file.ts";
import type { TailRecord } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** get-tree output is one pretty-printed JSON document, so JSONL parsing
 *  would fail on its first line (`{`) with a generic error before any
 *  cross-pointing check could fire; the whole-document parse runs first. */
function parseWholeDocument(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isSessionTreeShaped(
  document: unknown,
): document is Record<string, unknown> & { tree: unknown[] } {
  return isRecord(document) && Array.isArray(document.tree);
}

function rejectSessionTreeInput(input: string): void {
  if (isSessionTreeShaped(parseWholeDocument(input))) {
    throw new UsageError(
      "input looks like get-tree output; use `clauctl format tree`",
    );
  }
}

// Whole-input only: these block until stdin closes, so they cannot sit on the
// consuming end of a live pipe (`clauctl query … | clauctl format messages`).
// Formatted tail/query needs streaming parse-and-emit — see
// docs/thoughts/formatted-tail-and-query.md.

/** SessionEntry leaves `type` optional (a verbatim jsonl line guarantees
 * nothing), but every real session line carries one — requiring it here is
 * what tells session entries apart from tail framing and garbage input. */
export function parseSessionEntries(input: string): readonly SessionEntry[] {
  rejectSessionTreeInput(input);
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
  rejectSessionTreeInput(input);
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

/** One JSON document with a `tree` array and a `leaf` that is null or an
 * object with a string `uuid` (and optional string `viaBoundary`).
 * Tail-shaped or session-entry JSONL input → UsageError pointing at the
 * other subcommands. */
export function parseSessionTree(input: string): SessionTree {
  const document = parseWholeDocument(input);
  if (isSessionTreeShaped(document)) {
    const leaf = document.leaf;
    if (
      leaf === null ||
      (isRecord(leaf) &&
        typeof leaf.uuid === "string" &&
        (leaf.viaBoundary === undefined ||
          typeof leaf.viaBoundary === "string"))
    ) {
      return document as unknown as SessionTree;
    }
    throw new UsageError(
      'session tree "leaf" must be null or an object with a string "uuid"',
    );
  }
  let lines: readonly unknown[];
  try {
    lines = parseJsonlInput(input);
  } catch {
    throw new UsageError(
      'input is not a session tree (expected one JSON document with a "tree" array)',
    );
  }
  const first = lines[0];
  if (isRecord(first) && typeof first.type === "string") {
    throw new UsageError(
      "input looks like session-entry output; use `clauctl format messages`",
    );
  }
  if (isRecord(first) && ("snapshot" in first || "event" in first)) {
    throw new UsageError(
      "input looks like tail output; use `clauctl format events`",
    );
  }
  throw new UsageError(
    'input is not a session tree (expected one JSON document with a "tree" array)',
  );
}
