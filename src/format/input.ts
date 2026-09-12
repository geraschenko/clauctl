/**
 * Streaming classification of `format` input. The stream is classified from
 * its first complete record, then records are validated and yielded lazily so
 * subcommands can render a live pipe as it flows; only the get-entries
 * snapshot document (finite by construction) is buffered whole. Mismatched
 * input fails with a cross-pointing UsageError, so a swapped pipe is a
 * one-line fix instead of silence.
 */

import { createReadStream } from "node:fs";
import { parseJsonlInput } from "../core/generated/read-input.ts";
import type { CommandContext } from "../core/generated/targets.ts";
import { isRecord, UsageError } from "../core/generated/util.ts";
import { LineReader, type Line } from "../core/generated/line-reader.ts";
import { entriesByUuid, type SessionEntry } from "../core/session/file.ts";
import type { MessageRecord } from "../core/session/messages.ts";
import { buildTree } from "../core/tree/build-tree.ts";
import { toContextTree } from "../core/tree/context-tree.ts";
import type { SessionSnapshot } from "../core/tree/nodes.ts";
import type { TailRecord } from "./types.ts";

export type FormatInput =
  | Readonly<{ kind: "entries"; records: AsyncIterable<SessionEntry> }>
  | Readonly<{ kind: "messages"; records: AsyncIterable<MessageRecord> }>
  | Readonly<{ kind: "events"; records: AsyncIterable<TailRecord> }>
  /** No complete record before EOF; every subcommand emits nothing. */
  | Readonly<{ kind: "empty" }>;

/** Chunk source: stdin (file undefined or "-") or fs.createReadStream. */
export function inputChunks(
  context: CommandContext,
  file: string | undefined,
): AsyncIterable<Buffer | string> {
  if (file === undefined || file === "-") {
    return (context.process as NodeJS.Process).stdin;
  }
  return createReadStream(file);
}

function isSessionSnapshotShaped(
  document: unknown,
): document is Record<string, unknown> & { entries: unknown[] } {
  return isRecord(document) && Array.isArray(document.entries);
}

function parseLine(line: Line): unknown {
  try {
    return JSON.parse(line.text) as unknown;
  } catch (error) {
    throw new UsageError(
      `invalid JSONL line ${line.lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type RecordShape = "entry" | "message" | "event" | undefined;

/** A `type` field wins over `snapshot`/`event` keys: session entries like
 *  file-history-snapshot carry a top-level `snapshot` payload, while genuine
 *  tail records never carry a `type`. Message records are told apart from
 *  session entries by the `control` type or by `parent_tool_use_id`, which
 *  entryToSessionMessage always sets and no observed session entry carries
 *  top-level; `session_id` alone would not do — real transcripts contain
 *  entries carrying snake_case `session_id` alongside camelCase
 *  `sessionId`. */
function classifyRecord(value: unknown): RecordShape {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === "control") {
    return "message";
  }
  if (
    (value.type === "user" || value.type === "assistant") &&
    typeof value.session_id === "string" &&
    "parent_tool_use_id" in value
  ) {
    return "message";
  }
  if (typeof value.type === "string") {
    return "entry";
  }
  const keys = ["snapshot", "event"].filter((key) => key in value);
  if (keys.length === 1 && isRecord(value[keys[0]!])) {
    return "event";
  }
  return undefined;
}

function crossPointer(lineNumber: number, shape: RecordShape): UsageError {
  switch (shape) {
    case "entry":
      return new UsageError(
        `record ${lineNumber} looks like session-entry output; use \`clauctl format messages\``,
      );
    case "message":
      return new UsageError(
        `record ${lineNumber} looks like canonical message output; use \`clauctl format messages\``,
      );
    case "event":
      return new UsageError(
        `record ${lineNumber} looks like tail output; use \`clauctl format events\``,
      );
    case undefined:
      return new UsageError(
        `record ${lineNumber} is not recognized (expected a session entry, canonical message, or event)`,
      );
  }
}

function validateDocumentEntries(document: {
  entries: unknown[];
}): SessionEntry[] {
  return document.entries.map((element, index) => {
    if (isRecord(element) && typeof element.type === "string") {
      return element as SessionEntry;
    }
    throw new UsageError(
      `entries[${index}] is not a session entry (expected a "type" field)`,
    );
  });
}

/** Classifies the stream from its first complete record, then yields
 *  validated records lazily; a mid-stream record of the wrong shape throws a
 *  cross-pointing UsageError naming its record number (line numbers count
 *  blank lines, so they match the file). The get-entries snapshot document is
 *  buffered whole and yielded as kind:"entries"; its `leaf` is irrelevant to
 *  linear rendering and ignored. */
