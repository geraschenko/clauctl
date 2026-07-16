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

import type { UUID } from "node:crypto";
import type { NonNullableUsage } from "@anthropic-ai/claude-agent-sdk";
import { effectiveChain } from "../effective-chain.ts";
import type {
  SetContextRequest,
  SetContextResult,
} from "../sdk-socket.ts";
import {
  appendSessionEntries,
  buildBoundaryEntries,
  readEntriesAfterStreamFlush,
  readSessionEntries,
  type SessionEntry,
} from "../session-file.ts";
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

  const handleRewind = async (
    rewindTo: UUID,
    context: {
      filePath: string;
      entries: SessionEntry[];
      sessionId: string;
      restartAndVerify: (expected: UUID[]) => Promise<void>;
      markMutated: () => void;
    },
  ): Promise<SetContextResult> => {
    const { filePath, entries, sessionId } = context;
    const targetIndex = entries.findIndex((entry) => entry.uuid === rewindTo);
    if (targetIndex === -1) {
      throw new Error(
        `set-context: rewindTo ${rewindTo} is not in the session file`,
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
    // siblings (e.g. a thinking entry) is untested.
    const apiMessageId = (target.message as { id?: string } | undefined)?.id;
    if (
      apiMessageId !== undefined &&
      entries
        .slice(targetIndex + 1)
        .some(
          (entry) =>
            (entry.message as { id?: string } | undefined)?.id === apiMessageId,
        )
    ) {
      throw new Error(
        "set-context: rewindTo must be the FINAL transcript entry of its assistant API message (a later entry shares its message.id)",
      );
    }

    // "Context as it was when the target first appeared": loader semantics on
    // the file truncated just after the target.
    const desired = effectiveChain(entries.slice(0, targetIndex + 1));
    const active = effectiveChain(entries);
    const targetPosition = active.indexOf(rewindTo);

    if (
      targetPosition !== -1 &&
      arraysEqual(desired, active.slice(0, targetPosition + 1))
    ) {
      // The desired chain truncates the active chain: resumeSessionAt gives
      // exactly these semantics (P2 d, P9 c; see file comment) with no file
      // mutation.
      await deps.teardownQuery();
      try {
        await deps.restartQuery(sessionId, rewindTo);
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
        installedAtLeafUuid: events.agentState.lastTranscriptUuid,
      });
      return {};
    }

    // Abandoned branch (unreachable by resumeSessionAt, P2 e) or a member of
    // a boundary's preserved uuids (reachable but with boundary-kept
    // semantics, P9 c): append a no-summary boundary listing the computed
    // chain (P9 a). System entries on the chain (e.g. turn_duration) carry no
    // context and are left off the preserved uuids.
    const messageUuids = desired.filter((uuid) => {
      const type = entries.find((entry) => entry.uuid === uuid)?.type;
      return type === "user" || type === "assistant";
    });
    const built = buildBoundaryEntries({
      sessionId: sessionId as UUID,
      cwd: deps.cwd,
      uuids: messageUuids,
      anchor: "boundary",
      logicalParentUuid: active.at(-1) ?? null,
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
      if (parsed.uuids.length === 0 && parsed.summaryText === undefined) {
        throw new Error(
          "set-context: empty uuids without summaryText — nothing to load",
        );
      }
      if (parsed.anchor === "summary" && parsed.summaryText === undefined) {
        throw new Error(
          'set-context: anchor "summary" requires summaryText — nothing to anchor on',
        );
      }
      if (new Set(parsed.uuids).size !== parsed.uuids.length) {
        throw new Error(
          "set-context: duplicate uuids — the loader silently skips the whole relink",
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
    try {
      // Eligibility, checked under the gate: nothing running, nothing queued,
      // nothing delivered-but-unconfirmed. No implicit waiting — callers can
      // wait-idle first.
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
      const entries = await readEntriesAfterStreamFlush(
        filePath,
        events.agentState.lastTranscriptUuid as UUID | undefined,
      );

      // Restart + verification shared by every file-mutating path. The
      // append is already durable, so contextChanged is broadcast (via
      // fileMutated in the finally) and the synthesize override installed
      // even when the restart or verification then fails: the file carries
      // the truth, and any later resume picks the boundary up.
      const restartAndVerify = async (expected: UUID[]): Promise<void> => {
        // One re-read serves the override and the verification below; the
        // file is quiescent between the append and the restarted Query's
        // first turn. The override carries the file's effective chain, not
        // `expected` — identical on success, and on a verification failure
        // get-messages still reflects the loader's actual view.
        const effective = effectiveChain(readSessionEntries(filePath));
        shared.installOverride({
          kind: "synthesize",
          chain: effective,
          installedAtLeafUuid: events.agentState.lastTranscriptUuid,
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
        const onDisk = new Set(
          entries.map((entry) => entry.uuid).filter((uuid) => uuid),
        );
        const missing = parsed.uuids.filter((uuid) => !onDisk.has(uuid));
        if (missing.length > 0) {
          throw new Error(
            `set-context: uuids not in the session file: ${missing.join(", ")}`,
          );
        }
        const anchor =
          parsed.summaryText === undefined
            ? "boundary"
            : (parsed.anchor ?? "summary");
        const built = buildBoundaryEntries({
          sessionId: sessionId as UUID,
          cwd: deps.cwd,
          uuids: parsed.uuids,
          ...(parsed.summaryText !== undefined && {
            summaryText: parsed.summaryText,
          }),
          anchor,
          logicalParentUuid: effectiveChain(entries).at(-1) ?? null,
          version: events.agentState.claudeCodeVersion,
          preTokens: preTokensOf(events.agentState.lastUsage),
        });
        await deps.teardownQuery();
        appendSessionEntries(filePath, built.entries);
        fileMutated = true;
        const summaryUuid = built.result.summaryUuid;
        const expected =
          summaryUuid === undefined
            ? parsed.uuids
            : anchor === "summary"
              ? [summaryUuid, ...parsed.uuids]
              : [...parsed.uuids, summaryUuid];
        await restartAndVerify(expected);
        result = built.result;
      } else {
        result = await handleRewind(parsed.rewindTo, {
          filePath,
          entries,
          sessionId,
          restartAndVerify,
          markMutated: () => {
            fileMutated = true;
          },
        });
      }
      succeeded = true;
      return result;
    } finally {
      // Watchers track file truth: broadcast whenever the file was mutated,
      // even if the restart then failed; the RPC itself still returns the
      // error (criterion 7).
      if (succeeded || fileMutated) {
        events.emit({ kind: "contextChanged", request: parsed });
      }
      releaseGate();
    }
  };
}
