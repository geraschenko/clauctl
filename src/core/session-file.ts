/**
 * The session transcript jsonl: locating it, reading it, and appending
 * synthetic compact-boundary entries (the set-context mechanism derisked in
 * docs/derisk/compact-boundary-injection/FINDINGS.md). Probe ids in comments
 * (e.g. p0b/p0c) cite the experiments in that file. Reads the file directly
 * rather than through the SDK's @alpha importSessionToStore: direct access
 * avoids the alpha dependency, and the path is needed for appending anyway.
 */

import { randomUUID, type UUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SetContextResult } from "./sdk-socket.ts";

/** One parsed jsonl line, verbatim. Known fields typed, everything else kept. */
export interface SessionEntry {
  uuid?: UUID;
  parentUuid?: UUID | null;
  logicalParentUuid?: UUID | null;
  type?: string;
  subtype?: string;
  [key: string]: unknown;
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
    // SDK 0.3.211 made this runtime field part of the declared
    // SessionMessage contract.
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

/** Torn-tail tolerant: a mid-append read can see a partial final line, which
 *  is skipped — recognizable as the file's UNTERMINATED tail (once the
 *  newline is on disk, the whole record before it is too). Anything else — a
 *  malformed terminated line, or a line whose value is not an object — is
 *  real corruption, and silently dropping it would let chain computation and
 *  file mutation proceed against incomplete history, so it throws instead. */
export function readSessionEntries(filePath: string): SessionEntry[] {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const tornTailIndex =
    lines.length > 0 && lines[lines.length - 1]!.trim() !== ""
      ? lines.length - 1
      : -1;
  const entries: SessionEntry[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (index === tornTailIndex) {
        continue;
      }
      throw new Error(`${filePath}:${index + 1}: malformed session file line`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `${filePath}:${index + 1}: session file line is not an object`,
      );
    }
    entries.push(parsed as SessionEntry);
  }
  return entries;
}

/** Entry lookup by uuid; last entry wins on a duplicate uuid. Duplicate
 *  *detection* is buildTree's job (it throws), and consumers build the
 *  tree from the same entries before using this lookup. */
export function entriesByUuid(
  entries: readonly SessionEntry[],
): Map<UUID, SessionEntry> {
  const byUuid = new Map<UUID, SessionEntry>();
  for (const entry of entries) {
    if (entry.uuid !== undefined) {
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
  summaryText?: string;
  anchor: "summary" | "boundary";
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
        anchorUuid: params.anchor === "summary" ? summaryUuid : boundaryUuid,
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

/** The file's entries once `leafUuid` (the last transcript entry the caller
 *  has seen reported elsewhere, e.g. on the daemon's event stream) is on
 *  disk — read consistency across the CLI's flush lag. Pass undefined when
 *  there is nothing to wait for. */
export async function readEntriesAfterStreamFlush(
  filePath: string,
  leafUuid: UUID | undefined,
): Promise<SessionEntry[]> {
  if (leafUuid !== undefined) {
    await waitForEntryOnDisk(filePath, leafUuid);
  }
  return readSessionEntries(filePath);
}

/** Resolves when an entry with this uuid is in the file (fs.watch + predicate;
 *  covers the ~100–180 ms flush lag after the SDK result message). */
export function waitForEntryOnDisk(
  filePath: string,
  uuid: UUID,
  timeoutMs = 10_000,
): Promise<void> {
  const entryOnDisk = (): boolean =>
    existsSync(filePath) &&
    readSessionEntries(filePath).some((entry) => entry.uuid === uuid);
  if (entryOnDisk()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const watcher = watch(filePath, () => {
      if (entryOnDisk()) {
        finish();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          `entry ${uuid} did not appear in ${filePath} within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    const finish = (): void => {
      watcher.close();
      clearTimeout(timer);
    };
    watcher.on("error", (error) => {
      finish();
      reject(error);
    });
    // The entry may have landed between the initial check and the watch
    // starting; check once more now that events are flowing.
    if (entryOnDisk()) {
      finish();
      resolve();
    }
  });
}