export async function decodeFormatInput(
  chunks: AsyncIterable<Buffer | string>,
): Promise<FormatInput> {
  const iterator = chunks[Symbol.asyncIterator]();
  const lineReader = new LineReader();
  const queue: Line[] = [];
  let eof = false;
  /** Raw bytes consumed so far; retained only until the stream is classified
   *  as JSONL, dropped for the document path's whole-input parse otherwise. */
  let rawChunks: Buffer[] | undefined = [];

  const nextLine = async (): Promise<Line | undefined> => {
    while (queue.length === 0 && !eof) {
      const result = await iterator.next();
      if (result.done === true) {
        eof = true;
        break;
      }
      const chunk =
        typeof result.value === "string"
          ? Buffer.from(result.value)
          : result.value;
      rawChunks?.push(chunk);
      queue.push(...lineReader.push(chunk));
    }
    return queue.shift();
  };

  /** Buffer the rest of the input and validate it as the get-entries
   *  document; `failure` is what classification would have thrown, deferred
   *  in case the whole input is a document instead. */
  const decodeDocument = async (failure: UsageError): Promise<FormatInput> => {
    while (!eof) {
      const result = await iterator.next();
      if (result.done === true) {
        eof = true;
        break;
      }
      rawChunks!.push(
        typeof result.value === "string"
          ? Buffer.from(result.value)
          : result.value,
      );
    }
    const text = Buffer.concat(rawChunks!).toString("utf8").trim();
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw failure;
    }
    if (!isSessionSnapshotShaped(document)) {
      throw failure;
    }
    const entries = validateDocumentEntries(document);
    return {
      kind: "entries",
      records: (async function* () {
        yield* entries;
      })(),
    };
  };

  const first = await nextLine();
  if (first === undefined) {
    // No complete line at all. A document without a trailing newline is
    // still valid input; anything else is empty (a torn final line is not a
    // record, exactly as Spec 1 drops an unterminated file suffix).
    const text = Buffer.concat(rawChunks!).toString("utf8").trim();
    if (text === "") {
      return { kind: "empty" };
    }
    const tornLine = new UsageError("input has no complete record");
    try {
      return await decodeDocument(tornLine);
    } catch (error) {
      if (error === tornLine) {
        return { kind: "empty" };
      }
      throw error;
    }
  }

  let parsed: unknown;
  try {
    parsed = parseLine(first);
  } catch (error) {
    // A pretty-printed document's first line (`{`) does not parse alone.
    return await decodeDocument(error as UsageError);
  }
  if (isSessionSnapshotShaped(parsed)) {
    // A one-line minified {"entries": [...]} parses as a JSONL record but is
    // snapshot-shaped; route it to document handling.
    return await decodeDocument(crossPointer(first.lineNumber, undefined));
  }

  const shape = classifyRecord(parsed);
  if (shape === undefined) {
    throw crossPointer(first.lineNumber, undefined);
  }
  rawChunks = undefined;

  async function* records<T>(expected: "entry" | "message" | "event") {
    let line: Line | undefined = first;
    let value: unknown = parsed;
    while (line !== undefined) {
      const recordShape = classifyRecord(value);
      if (recordShape !== expected) {
        throw crossPointer(line.lineNumber, recordShape);
      }
      yield value as T;
      line = await nextLine();
      if (line !== undefined) {
        value = parseLine(line);
      }
    }
  }

  switch (shape) {
    case "entry":
      return { kind: "entries", records: records<SessionEntry>("entry") };
    case "message":
      return { kind: "messages", records: records<MessageRecord>("message") };
    case "event":
      return { kind: "events", records: records<TailRecord>("event") };
  }
}

const NOT_A_SNAPSHOT =
  'input is not a session snapshot (expected one JSON document with an "entries" array, or session-entry JSONL)';

/**
 * Whole-input decoder for `format tree` (which deliberately buffers: tree
 * layout needs every occurrence). Accepts (1) get-entries output: one JSON
 * document with an `entries` array (records with a string `type`; uuids are
 * not syntax-checked) and a `leaf` that is null or an object with a string
 * `uuid` (and optional string `viaBoundary`; a missing `leaf` property is a
 * UsageError); or (2) raw session-entry JSONL, leaf derived locally as the
 * context tree's leaf — the same function the daemon computes. Tail-shaped
 * input → cross-pointing UsageError; anything else → generic
 * NOT_A_SNAPSHOT.
 */
export function parseSessionSnapshot(input: string): SessionSnapshot {
  const trimmed = input.trim();
  let document: unknown;
  if (trimmed.startsWith("{")) {
    try {
      document = JSON.parse(trimmed);
    } catch {
      document = undefined;
    }
  }
  if (isSessionSnapshotShaped(document)) {
    const entries = validateDocumentEntries(document);
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
  const firstLine = lines[0];
  if (isRecord(firstLine) && typeof firstLine.type === "string") {
    // Relink diagnostics during the leaf derivation are declared-ignored —
    // rendering proceeds either way.
    const entries = lines.map((line, index) => {
      if (isRecord(line) && typeof line.type === "string") {
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
    return {
      entries,
      leaf: toContextTree(
        buildTree(entries, () => {}),
        entriesByUuid(entries),
      ).leaf,
    };
  }
  if (
    isRecord(firstLine) &&
    ("snapshot" in firstLine || "event" in firstLine)
  ) {
    throw new UsageError(
      "input looks like tail output; use `clauctl format events`",
    );
  }
  throw new UsageError(NOT_A_SNAPSHOT);
}
