/**
 * The clauctl protocol, spoken over the agent's `socket` file:
 * newline-delimited JSON over a unix socket. Three record shapes flow
 * daemon→client, distinguished structurally: the hello (first line on
 * connect, so clients can validate they are talking to a clauctl daemon),
 * responses (have an `id`), and pushed events (`AgentEventRecord`, only on
 * connections that sent `subscribe`).
 */

import type { UUID } from "node:crypto";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type {
  EffortLevel,
  McpServerConfig,
  PermissionMode,
  PermissionResult,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionEntry } from "../session/file.ts";
import type { TreeNodeRef } from "../tree/nodes.ts";
import { UUID_PATTERN } from "../uuid.ts";

export type TurnPriority = "now" | "next" | "later";

/**
 * `subscribe`'s optional self-identification: attachers send it so the daemon
 * can track them in `record.attachments` and audit attach/detach; observers
 * like `tail` subscribe bare and stay invisible.
 */
export interface SubscribeAttachment {
  pid: number;
  client: string;
}

/**
 * The `applyFlagSettings` payload: `null` clears a key, a value replaces it
 * (the SDK method's own parameter shape). effortLevel is widened beyond
 * Settings' type: the Settings file schema omits "max", but the CLI runtime
 * accepts and applies it (verified 2026-07-21 via CLAUDE_EFFORT on a live
 * session).
 */
export type FlagSettings = Omit<
  { [K in keyof Settings]?: Settings[K] | null },
  "effortLevel"
> & { effortLevel?: EffortLevel | null };

/**
 * Query mutations except interrupt; each maps 1:1 to a Query method and emits
 * `controlApplied` on success. The mutation/read split classifies each method
 * by its documented semantics in sdk.d.ts; a misclassification costs a missing
 * or superfluous event, nothing worse.
 */
export type SdkControlMutation =
  | { type: "set-permission-mode"; mode: PermissionMode }
  | {
      type: "set-mcp-permission-mode-override";
      serverName: string;
      mode: "default" | "auto" | null;
    }
  | { type: "set-model"; model?: string }
  | {
      type: "set-max-thinking-tokens";
      maxThinkingTokens: number | null;
      thinkingDisplay?: "summarized" | "omitted" | "highlights" | null;
    }
  | { type: "apply-flag-settings"; settings: FlagSettings }
  // Writes a settings FILE through the CLI's own writer and live-applies it;
  // the SDK accepts only an explicit key allowlist per file (localSettings:
  // outputStyle; userSettings: effortLevel).
  | {
      type: "update-settings";
      source: "localSettings" | "userSettings";
      settings: Record<string, unknown>;
    }
  | { type: "set-mcp-servers"; servers: Record<string, McpServerConfig> }
  | { type: "toggle-mcp-server"; serverName: string; enabled: boolean }
  | { type: "reconnect-mcp-server"; serverName: string }
  | { type: "stop-task"; taskId: string }
  | { type: "background-tasks"; toolUseId?: string }
  | { type: "rewind-files"; userMessageId: string; dryRun?: boolean }
  | { type: "seed-read-state"; path: string; mtime: number }
  // holdOnCacheImpact: apply nothing when the reload would change the tool
  // list the prompt cache depends on; the response then carries `held: true`.
  | { type: "reload-plugins"; holdOnCacheImpact?: boolean }
  | { type: "reload-skills" }
  | { type: "reload-output-styles" };

/**
 * The mutation as broadcast on `controlApplied`: the request as received,
 * except an apply-flag-settings `effortLevel: null`. That null clears the
 * flag-tier value, but the level the next query will use is still something
 * concrete, and the client-side fold (next-agent-state.ts) is pure and cannot run
 * the settings cascade — so the daemon resolves the post-clear level at
 * emission (spawn `--effort`, else the settings cascade) and emits it in
 * place of the null; null survives only when neither tier specifies a level.
 */
export type SdkControlApplied = SdkControlMutation;

/** Query reads; the response `data` is the method's return value. */
export type SdkControlRead =
  | { type: "initialization-result" }
  | { type: "supported-commands" }
  | { type: "supported-models" }
  | { type: "supported-agents" }
  | { type: "mcp-server-status" }
  // "full" (default) counts each category with the token-count API;
  // "summary" answers from the last response's usage and local estimates.
  | { type: "get-context-usage"; detail?: "summary" | "full" }
  // skipBehaviors: leave the response's `behaviors` null instead of scanning
  // local transcripts for it.
  | { type: "usage"; skipBehaviors?: boolean }
  | { type: "account-info" }
  | {
      type: "read-file";
      path: string;
      maxBytes?: number;
      encoding?: "utf-8" | "base64";
    }
  // An MCP Apps `ui://` resource from a connected server (alpha SDK method;
  // the contents are untrusted third-party HTML).
  | { type: "read-mcp-resource"; serverName: string; uri: string };

