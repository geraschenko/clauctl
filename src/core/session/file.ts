/**
 * The session transcript jsonl: locating it, reading it, and appending
 * synthetic compact-boundary entries (the set-context mechanism derisked in
 * docs/derisk/compact-boundary-injection/FINDINGS.md). Probe ids in comments
 * (e.g. p0b/p0c) cite the experiments in that file. Reads the file directly
 * rather than through the SDK's @alpha importSessionToStore: direct access
 * avoids the alpha dependency, and the path is needed for appending anyway.
 */

import { randomUUID, type UUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { LineReader } from "../generated/line-reader.ts";
import type { SetContextResult } from "../sdk-socket.ts";

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

/** Incremental jsonl entry parser: LineReader splitting (torn suffixes
 *  buffered until their newline arrives — a mid-append read can see a partial
 *  final line, and once the newline is on disk the whole record before it is
 *  too) plus session-file validation. Both writers terminate records with
 *  bare LF; a CRLF file would still parse, since the retained '\r' is JSON
 *  whitespace. A malformed TERMINATED line, or a terminated line whose value
 *  is not an object, is real corruption: silently dropping it would let chain
 *  computation and file mutation proceed against incomplete history, so it
 *  throws instead. */
export class SessionEntryParser {
  private readonly filePath: string;
  private readonly lineReader = new LineReader();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Complete entries terminated within this chunk (prefixed by any retained
   *  torn suffix). */
  push(chunk: Buffer): SessionEntry[] {
    return this.lineReader.push(chunk).map(({ text, lineNumber }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `${this.filePath}:${lineNumber}: malformed session file line`,
        );
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error(
          `${this.filePath}:${lineNumber}: session file line is not an object`,
        );
      }
      return parsed as SessionEntry;
    });
  }
}

/** One push of the whole file; a torn final line stays buffered in the
 *  discarded parser and is therefore skipped. */
export function readSessionEntries(filePath: string): SessionEntry[] {
  return new SessionEntryParser(filePath).push(readFileSync(filePath));
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
}): { entries: SessionEntry[]; result: SetContextResult } {
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
    result: {
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
