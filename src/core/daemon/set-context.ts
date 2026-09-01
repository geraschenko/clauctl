/**
 * set-context semantics: the daemon's one destructive request. Reshapes the
 * agent's effective context by appending a compact-boundary entry (or, for a
 * tail rewind, restarting the Query at an earlier leaf with no file write) —
 * the mechanism derisked in docs/derisk/compact-boundary-injection/FINDINGS.md
 * and specified in docs/specs/session-tree-and-set-context.md.
 *
 * Probe ids in comments (e.g. P2 d, P9 c) cite the experiments in
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
  loadedContextUuids,
  toolCallIdsOf,
  toolGroupMaps,
} from "../tree/loader.ts";
import type { SetContextRequest, SetContextResult } from "../sdk-socket.ts";
import type { TreeNodeRef } from "../tree/nodes.ts";
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

const arraysEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

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
  /** The still-fresh get-messages override, if any — needed because a
   *  no-write rewind's context truth lives only in its filterTail override,
   *  not the file. */
  freshOverride(): GetMessagesOverride | undefined;
  installOverride(override: GetMessagesOverride): void;
  setQueryAvailable(available: boolean): void;
}

export function createSetContextHandler(
  deps: RequestHandlerDeps,
  shared: SetContextShared,
): (parsed: SetContextRequest) => Promise<SetContextResult> {
  const { events } = deps;

  const handleRewind = async (
    rewindTo: TreeNodeRef,
    context: {
      filePath: string;
      entries: SessionEntry[];
      sessionId: string;
      restartAndVerify: (expected: UUID[]) => Promise<void>;
      markMutated: () => void;
      setChangedLeaf: (leaf: TreeNodeRef) => void;
      /** Overrides the boundary's logicalParentUuid when set — the logical
       *  tip diverges from the file chain tip after a no-write rewind. */
      logicalTipOverride: UUID | undefined;
    },
  ): Promise<SetContextResult> => {
    const { filePath, entries, sessionId } = context;
    const targetIndex = entries.findIndex(
      (entry) => entry.uuid === rewindTo.uuid,
    );
    if (targetIndex === -1) {
      throw new Error(
        `set-context: rewindTo ${rewindTo.uuid} is not in the session file`,
      );
    }
    const target = entries[targetIndex]!;
    if (target.type !== "assistant") {
      throw new Error(
        `set-context: rewindTo must be an assistant entry, got type ${JSON.stringify(target.type)}`,
      );
    }
    // Only the FINAL transcript entry of an assistant API message is a valid
    // target: it keeps the chain answer-terminated with whole API messages —
    // resumeSessionAt and getSessionMessages behavior for mid-message
    // siblings (e.g. a thinking entry) is untested. Re-persisted copies (a
    // legal file shape; see cli-history-repersistence FINDINGS) share their
    // original's message.id without being later siblings — of the target
    // itself, or of its EARLIER siblings — so only an entry's first
    // occurrence counts.
    const firstOccurrence = new Set<number>();
    const seenUuids = new Set<UUID>();
    for (const [index, entry] of entries.entries()) {
      if (entry.uuid !== undefined && !seenUuids.has(entry.uuid)) {
        seenUuids.add(entry.uuid);
        firstOccurrence.add(index);
      }
    }
    const apiMessageId = (target.message as { id?: string } | undefined)?.id;
    if (
      apiMessageId !== undefined &&
      entries.some(
        (entry, index) =>
          index > targetIndex &&
          firstOccurrence.has(index) &&
          (entry.message as { id?: string } | undefined)?.id === apiMessageId,
      )
    ) {
      throw new Error(
        "set-context: rewindTo must be the FINAL transcript entry of its assistant API message (a later entry shares its message.id)",
      );
    }

    // The desired context per occurrence flavor, one loadedContext call
    // either way. viaBoundary absent — "context as it was when the target
    // first appeared": loader semantics on the file truncated just after
    // the target. viaBoundary present — a prefix of the context that
    // boundary installed: the chain of the file truncated at the NEXT
    // compact_boundary (or EOF), cut at the target uuid — the target is an
    // assistant entry, never the summary, so any post-block turns the
    // truncation keeps are discarded by the cut.
    let desired: UUID[];
    if (rewindTo.viaBoundary === undefined) {
      desired = loadedContextUuids(entries.slice(0, targetIndex + 1), deps.log);
    } else {
      const boundaryIndex = entries.findIndex(
        (entry) => entry.uuid === rewindTo.viaBoundary,
      );
      if (
        boundaryIndex === -1 ||
        entries[boundaryIndex]!.subtype !== "compact_boundary"
      ) {
        throw new Error(
          `set-context: rewindTo.viaBoundary ${rewindTo.viaBoundary} does not name a compact_boundary entry`,
        );
      }
      const nextBoundaryOffset = entries
        .slice(boundaryIndex + 1)
        .findIndex((entry) => entry.subtype === "compact_boundary");
      const installedChain = loadedContextUuids(
        nextBoundaryOffset === -1
          ? entries
          : entries.slice(0, boundaryIndex + 1 + nextBoundaryOffset),
        deps.log,
      );
      const targetPosition = installedChain.indexOf(rewindTo.uuid);
      if (targetPosition === -1) {
        throw new Error(
          `set-context: rewindTo ${rewindTo.uuid} is not on the context chain installed by boundary ${rewindTo.viaBoundary}`,
        );
      }
      desired = installedChain.slice(0, targetPosition + 1);
    }
    const activeRefs = loadedContext(entries, deps.log);
    const active = activeRefs.map((ref) => ref.uuid);
    const targetPosition = active.indexOf(rewindTo.uuid);

    if (
      targetPosition !== -1 &&
      arraysEqual(desired, active.slice(0, targetPosition + 1))
    ) {
      // The desired chain truncates the active chain: resumeSessionAt gives
      // exactly these semantics (P2 d, P9 c; see file comment) with no file
      // mutation. There is no file truth for this state (the file's chain
      // tip is the un-rewound leaf), so the post-change leaf is the rewind
      // target's occurrence on the active chain.
      const leaf = activeRefs[targetPosition]!;
      await deps.teardownQuery();
      try {
        await deps.restartQuery(sessionId, rewindTo.uuid);
      } catch (error) {
        shared.setQueryAvailable(false);
        throw new Error(
          `query restart failed; retry set-context: ${String(error)}`,
        );
      }
      shared.setQueryAvailable(true);
      shared.installOverride({
        kind: "filterTail",
        droppedUuids: new Set(active.slice(targetPosition + 1)),
        installedAtLeaf: leaf,
      });
      context.setChangedLeaf(leaf);
      return {};
    }

    // Abandoned branch (unreachable by resumeSessionAt, P2 e; see file
    // comment) or a member of a boundary's preserved uuids (reachable but
    // with boundary-kept semantics, P9 c; see file comment): append a
    // no-summary boundary listing the computed
    // chain (P9 a; see file comment). System entries on the chain (e.g.
    // turn_duration) carry no context and are left off the preserved uuids.
    const messageUuids = desired.filter((uuid) => {
      const type = entries.find((entry) => entry.uuid === uuid)?.type;
      return type === "user" || type === "assistant";
    });
    const built = buildBoundaryEntries({
      sessionId: sessionId as UUID,
      cwd: deps.cwd,
      uuids: messageUuids,
      anchor: "boundary",
      logicalParentUuid: context.logicalTipOverride ?? active.at(-1) ?? null,
      version: events.agentState.claudeCodeVersion,
      preTokens: preTokensOf(events.agentState.lastUsage),
    });
    await deps.teardownQuery();
    appendSessionEntries(filePath, built.entries);
    context.markMutated();
    await context.restartAndVerify(messageUuids);
    return built.result;
  };

  return async (parsed: SetContextRequest): Promise<SetContextResult> => {
    if ("uuids" in parsed) {
      // Empty uuids without a summary is a deliberate context reset (P10;
      // see file comment):
      // the appended boundary preserves nothing and the loader honors it as
      // an empty context.
      if (parsed.anchor === "summary" && parsed.summaryText === undefined) {
        throw new Error(
          'set-context: anchor "summary" requires summaryText — nothing to anchor on',
        );
      }
    }
    const sessionId = events.agentState.sessionId;
    if (sessionId === undefined) {
      throw new Error("set-context: no session yet");
    }

    const releaseGate = await shared.gate.awaitExclusive();
    let fileMutated = false;
    let succeeded = false;
    // The post-change context tip carried by contextChanged: the value
    // get-entries' leaf computation reports after the change. Set by every
    // path before its restart (so a durable append broadcasts the right
    // leaf even when the restart then fails).
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
      // Boundary anchoring: a fresh no-write rewind's context truth lives
      // only in its filterTail override — the file still carries the
      // un-rewound tail, and anchoring a new boundary there would
      // re-introduce that tail on the logical-history path
      // (root-to-leaf via logicalParentUuid, what the TUI renders). The
      // synthesize variant needs no adjustment: its chain IS file truth.
      const activeOverride = shared.freshOverride();
      const logicalTipOverride =
        activeOverride?.kind === "filterTail"
          ? activeOverride.installedAtLeaf?.uuid
          : undefined;

      // Restart + verification shared by every file-mutating path. The
      // append is already durable, so contextChanged is broadcast (via
      // fileMutated in the finally) and the synthesize override installed
      // even when the restart or verification then fails: the file carries
      // the truth, and any later resume picks the boundary up.
      const restartAndVerify = async (expected: UUID[]): Promise<void> => {
        // One re-read serves the override, the contextChanged leaf, and the
        // verification below; the file is quiescent between the append and
        // the restarted Query's first turn. The override carries the file's
        // effective chain, not `expected` — identical on success, and on a
        // verification failure get-messages still reflects the loader's
        // actual view.
        const effectiveRefs = loadedContext(
          readSessionEntries(filePath),
          deps.log,
        );
        const effective = effectiveRefs.map((ref) => ref.uuid);
        changedLeaf = effectiveRefs.at(-1) ?? null;
        shared.installOverride({
          kind: "synthesize",
          chain: effective,
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
        // This checks the loader's view of the FILE, not the live Query — a
        // streaming Query initializes on its first turn, so a bad resume can
        // still surface at the next turn. The check compares the effective
        // chain rather than asking the SDK: getSessionMessages picks its tip
        // as the LAST user/assistant leaf in file order across all dangling
        // leaves, so it reports the wrong chain for any boundary whose
        // preserved-uuids tip predates another leaf (abandoned branch tips,
        // orphaned summaries) — the CLI loader honors those boundaries
        // (P9 a/b; see file comment, wire-verified).
        // The check is structural: it catches torn or failed appends, but
        // not the CLI's inference-time normalization of authoring-rule
        // violations (orphan tool blocks, attachment uuids) — no file-reading
        // oracle can. Divergence is reported without rolling back the append
        // — boundaries stack, a subsequent set-context can fix it.
        if (!arraysEqual(effective, expected)) {
          throw new Error(
            "set-context verification failed: effective context " +
              `[${effective.join(", ")}] != expected [${expected.join(", ")}] ` +
              "(the appended boundary is kept; a subsequent set-context can fix it)",
          );
        }
      };

      let result: SetContextResult;
      if ("uuids" in parsed) {
        const normalized = normalizePreservedUuids(
          parsed.uuids,
          entriesByUuid(entries),
        );
        if (!normalized.ok) {
          throw new Error(`set-context: ${normalized.reason}`);
        }
        const anchor =
          parsed.summaryText === undefined
            ? "boundary"
            : (parsed.anchor ?? "summary");
        const built = buildBoundaryEntries({
          sessionId: sessionId as UUID,
          cwd: deps.cwd,
          uuids: normalized.uuids,
          ...(parsed.summaryText !== undefined && {
            summaryText: parsed.summaryText,
          }),
          anchor,
          logicalParentUuid:
            logicalTipOverride ??
            loadedContextUuids(entries, deps.log).at(-1) ??
            null,
          version: events.agentState.claudeCodeVersion,
          preTokens: preTokensOf(events.agentState.lastUsage),
        });
        await deps.teardownQuery();
        appendSessionEntries(filePath, built.entries);
        fileMutated = true;
        const summaryUuid = built.result.summaryUuid;
        const expected =
          summaryUuid === undefined
            ? normalized.uuids
            : anchor === "summary"
              ? [summaryUuid, ...normalized.uuids]
              : [...normalized.uuids, summaryUuid];
        await restartAndVerify(expected);
        result =
          normalized.added.length > 0
            ? { ...built.result, added: normalized.added }
            : built.result;
      } else {
        result = await handleRewind(parsed.rewindTo, {
          filePath,
          entries,
          sessionId,
          restartAndVerify,
          markMutated: () => {
            fileMutated = true;
          },
          setChangedLeaf: (leaf) => {
            changedLeaf = leaf;
          },
          logicalTipOverride,
        });
      }
      succeeded = true;
      return result;
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