// Record (not Set) so a new SdkControlMutation variant is a compile error here.
const MUTATION_TYPES: Record<SdkControlMutation["type"], true> = {
  "set-permission-mode": true,
  "set-mcp-permission-mode-override": true,
  "set-model": true,
  "set-max-thinking-tokens": true,
  "apply-flag-settings": true,
  "update-settings": true,
  "set-mcp-servers": true,
  "toggle-mcp-server": true,
  "reconnect-mcp-server": true,
  "stop-task": true,
  "background-tasks": true,
  "rewind-files": true,
  "seed-read-state": true,
  "reload-plugins": true,
  "reload-skills": true,
  "reload-output-styles": true,
};

export function isControlMutation(
  request: ProtocolRequest,
): request is SdkControlMutation {
  // hasOwn, not `in`: the wire type is untrusted, and inherited property
  // names ("constructor", "toString") must not classify as known.
  return Object.hasOwn(MUTATION_TYPES, request.type);
}

// Record (not Set) so a new SdkControlRead variant is a compile error here.
const READ_TYPES: Record<SdkControlRead["type"], true> = {
  "initialization-result": true,
  "supported-commands": true,
  "supported-models": true,
  "supported-agents": true,
  "mcp-server-status": true,
  "get-context-usage": true,
  usage: true,
  "account-info": true,
  "read-file": true,
  "read-mcp-resource": true,
};

export function isControlRead(
  request: ProtocolRequest,
): request is SdkControlRead {
  // hasOwn, not `in`: see isControlMutation.
  return Object.hasOwn(READ_TYPES, request.type);
}

/** Exactly one of `uuids` / `rewindTo`. */
export type SetContextRequest =
  // Append a compact_boundary (+ optional summary) to the session jsonl and
  // restart the Query so the listed messages become the effective context.
  | {
      type: "set-context";
      /** Ordered; becomes compactMetadata.preservedMessages.uuids (and allUuids). */
      uuids: UUID[];
      /** Omitted → no summary entry is written. Present → up_to shape:
       *  summary first, then uuids. */
      summaryText?: string;
    }
  // Syntactic sugar for uuids = (the assistant context at rewindTo, followed by
  // `append`).
  | {
      type: "set-context";
      rewindTo: TreeNodeRef;
      /** Appended after the context at rewindTo; the whole list then goes
       *  through normalizePreservedUuids. */
      append?: UUID[];
    };

/** Response data for set-context. summaryUuid absent whenever no summary
 *  entry was written. */
export interface SetContextResponse {
  boundaryUuid: UUID;
  summaryUuid?: UUID;
  /** Uuids normalization inserted into the preserved list (omitted when
   *  nothing was added). */
  added?: UUID[];
}

/** What a read of entries carries back: identities only (no file read),
 *  or the complete entries (readEntriesAt over their ranges). */
export type EntryPayload = "uuids" | "full";

export const ENTRY_PAYLOADS: readonly EntryPayload[] = ["uuids", "full"];

/** get-entries response. `entries` is present for `payload: "full"`: the
 *  complete entries in file order, one per uuid. */
export interface GetEntriesResponse {
  uuids: UUID[];
  entries?: SessionEntry[];
  /** The current-leaf occurrence — where the next turn attaches. Null
   *  when the session has no chain entries. */
  leaf: TreeNodeRef | null;
}

/** get-context response: the context as occurrences in context order;
 *  `entries` (same order) present for `payload: "full"`. */
export interface GetContextResponse {
  refs: TreeNodeRef[];
  entries?: SessionEntry[];
}

function assertUuid(value: unknown, label: string): UUID {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a uuid, got ${JSON.stringify(value)}`);
  }
  return value as UUID;
}

/** A {uuid, viaBoundary?} record from untrusted JSON; throws naming
 *  `label` on any other shape. */
export function parseWireTreeNodeRef(
  value: unknown,
  label: string,
): TreeNodeRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a {uuid, viaBoundary?} object`);
  }
  // Fields stay unknown so assertUuid is the only way to a UUID.
  const ref = value as { uuid?: unknown; viaBoundary?: unknown };
  return {
    uuid: assertUuid(ref.uuid, `${label}.uuid`),
    ...(ref.viaBoundary !== undefined && {
      viaBoundary: assertUuid(ref.viaBoundary, `${label}.viaBoundary`),
    }),
  };
}

