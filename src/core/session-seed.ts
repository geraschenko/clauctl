/**
 * File-derived AgentState seed values (daemon startup), recovered from the
 * session transcript via the loader model (tree/loader.ts).
 */

import type { UUID } from "node:crypto";
import type {
  NonNullableUsage,
  PermissionMode,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { toNonNullableUsage } from "./agent-state.ts";
import type { SessionEntry } from "./session-file.ts";
import type { TreeNodeRef } from "./tree/nodes.ts";
import { loadedContext, type OnInvalid } from "./tree/loader.ts";

/** File-derived AgentState seed values (daemon startup). */
export interface SessionFileSeed {
  lastUsage?: NonNullableUsage;
  claudeCodeVersion?: string;
  model?: string;
  permissionMode?: PermissionMode;
  leaf?: TreeNodeRef;
}

/**
 * AgentState values recoverable from the session file, for seeding a daemon
 * that starts with history on disk. lastUsage and model come from the last
 * non-sidechain assistant entry ON the loaded context (a rewound-away
 * branch's usage does not describe the context a resume would load, and a
 * sidechain assistant's usage describes the subagent's context — the live
 * fold skips those too); claudeCodeVersion from the
 * last version stamp and permissionMode from the last permission-mode entry,
 * both in plain file order (latest observation wins regardless of branch);
 * leaf is the context's last user/assistant occurrence (viaBoundary
 * preserved) under the same meta/sidechain filter the stream applies — the
 * same eligibility the live fold uses, so a context ending in e.g. a
 * turn_duration system entry does not seed a leaf the fold would never have
 * produced.
 */
export function seedFromEntries(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): SessionFileSeed {
  const byUuid = new Map<UUID, SessionEntry>();
  for (const entry of entries) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
    }
  }
  const contextRefs = loadedContext(entries, onInvalid);
  const contextEntries = contextRefs
    .map((ref) => byUuid.get(ref.uuid))
    .filter((entry) => entry !== undefined);

  const lastAssistantMessage = contextEntries.findLast(
    (entry) => entry.type === "assistant" && entry.isSidechain !== true,
  )?.message as SDKAssistantMessage["message"] | undefined;
  const claudeCodeVersion = entries.findLast(
    (entry) => typeof entry.version === "string",
  )?.version as string | undefined;
  const permissionMode = entries.findLast(
    (entry) => entry.type === "permission-mode",
  )?.permissionMode as PermissionMode | undefined;
  const leaf = contextRefs.findLast((ref) => {
    const entry = byUuid.get(ref.uuid);
    return (
      entry !== undefined &&
      (entry.type === "user" || entry.type === "assistant") &&
      entry.isMeta !== true &&
      entry.isSidechain !== true
    );
  });

  return {
    ...(lastAssistantMessage?.usage !== undefined && {
      lastUsage: toNonNullableUsage(lastAssistantMessage.usage),
    }),
    ...(lastAssistantMessage?.model !== undefined && {
      model: lastAssistantMessage.model,
    }),
    ...(claudeCodeVersion !== undefined && { claudeCodeVersion }),
    ...(permissionMode !== undefined && { permissionMode }),
    ...(leaf !== undefined && { leaf }),
  };
}
