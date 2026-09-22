/**
 * The session transcript jsonl: locating it, reading it, and appending
 * synthetic compact-boundary entries (the set-context mechanism derisked in
 * docs/derisk/compact-boundary-injection/FINDINGS.md). Probe ids in comments
 * (e.g. p0b/p0c) cite the experiments in that file. Reads the file directly
 * rather than through the SDK's @alpha importSessionToStore: direct access
 * avoids the alpha dependency, and the path is needed for appending anyway.
 */

import { randomUUID, type UUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import type {
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { err, ok, type Result } from "neverthrow";
import { LineReader } from "../generated/line-reader.ts";
import { isRecord } from "../generated/util.ts";
import type { SetContextResponse } from "../protocol.ts";

/** One parsed jsonl line, verbatim. Known fields typed, everything else kept. */
export interface SessionEntry {
  uuid?: UUID;
  parentUuid?: UUID | null;
  logicalParentUuid?: UUID | null;
  type?: string;
  subtype?: string;
  [key: string]: unknown;
}

/** An entry that carries a uuid: what tree rows and byUuid values are. */
export type UuidEntry = SessionEntry & { uuid: UUID };

export function hasUuid(entry: SessionEntry): entry is UuidEntry {
  return entry.uuid !== undefined;
}

/** getSessionMessages' runtime objects also carry `timestamp`, absent from
 *  the SDK's declared SessionMessage type; entry-derived output matches the
 *  wire shape. `tool_use_result` (the entry's camelCase `toolUseResult`) is
 *  declared on SDKUserMessage but not on SessionMessage; replayed user
 *  messages carry it so tool views see the same structured results live and
 *  replayed. */
export type SessionMessageOnWire = SessionMessage & {
  timestamp?: string;
  tool_use_result?: unknown;
};

/** The SDK's entry→SessionMessage mapping (user/assistant only;
 *  isMeta/isSidechain excluded, and so is the uuid-less shape a real
 *  transcript entry never takes; parent_tool_use_id always null in
 *  getSessionMessages output, parent_agent_id null for the main
 *  transcript). */
export function entryToSessionMessage(
  entry: SessionEntry,
): SessionMessageOnWire | undefined {
  if (
    (entry.type !== "user" && entry.type !== "assistant") ||
    entry.uuid === undefined ||
    entry.isMeta === true ||
    entry.isSidechain === true
  ) {
    return undefined;
  }
  return {
    type: entry.type,
    uuid: entry.uuid,
    session_id: entry.sessionId as string,
    message: entry.message,
    parent_tool_use_id: null,
    // Runtime field required by the declared SessionMessage contract.
    parent_agent_id: null,
    ...(typeof entry.timestamp === "string" && {
      timestamp: entry.timestamp,
    }),
    ...(entry.toolUseResult !== undefined && {
      tool_use_result: entry.toolUseResult,
    }),
  };
}

/** The query-stream echo of an entry the daemon wrote itself
 *  (`buildBoundaryEntries`): the boundary as the CLI's compact_boundary
 *  message, the summary as the user message native compaction emits
 *  (docs/derisk/stream-classification/captures/events.jsonl:150). A
 *  transcript recognizes the summary frame as the boundary's anchor, not
 *  by any flag on the message. */
export function appendedEntryToSdkMessage(entry: SessionEntry): SDKMessage {
  if (entry.subtype === "compact_boundary") {
    const metadata = entry.compactMetadata as {
      preTokens: number;
      preservedMessages: { anchorUuid: UUID; uuids: UUID[] };
    };
    return {
      type: "system",
      subtype: "compact_boundary",
      uuid: entry.uuid as UUID,
      session_id: entry.sessionId as string,
      compact_metadata: {
        trigger: "manual",
        pre_tokens: metadata.preTokens,
        preserved_messages: {
          anchor_uuid: metadata.preservedMessages.anchorUuid,
          uuids: metadata.preservedMessages.uuids,
        },
      },
    };
  }
  const message = entryToSessionMessage(entry);
  if (message === undefined || message.type !== "user") {
    throw new Error(`not a daemon-appended entry: ${String(entry.uuid)}`);
  }
  return message as SDKMessage;
}

/** A steered message — one queued mid-turn and absorbed at a tool result
 *  — is recorded not as a `user` entry but as a `queued_command`
 *  attachment after that result (docs/derisk/uuid-stamping/), carrying
 *  the message's content verbatim: a string, or its content blocks
 *  (tests/sdk/steer-slash-command.test.ts). Undefined for every other
 *  entry. */
function queuedCommandAttachment(
  entry: SessionEntry,
): { prompt: string | readonly unknown[]; source_uuid?: unknown } | undefined {
  if (
    entry.type !== "attachment" ||
    !isRecord(entry.attachment) ||
    entry.attachment.type !== "queued_command"
  ) {
    return undefined;
  }
  const prompt = entry.attachment.prompt;
  return typeof prompt === "string" || Array.isArray(prompt)
    ? { prompt, source_uuid: entry.attachment.source_uuid }
    : undefined;
}

/** The prompt text of a steered message: its string content, or its text
 *  blocks joined by newlines; undefined for every other entry. */
export function queuedCommandPrompt(entry: SessionEntry): string | undefined {
  const prompt = queuedCommandAttachment(entry)?.prompt;
  if (typeof prompt === "string" || prompt === undefined) {
    return prompt;
  }
  return prompt
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

/** The uuid of the prompt a `queued_command` attachment records (the
 *  steer's own transcript identity); undefined for every other entry. */
export function queuedCommandSourceUuid(entry: SessionEntry): UUID | undefined {
  const sourceUuid = queuedCommandAttachment(entry)?.source_uuid;
  return typeof sourceUuid === "string" ? (sourceUuid as UUID) : undefined;
}

/** The boundary fields `MessageControl`'s compaction variant carries. */
export interface CompactionMetadata {
  readonly trigger?: string;
  readonly preTokens?: number;
}

/** The validated part of a boundary's `compactMetadata`: the boundary
 *  fact is never dropped, a malformed field is just omitted. */
export function compactionMetadata(entry: SessionEntry): CompactionMetadata {
  const metadata = entry.compactMetadata as
    { trigger?: unknown; preTokens?: unknown } | undefined;
  return {
    ...(typeof metadata?.trigger === "string" && {
      trigger: metadata.trigger,
    }),
    ...(typeof metadata?.preTokens === "number" && {
      preTokens: metadata.preTokens,
    }),
  };
}

/** The CLI's project-directory encoding: cwd with [^a-zA-Z0-9] → "-". */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** <configDir>/projects/<projectKey>/<sessionId>.jsonl. configDir is explicit:
 *  the caller resolves it the same way the CLI child does (CLAUDE_CONFIG_DIR
 *  from the child's env if set, else ~/.claude). */
export function sessionFilePath(
  configDir: string,
  cwd: string,
  sessionId: UUID,
): string {
  return join(configDir, "projects", projectKey(cwd), `${sessionId}.jsonl`);
}

/** A line's bytes in the file, terminator included. */
export interface ByteRange {
  offset: number;
  length: number;
}

export interface ParsedEntry {
  entry: SessionEntry;
  range: ByteRange;
}

/** A terminated line that is not a JSON object. */
export interface MalformedLine {
  range: ByteRange;
  /** 1-based, blank lines counted. */
  lineNumber: number;
  reason: "not-json" | "not-object";
}

export function malformedLineMessage(line: MalformedLine): string {
  return line.reason === "not-json"
    ? "malformed session file line"
    : "session file line is not an object";
}

/** Incremental jsonl entry parser: LineReader splitting (torn suffixes
 *  buffered until their newline arrives — a mid-append read can see a partial
 *  final line, and once the newline is on disk the whole record before it is
 *  too) plus session-file validation. Both writers terminate records with
 *  bare LF; a CRLF file would still parse, since the retained '\r' is JSON
 *  whitespace. A malformed TERMINATED line, or a terminated line whose value
 *  is not an object, is real corruption, reported as a `MalformedLine` in
 *  its file position among the entries; the caller decides (whole-file
 *  readers throw via `entryOrThrow` — silently dropping it would let chain
 *  computation and file mutation proceed against incomplete history; a live
 *  follower reports it and keeps following). Ranges are offsets from the
 *  first byte ever pushed, so a parser fed from byte zero of a file reports
 *  file positions. */
export class SessionEntryParser {
  private readonly lineReader = new LineReader();

  /** The lines terminated within this chunk (prefixed by any retained torn
   *  suffix), in file order. */
  push(chunk: Buffer): Result<ParsedEntry, MalformedLine>[] {
    return this.lineReader.push(chunk).map((line) => {
      const range = { offset: line.byteOffset, length: line.byteLength };
      const malformed = (reason: MalformedLine["reason"]) =>
        err({ range, lineNumber: line.lineNumber, reason });
      let value: unknown;
      try {
        value = JSON.parse(line.text);
      } catch {
        return malformed("not-json");
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return malformed("not-object");
      }
      return ok({ entry: value as SessionEntry, range });
    });
  }
}

/** The error a malformed line is for consumers that treat it as corruption. */
export function malformedLineError(
  filePath: string,
  line: MalformedLine,
): Error {
  return new Error(
    `${filePath}:${line.lineNumber}: ${malformedLineMessage(line)}`,
  );
}

/** The whole-file readers' corruption policy: a malformed line throws. */
export function entryOrThrow(
  filePath: string,
  line: Result<ParsedEntry, MalformedLine>,
): ParsedEntry {
  if (line.isErr()) {
    throw malformedLineError(filePath, line.error);
  }
  return line.value;
}

/** One push of the whole file; a torn final line stays buffered in the
 *  discarded parser and is therefore skipped. */
export function readSessionEntries(filePath: string): SessionEntry[] {
  return new SessionEntryParser()
    .push(readFileSync(filePath))
    .map((line) => entryOrThrow(filePath, line).entry);
}

/** The entries at `ranges` (as reported by SessionEntryParser), each read
 *  and parsed on its own without touching the rest of the file. One pread
 *  per range in the caller's order: measured at ~2 µs per range against
 *  ~7 µs per entry to JSON.parse, so coalescing or sorting ranges would
 *  not pay. A range that no longer holds exactly one terminated entry line
 *  is stale (the file was rewritten) and throws, as a malformed line does. */
export function readEntriesAt(
  filePath: string,
  ranges: readonly ByteRange[],
): SessionEntry[] {
  const fd = openSync(filePath, "r");
  try {
    return ranges.map((range) => {
      const buffer = Buffer.alloc(range.length);
      const bytesRead = readSync(fd, buffer, 0, range.length, range.offset);
      const parsed = new SessionEntryParser()
        .push(buffer.subarray(0, bytesRead))
        .map((line) => entryOrThrow(filePath, line));
      if (parsed.length !== 1) {
        throw new Error(
          `${filePath}: byte range ${range.offset}+${range.length} does not hold one entry line`,
        );
      }
      return parsed[0]!.entry;
    });
  } finally {
    closeSync(fd);
  }
}

/** Entry lookup by uuid; the FIRST occurrence wins on a duplicate uuid, so
 *  displayed position and displayed payload come from the same occurrence.
 *  Duplicated uuids are a legal file shape — the CLI re-persists
 *  dropped-from-context history, sometimes with mutated payloads (see
 *  docs/derisk/cli-history-repersistence/FINDINGS.md). The loader model
 *  (tree/loader.ts loadedContext) deliberately stays last-wins: it mirrors
 *  Claude's actual uuid-keyed loading, not canonical display. */
export function entriesByUuid(
  entries: readonly SessionEntry[],
): Map<UUID, SessionEntry> {
  const byUuid = new Map<UUID, SessionEntry>();
  for (const entry of entries) {
    if (entry.uuid !== undefined && !byUuid.has(entry.uuid)) {
      byUuid.set(entry.uuid, entry);
    }
  }
  return byUuid;
}

/**
 * Builds boundary (+ summary) entries per the known-working recipe
 * (FINDINGS.md "The known-working recipe"). Pure construction split from the
 * write so tests can inspect entries without a filesystem.
 *
 * The stamp boilerplate (userType, entrypoint, gitBranch, …) carries
 * plausible placeholder values copied from the proven recipe, not live
 * metadata: ablation showed only compactMetadata and a valid uuids list
 * matter to the loader, and none of these fields were individually ablated,
 * so we keep writing what was tested. Of the recipe's compactMetadata token
 * counts only the required `preTokens` is written, from real usage —
 * `durationMs`/`postTokens` are optional and would be made up, and someone
 * might plausibly trust them.
 */
export function buildBoundaryEntries(params: {
  sessionId: UUID;
  cwd: string;
  uuids: UUID[];
  /** Written as the up_to summary: the boundary's anchor, so the context
   *  reads summary first, then uuids. */
  summaryText?: string;
  /** Recorded as the boundary's logicalParentUuid (tree anchoring). */
  logicalParentUuid: UUID | null;
  /** The version stamp; when the daemon has not observed the CLI's version,
   *  falls back to the recipe's proven constant. */
  version: string | undefined;
  /** compactMetadata.preTokens: the context size this boundary supersedes;
   *  0 when unknown. */
  preTokens: number;
}): { entries: SessionEntry[]; response: SetContextResponse } {
  const boundaryUuid = randomUUID();
  const summaryUuid =
    params.summaryText !== undefined ? randomUUID() : undefined;
  const stamp = {
    isSidechain: false,
    timestamp: new Date().toISOString(),
    userType: "external",
    entrypoint: "sdk-cli",
    cwd: params.cwd,
    sessionId: params.sessionId,
    version: params.version ?? "2.1.211",
    gitBranch: "HEAD",
  };
  const boundary: SessionEntry = {
    ...stamp,
    parentUuid: null,
    logicalParentUuid: params.logicalParentUuid,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    isMeta: false,
    uuid: boundaryUuid,
    level: "info",
    compactMetadata: {
      trigger: "manual",
      preTokens: params.preTokens,
      preservedMessages: {
        anchorUuid: summaryUuid ?? boundaryUuid,
        uuids: params.uuids,
        allUuids: params.uuids,
      },
    },
  };
  const entries: SessionEntry[] = [boundary];
  if (summaryUuid !== undefined) {
    entries.push({
      ...stamp,
      parentUuid: boundaryUuid,
      type: "user",
      message: { role: "user", content: params.summaryText },
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      uuid: summaryUuid,
    });
  }
  return {
    entries,
    response: {
      boundaryUuid,
      ...(summaryUuid !== undefined && { summaryUuid }),
    },
  };
}

/** All entries in ONE write() call, boundary line first (native file order,
 *  p0b/p0c; see file comment) — a crash can tear only the tail of the single
 *  write. */
export function appendSessionEntries(
  filePath: string,
  entries: SessionEntry[],
): void {
  appendFileSync(
    filePath,
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
}
