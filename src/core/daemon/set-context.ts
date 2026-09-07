/**
 * set-context semantics: the one request that replaces the Query. Reshapes
 * the agent's effective context by appending a compact-boundary entry and
 * restarting the Query on the mutated file — the mechanism derisked in
 * docs/derisk/compact-boundary-injection/FINDINGS.md and specified in
 * docs/specs/session-tree-and-set-context.md (rewind mode and the
 * boundary's logicalParentUuid per docs/specs/context-tree.md).
 *
 * Probe ids in comments (e.g. P9 a, P10) cite the experiments in
 * docs/derisk/compact-boundary-injection/FINDINGS.md that established each
 * behavior.
 */

import { randomUUID, type UUID } from "node:crypto";
import type { NonNullableUsage } from "@anthropic-ai/claude-agent-sdk";
import {
  invalidRelinkReason,
  isThinkingOnlyEntry,
  isToolCallEntry,
  isToolResultEntry,
  loadedContext,
  toolCallIdsOf,
  toolGroupMaps,
} from "../tree/loader.ts";
import { buildTree } from "../tree/build-tree.ts";
import { matchPreservedList, toContextTree } from "../tree/context-tree.ts";
import type { SetContextRequest, SetContextResult } from "../sdk-socket.ts";
import { parseTreeNodeRef, type TreeNodeRef } from "../tree/nodes.ts";
import {
  appendSessionEntries,
  buildBoundaryEntries,
  entriesByUuid,
  readSessionEntries,
  type SessionEntry,
} from "../session/file.ts";
import { readEntriesAfterStreamFlush } from "../session/entry-stream.ts";
import type { GetMessagesOverride } from "./get-messages.ts";
import type { RequestHandlerDeps } from "./request-handlers.ts";
import type { RwGate } from "./rw-gate.ts";

/** compactMetadata.preTokens for a boundary being appended now: the full
 *  context footprint of the last assistant message — input + cache creation
 *  + cache read + output; 0 when no usage has been observed. */
const preTokensOf = (usage: NonNullableUsage | undefined): number =>
  usage === undefined
    ? 0
    : usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens +
      usage.output_tokens;

export type NormalizePreservedUuidsResult =
  { ok: true; uuids: UUID[]; added: UUID[] } | { ok: false; reason: string };

/** Normalize or reject requested preserved uuids against the file: the
 *  boundary written from the result presents exactly this list — expansion
 *  adds nothing, sanitization drops nothing. Completes mismatched tool
 *  call/result pairs from the file (missing result inserted immediately
 *  after its call, missing call immediately before its result), reporting
 *  what it added; fail-closed rejects lists completion cannot fix (either
 *  half of a pair nonexistent in the file; thinking-only API message
 *  groups; relink-invalid shapes — duplicates, unknown uuids — delegated
 *  to invalidRelinkReason so the check exists in one place). Rejection
 *  philosophy: a caller who really wants an entry dropped should send a
 *  shorter list that omits it explicitly. */
