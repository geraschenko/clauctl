/**
 * Decoders for the three `format` input shapes. All take whole input and
 * fail with a cross-pointing UsageError when fed another subcommand's
 * output, so a swapped pipe is a one-line fix instead of silence.
 */

import { seedFromEntries } from "../core/effective-chain.ts";
import type { SessionSnapshot } from "../core/tree.ts";
import { parseJsonlInput } from "../core/generated/read-input.ts";
import { UsageError } from "../core/generated/util.ts";
import type { SessionEntry } from "../core/session-file.ts";
import type { TailRecord } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** get-entries output is one pretty-printed JSON document, so JSONL parsing
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

function isSessionSnapshotShaped(
  document: unknown,
): document is Record<string, unknown> & { entries: unknown[] } {
  return isRecord(document) && Array.isArray(document.entries);
}

function rejectSessionSnapshotInput(input: string): void {
  if (isSessionSnapshotShaped(parseWholeDocument(input))) {
    throw new UsageError(
      "input looks like get-entries output; use `clauctl format tree`",
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
  rejectSessionSnapshotInput(input);
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
  rejectSessionSnapshotInput(input);
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

const NOT_A_SNAPSHOT =
  'input is not a session snapshot (expected one JSON document with an "entries" array, or session-entry JSONL)';

/**
 * Accepts (1) get-entries output: one JSON document with an `entries` array
 * (elements validated by the same rule parseSessionEntries uses — records
 * with a string `type`; uuids are not syntax-checked) and a `leaf` that is
 * null or an object with a string `uuid` (and optional string `viaBoundary`;
 * a missing `leaf` property is a UsageError); or (2) raw session-entry
 * JSONL, leaf derived via the seedFromEntries chain logic — deliberately the
 * last user/assistant occurrence, which can differ from the daemon's
 * chain-tip leaf when a chain ends in a non-conversational entry; for file
 * rendering the conversational cursor is the useful one. Tail-shaped input →
 * cross-pointing UsageError; anything else → generic NOT_A_SNAPSHOT.
 * Tree-level corruption (duplicate occurrence keys) is not the parser's
 * job: buildTree throws later, and format commands let that error surface
 * loudly.
 */
export function parseSessionSnapshot(input: string): SessionSnapshot {
  const document = parseWholeDocument(input);
  if (isSessionSnapshotShaped(document)) {
    const entries = document.entries.map((element, index) => {
      if (isRecord(element) && typeof element.type === "string") {
        return element as SessionEntry;
      }
      throw new UsageError(
        `entries[${index}] is not a session entry (expected a "type" field)`,
      );
    });
    if (!("leaf" in document)) {
      throw new UsageError(
        'session snapshot is missing "leaf" (null or an object with a string "uuid")',
      );
    }
    const leaf = document.leaf;
    if (
      leaf === null ||
      (isRecord(leaf) &&
        typeof leaf.uuid === "string" &&
        (leaf.viaBoundary === undefined ||
          typeof leaf.viaBoundary === "string"))
    ) {
      return { entries, leaf: leaf as SessionSnapshot["leaf"] };
    }
    throw new UsageError(
      'session snapshot "leaf" must be null or an object with a string "uuid"',
    );
  }
  let lines: readonly unknown[];
  try {
    lines = parseJsonlInput(input);
  } catch {
    throw new UsageError(NOT_A_SNAPSHOT);
  }
  const first = lines[0];
  if (isRecord(first) && typeof first.type === "string") {
    // Session-entry JSONL; per-record validation (and its error messages)
    // comes from the shared entry parser. Relink diagnostics during the
    // leaf derivation are declared-ignored — rendering proceeds either way.
    const entries = [...parseSessionEntries(input)];
    return {
      entries,
      leaf: seedFromEntries(entries, () => {}).leaf ?? null,
    };
  }
  if (isRecord(first) && ("snapshot" in first || "event" in first)) {
    throw new UsageError(
      "input looks like tail output; use `clauctl format events`",
    );
  }
  throw new UsageError(NOT_A_SNAPSHOT);
}