/** The socket casts untrusted JSON, so the one destructive command is parsed
 *  explicitly before any teardown. Throws with a descriptive message on:
 *  both or neither of uuids/rewindTo, non-array or non-uuid-string uuids or
 *  append, a rewindTo that is not a {uuid, viaBoundary?} record of uuids,
 *  append without rewindTo, non-string or empty summaryText. An empty uuids
 *  array passes — an explicit empty list on the wire is a deliberate
 *  context reset; the fat-finger guard lives in the CLI (--empty). */
export function parseSetContextRequest(
  raw: Record<string, unknown>,
): SetContextRequest {
  const { uuids, rewindTo, summaryText, append } = raw;
  const parseUuidList = (value: unknown, label: string): UUID[] => {
    if (!Array.isArray(value)) {
      throw new Error(`set-context: ${label} must be an array`);
    }
    return value.map((uuid) => assertUuid(uuid, `${label} entry`));
  };
  if (rewindTo !== undefined) {
    if (uuids !== undefined || summaryText !== undefined) {
      throw new Error(
        "set-context: rewindTo is mutually exclusive with uuids/summaryText",
      );
    }
    return {
      type: "set-context",
      rewindTo: parseWireTreeNodeRef(rewindTo, "set-context: rewindTo"),
      ...(append !== undefined && { append: parseUuidList(append, "append") }),
    };
  }
  if (uuids === undefined) {
    throw new Error("set-context: exactly one of uuids/rewindTo is required");
  }
  if (append !== undefined) {
    throw new Error("set-context: append requires rewindTo");
  }
  const parsedUuids = parseUuidList(uuids, "uuids");
  if (summaryText !== undefined) {
    if (typeof summaryText !== "string" || summaryText === "") {
      throw new Error("set-context: summaryText must be a non-empty string");
    }
  }
  return {
    type: "set-context",
    uuids: parsedUuids,
    ...(summaryText !== undefined && { summaryText }),
  };
}

export interface GetEntriesSnapshotRequest {
  type: "get-entries";
  payload: EntryPayload;
  since?: UUID;
}

/** Payload lookup for known uuids: no snapshot, no payload selector. */
export interface GetEntriesByUuidsRequest {
  type: "get-entries";
  uuids: UUID[];
}

export const isGetEntriesByUuids = (
  request: ProtocolRequest,
): request is GetEntriesByUuidsRequest =>
  request.type === "get-entries" && "uuids" in request;

export type ProtocolRequest =
  | {
      type: "prompt";
      content: string | ContentBlockParam[];
      priority?: TurnPriority;
      shouldQuery?: false;
    }
  | { type: "interrupt" }
  // Response data: none. The socket client is trusted (it has whatever a
  // TUI or SDK user has, including persisting arbitrary rules), so the
  // decision is the raw SDK shape; the handler validates it structurally
  // before it reaches the SDK. Fails with error text NOT_PENDING_ERROR
  // when the ask is not pending (resolved, cancelled, or unknown).
  | {
      type: "permission-response";
      toolUseId: string;
      decision: PermissionResult;
    }
  // Response data is the daemon's current AgentState; every event emitted
  // after it follows as an AgentEventRecord line until the connection closes.
  // No history replay — a subscriber starts at "now" and folds from there
  // (next-agent-state.ts).
  | { type: "subscribe"; attachment?: SubscribeAttachment }
  // Response data: GetContextResponse — the assistant context at `at` (an
  // occurrence of the context tree), or at the current leaf when absent;
  // empty with no session or a null leaf. Derived from the tracked file via
  // the context tree, not from the Query, so it is not an SdkControlRead.
  | { type: "get-context"; at?: TreeNodeRef; payload: EntryPayload }
  // Response data: GetEntriesResponse — every canonical entry of the current
  // session (after the `since` cursor when given; an unknown cursor is an
  // error) plus the current-leaf occurrence. Clients build the tree locally
  // (build-tree.ts); a nested wire representation would overflow
  // JSON.stringify on long sessions.
  | GetEntriesSnapshotRequest
  // Response data: SessionEntry[] — these entries complete, in requested
  // order; an unknown uuid is an error.
  | GetEntriesByUuidsRequest
  // Response data: SetContextResponse.
  | SetContextRequest
  | SdkControlMutation
  | SdkControlRead;

export type ProtocolRequestRecord = ProtocolRequest & { id: string };

export type ProtocolResponse =
  | { id: string; ok: true; data?: unknown }
  | { id: string; ok: false; error: string };