export function normalizePreservedUuids(
  requested: UUID[],
  byUuid: Map<UUID, SessionEntry>,
): NormalizePreservedUuidsResult {
  // Relink validity exactly as the loader will judge the written boundary.
  // The synthetic anchor keeps the anchor-in-uuids rule out of play:
  // buildBoundaryEntries mints a fresh anchor uuid, so that shape is
  // unproducible here.
  const relinkReason = invalidRelinkReason(new Set(byUuid.keys()), {
    uuid: randomUUID(),
    preservedMessages: { anchorUuid: randomUUID(), uuids: requested },
  });
  if (relinkReason !== undefined) {
    const rationale = relinkReason.startsWith("duplicated uuid")
      ? " — the loader's relink rewrites parents over a uuid-keyed map, so" +
        " a repeated uuid clobbers its earlier reparenting: everything" +
        " before the duplicate's second-to-last occurrence is functionally" +
        " deleted and the rest keeps a parent cycle. A duplicate cannot" +
        ' mean "this message twice"; if the deletion is what you want,' +
        " send the shorter list explicitly"
      : "";
    return { ok: false, reason: `${relinkReason}${rationale}` };
  }

  const { assistantsByMessageId, resultsByCallUuid } = toolGroupMaps([
    ...byUuid.values(),
  ]);
  const requestedSet = new Set(requested);

  // Rejections up front, so placement below cannot fail. Only requested
  // entries can reject: a pulled-in call has at least the requested result
  // that pulled it in, and a pulled-in result's call is the entry being
  // placed.
  for (const entryUuid of requested) {
    const entry = byUuid.get(entryUuid)!; // membership checked by the relink gate
    if (isToolResultEntry(entry)) {
      const callUuid = entry.parentUuid;
      if (callUuid == null || !byUuid.has(callUuid)) {
        return {
          ok: false,
          reason:
            `tool result ${entryUuid} has no call entry in the file — ` +
            "its parent is missing, so the pair cannot be completed; " +
            "omit the result explicitly",
        };
      }
    } else if (
      isToolCallEntry(entry) &&
      (resultsByCallUuid.get(entryUuid) ?? []).length === 0
    ) {
      return {
        ok: false,
        reason:
          `tool call ${entryUuid} (${toolCallIdsOf(entry).join(", ")}) has ` +
          "no tool_result anywhere in the file (killed turn) — the loader " +
          "would silently drop the call entry; omit it explicitly",
      };
    }
  }

  // Sets are insertion-ordered, so each doubles as the output sequence and
  // its own fast containment check; the relink gate already rejected
  // duplicates, so add() never silently collapses two requests.
  const placed = new Set<UUID>();
  const added = new Set<UUID>();
  /** Place the entry, first pulling in the missing half of any tool pair:
   *  a result's call goes immediately before it, a call's results
   *  immediately after — otherwise the written list still splits the pair.
   *  A dependency that was itself requested is left for its own turn in
   *  the loop below, so the requested order passes through verbatim. */
  const place = (entryUuid: UUID): void => {
    if (placed.has(entryUuid)) {
      return;
    }
    const entry = byUuid.get(entryUuid)!;
    if (isToolResultEntry(entry)) {
      const callUuid = entry.parentUuid as UUID; // validated above
      if (!requestedSet.has(callUuid)) {
        place(callUuid);
      }
    }
    placed.add(entryUuid);
    if (!requestedSet.has(entryUuid)) {
      added.add(entryUuid);
    }
    if (isToolCallEntry(entry)) {
      for (const result of resultsByCallUuid.get(entryUuid) ?? []) {
        if (!requestedSet.has(result)) {
          place(result);
        }
      }
    }
  };
  for (const entryUuid of requested) {
    place(entryUuid);
  }

  // Thinking-only API-message groups after completion: the loader drops such
  // turns whole (p19; see file comment), so their presented context would
  // silently diverge from the preserved list.
  for (const [apiMessageId, members] of assistantsByMessageId) {
    const included = members.filter((member) => placed.has(member));
    if (
      included.length > 0 &&
      included.every((member) => isThinkingOnlyEntry(byUuid.get(member)!))
    ) {
      return {
        ok: false,
        reason:
          `the list keeps only thinking entries of API message ` +
          `${apiMessageId} — the loader drops thinking-only turns whole; ` +
          "omit them explicitly",
      };
    }
  }
  // An id-less thinking-only assistant is its own group: every real
  // assistant entry records its API message id, but SessionEntry cannot
  // guarantee one, and the loader's sanitizer groups by
  // `apiMessageIdOf(entry) ?? uuid` — it would drop such an entry, so
  // accepting it here would silently diverge.
  for (const entryUuid of placed) {
    const entry = byUuid.get(entryUuid)!;
    if (
      entry.type === "assistant" &&
      (entry.message as { id?: string } | undefined)?.id === undefined &&
      isThinkingOnlyEntry(entry)
    ) {
      return {
        ok: false,
        reason:
          `thinking-only entry ${entryUuid} — the loader drops ` +
          "thinking-only turns whole; omit it explicitly",
      };
    }
  }
  return { ok: true, uuids: [...placed], added: [...added] };
}

/** The daemon state set-context shares with the rest of request handling:
 *  the reader/writer gate it takes exclusively, and the two slots it writes
 *  (the get-messages override, and query availability after restart
 *  failures). The concurrent-set-context policy flag stays at the dispatch
 *  site — it wraps this handler, not the other way around. */
export interface SetContextShared {
  gate: RwGate;
  installOverride(override: GetMessagesOverride): void;
  setQueryAvailable(available: boolean): void;
}

export function createSetContextHandler(
  deps: RequestHandlerDeps,
  shared: SetContextShared,
): (parsed: SetContextRequest) => Promise<SetContextResult> {
  const { events } = deps;

  return async (parsed: SetContextRequest): Promise<SetContextResult> => {
    const sessionId = events.agentState.sessionId;
    if (sessionId === undefined) {
      throw new Error("set-context: no session yet");
    }

    const releaseGate = await shared.gate.awaitExclusive();
    let fileMutated = false;
    let succeeded = false;
    // The post-change context tip carried by contextChanged: the value
    // get-entries' leaf computation reports after the change, set before
    // the restart (so a durable append broadcasts the right leaf even when
    // the restart then fails).
    let changedLeaf: TreeNodeRef | null = null;
    try {
      // Eligibility, checked under the gate: nothing running, nothing queued,
      // nothing delivered-but-unconfirmed. No implicit waiting — callers can
      // `clauctl wait --until idle` first.
      const state = events.agentState;
      if (
        state.activity !== "idle" ||
        state.queuedMessages.length > 0 ||
        state.deliveredMessages.length > 0
      ) {
        throw new Error(
          "set-context requires an idle assistant with an empty queue",
        );
      }
      const filePath = deps.sessionFilePath(sessionId);
      // A relinked leaf's newest on-disk entry is its boundary, so the flush
      // wait keys on viaBoundary ?? uuid.
      const stateLeaf = events.agentState.leaf;
      const entries = await readEntriesAfterStreamFlush(
        filePath,
        stateLeaf === undefined
          ? undefined
          : (stateLeaf.viaBoundary ?? stateLeaf.uuid),
      );
      const byUuid = entriesByUuid(entries);
      const contextTree = toContextTree(buildTree(entries, deps.log), byUuid);

      // Rewind is sugar for an explicit list (P9 a; see file comment): both
      // forms write a boundary through the same normalization and checks.
      // An empty uuids list without a summary is a deliberate context reset
      // (P10; see file comment): the boundary preserves nothing and the
      // loader honors it as an empty context.
      const { requested, summaryText } =
        "uuids" in parsed
          ? { requested: parsed.uuids, summaryText: parsed.summaryText }
          : {
              requested: [
                ...contextTree
                  .contextAt(parsed.rewindTo)
                  .map((ref) => ref.uuid),
                ...(parsed.append ?? []),
              ],
              summaryText: undefined,
            };
      const normalized = normalizePreservedUuids(requested, byUuid);
      if (!normalized.ok) {
        throw new Error(`set-context: ${normalized.reason}`);
      }
      // logicalParentUuid is the CLI's uuid-typed file field, so a branch
      // point X@B is recorded as bare X; the display tree re-derives the
      // exact occurrence from the list. No hidden set: the daemon builds no
      // display tree.
      const branchPoint = matchPreservedList(
        contextTree,
        normalized.uuids,
        summaryText !== undefined,
        contextTree.parentMap,
        new Set(),
      )?.branchPoint;
      const built = buildBoundaryEntries({
        sessionId: sessionId as UUID,
        cwd: deps.cwd,
        uuids: normalized.uuids,
        ...(summaryText !== undefined && { summaryText }),
        logicalParentUuid:
          branchPoint === undefined ? null : parseTreeNodeRef(branchPoint).uuid,
        version: events.agentState.claudeCodeVersion,
        preTokens: preTokensOf(events.agentState.lastUsage),
      });
      await deps.teardownQuery();
      appendSessionEntries(filePath, built.entries);
      fileMutated = true;

      // The append is durable, so the override and contextChanged leaf come
      // from a re-read of the file (its loader view) and are installed
      // before the restart, which may fail.
      const effectiveRefs = loadedContext(
        readSessionEntries(filePath),
        deps.log,
      );
      changedLeaf = effectiveRefs.at(-1) ?? null;
      shared.installOverride({
        chain: effectiveRefs.map((ref) => ref.uuid),
        installedAtLeaf: changedLeaf ?? undefined,
      });
      try {
        await deps.restartQuery(sessionId);
      } catch (error) {
        shared.setQueryAvailable(false);
        throw new Error(
          `query restart failed; retry set-context (boundary already appended): ${String(error)}`,
        );
      }
      shared.setQueryAvailable(true);
      succeeded = true;
      return normalized.added.length > 0
        ? { ...built.result, added: normalized.added }
        : built.result;
    } finally {
      // Watchers track file truth: broadcast whenever the file was mutated,
      // even if the restart then failed; the RPC itself still returns the
      // error (criterion 7).
      if (succeeded || fileMutated) {
        events.emit({
          kind: "contextChanged",
          request: parsed,
          leaf: changedLeaf,
        });
      }
      releaseGate();
    }
  };
}
