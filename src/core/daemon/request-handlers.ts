/**
 * Request *semantics* for sdk.sock: what each request type means, done to the
 * daemon's moving parts. The neighboring seams: sdk-server.ts is transport
 * (framing, hello, response routing) and knows nothing about request types;
 * event-hub.ts is state and knows nothing about requests; this module turns
 * one into effects on the other. Deliberately a shallow relocation of the
 * dispatch switch, not a deep module — the leverage is that daemon.ts reads
 * as a composition root, and request semantics are testable through fake
 * deps without a real daemon. The one deep resident is set-context: the
 * boundary/rewind semantics derisked in
 * docs/derisk/compact-boundary-injection/FINDINGS.md and specified in
 * docs/specs/session-tree-and-set-context.md.
 */

import type { UUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  getSessionMessages,
  type Query,
  type SDKUserMessage,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { buildTree } from "../build-tree.ts";
import type { PersistedOptions } from "../options.ts";
import {
  appendSessionEntries,
  buildBoundaryEntries,
  readSessionEntries,
  waitForEntryOnDisk,
  type SessionEntry,
} from "../session-file.ts";
import {
  applyMutation,
  isControlMutation,
  persistedOptionsAfter,
  runRead,
} from "../sdk-passthrough.ts";
import {
  parseSetContextRequest,
  type SdkControlMutation,
  type SdkRequestRecord,
  type SdkResponse,
  type SetContextRequest,
  type SetContextResult,
} from "../sdk-socket.ts";
import type { EventHub } from "./event-hub.ts";
import { RESPONSE_SENT, type SdkConnection } from "./sdk-server.ts";
import type { TurnQueue } from "./turn-queue.ts";

export interface RequestHandlerDeps {
  /** The current Query — replaced by set-context, so resolved per use. */
  getQuery(): Query;
  events: EventHub;
  /** Compact-path pushes only; ordinary messages go through
   *  events.deliverUserMessage. Replaced alongside the Query. */
  getTurnQueue(): TurnQueue;
  /** getSessionMessages dir. */
  cwd: string;
  /** Mutation persistence; the write itself is queued by daemon.ts. */
  getPersistedOptions(): PersistedOptions;
  setPersistedOptions(options: PersistedOptions): void;
  /** The session jsonl path for a session id (configDir + cwd baked in). */
  sessionFilePath(sessionId: string): string;
  /** Ends the TurnQueue and waits for the Query stream to complete — the
   *  SDK's cleanup awaits the child's exit (FINDINGS.md P7). */
  teardownQuery(): Promise<void>;
  /** Builds a fresh TurnQueue + Query resuming the session and rewires the
   *  daemon's reader loop onto it. */
  restartQuery(resumeSessionId: string, resumeSessionAt?: UUID): Promise<void>;
}

/**
 * Readers-writer gate serializing set-context (the writer) against everything
 * Query-bound. Request dispatch is deliberately concurrent, so an idle check
 * alone is a moment-in-time read; the gate guarantees no request touches the
 * old Query during teardown/replacement. While the writer holds (or awaits)
 * the gate, Query-bound arrivals error and file reads wait — so the shared
 * drain terminates.
 */
class QueryGate {
  private sharedCount = 0;
  private exclusive = false;
  private drainWaiter: (() => void) | undefined;
  private readonly sharedWaiters: Array<() => void> = [];

  private acquireShared(): () => void {
    this.sharedCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.sharedCount -= 1;
      if (this.sharedCount === 0) {
        this.drainWaiter?.();
      }
    };
  }

  /** Query-bound operations: error immediately during a context change. */
  sharedOrThrow(): () => void {
    if (this.exclusive) {
      throw new Error("context change in progress");
    }
    return this.acquireShared();
  }

  /** File reads: wait out a context change instead of erroring, so they never
   *  observe a half-done mutation. */
  async sharedWait(): Promise<() => void> {
    while (this.exclusive) {
      await new Promise<void>((resolve) => this.sharedWaiters.push(resolve));
    }
    return this.acquireShared();
  }

  /** set-context: drains in-flight Query operations; a concurrent context
   *  change errors instead of queueing. */
  async exclusiveOrThrow(): Promise<() => void> {
    if (this.exclusive) {
      throw new Error("context change in progress");
    }
    this.exclusive = true;
    while (this.sharedCount > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiter = resolve;
      });
      this.drainWaiter = undefined;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.exclusive = false;
      for (const waiter of this.sharedWaiters.splice(0)) {
        waiter();
      }
    };
  }
}

interface PreservedMessages {
  anchorUuid?: UUID;
  uuids: UUID[];
}

// Segment-only boundaries (compactMetadata.preservedSegment without
// preservedMessages, written by older CLI versions) are not modeled: they
// read as "no relink", so effectiveChain can differ from the loader on such
// organic sessions. Current CLIs write preservedMessages, and set-context
// only appends that form.

function preservedMessagesOf(
  boundary: SessionEntry,
): PreservedMessages | undefined {
  const metadata = boundary.compactMetadata as
    | { preservedMessages?: { anchorUuid?: UUID; uuids?: unknown } }
    | undefined;
  const preserved = metadata?.preservedMessages;
  if (preserved === undefined || !Array.isArray(preserved.uuids)) {
    return undefined;
  }
  return {
    ...(preserved.anchorUuid !== undefined && {
      anchorUuid: preserved.anchorUuid,
    }),
    uuids: preserved.uuids as UUID[],
  };
}

/** The boundary's companion summary entry: parented on the boundary and
 *  flagged isCompactSummary (native shape in both anchor variants). */
function summaryOf(
  entries: SessionEntry[],
  boundaryIndex: number,
): SessionEntry | undefined {
  const boundaryUuid = entries[boundaryIndex]!.uuid;
  return entries
    .slice(boundaryIndex + 1)
    .find(
      (entry) =>
        entry.parentUuid === boundaryUuid && entry.isCompactSummary === true,
    );
}

/**
 * The boundary's effective-parent map (spec "Concrete examples"): the
 * load-time relink as parent overrides. `uuids[i] → uuids[i-1]`,
 * `uuids[0] → anchorUuid`; in from-shape (anchor = the boundary's own uuid)
 * with a summary and a non-empty playlist, the summary's effective parent is
 * `uuids[last]` — the raw chain there runs summary → boundary and would skip
 * the playlist entirely, but the loader's from-shape context is
 * [uuids…, summary] (p2.b). With an empty playlist the summary keeps its raw
 * parent (the boundary) — the intended summary-only context.
 */
function effectiveParentMap(
  entries: SessionEntry[],
  boundaryIndex: number,
): Map<UUID, UUID> {
  const boundary = entries[boundaryIndex]!;
  const map = new Map<UUID, UUID>();
  const preserved = preservedMessagesOf(boundary);
  if (preserved === undefined) {
    return map;
  }
  const { anchorUuid, uuids } = preserved;
  for (let i = 1; i < uuids.length; i += 1) {
    map.set(uuids[i]!, uuids[i - 1]!);
  }
  if (uuids.length > 0 && anchorUuid !== undefined) {
    map.set(uuids[0]!, anchorUuid);
  }
  if (anchorUuid === boundary.uuid && uuids.length > 0) {
    const summaryUuid = summaryOf(entries, boundaryIndex)?.uuid;
    if (summaryUuid !== undefined) {
      map.set(summaryUuid, uuids[uuids.length - 1]!);
    }
  }
  return map;
}

/**
 * The effective context chain (root → tip) the loader would produce for this
 * entries list — pass a truncated list for "the context when entry X first
 * appeared". Mirrors loader semantics: only the LAST boundary applies
 * (stacked boundaries: last wins entirely, P3 m5); the walk takes mapped
 * parents first, raw `parentUuid` otherwise; any boundary entry is
 * transparent — reaching one (or an entry with no parent) ends the walk.
 */
export function effectiveChain(entries: SessionEntry[]): UUID[] {
  const byUuid = new Map<UUID, SessionEntry>();
  for (const entry of entries) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
    }
  }

  const boundaryIndex = entries.findLastIndex(
    (entry) => entry.subtype === "compact_boundary",
  );
  let map = new Map<UUID, UUID>();
  let tip: UUID | undefined;
  if (boundaryIndex === -1) {
    tip = entries.findLast((entry) => entry.uuid !== undefined)?.uuid;
  } else {
    const boundary = entries[boundaryIndex]!;
    map = effectiveParentMap(entries, boundaryIndex);
    const summaryUuid = summaryOf(entries, boundaryIndex)?.uuid;
    // Entries written after the boundary (its own summary aside) chain on
    // top of the relinked context; with none, the tip is the relinked
    // skeleton's own tip: [summary, uuids…] (up_to), [uuids…, summary]
    // (from), or [uuids…] (no summary).
    const post = entries
      .slice(boundaryIndex + 1)
      .filter(
        (entry) => entry.uuid !== undefined && entry.uuid !== summaryUuid,
      );
    if (post.length > 0) {
      tip = post.at(-1)!.uuid;
    } else {
      const preserved = preservedMessagesOf(boundary);
      const fromShape = preserved?.anchorUuid === boundary.uuid;
      tip =
        (fromShape || preserved === undefined || preserved.uuids.length === 0
          ? summaryUuid
          : undefined) ??
        preserved?.uuids.at(-1) ??
        summaryUuid;
    }
  }

  const chain: UUID[] = [];
  const seen = new Set<UUID>();
  let current = tip;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const entry = byUuid.get(current);
    if (entry === undefined || entry.subtype === "compact_boundary") {
      break;
    }
    chain.push(current);
    current = map.get(current) ?? entry.parentUuid ?? undefined;
  }
  chain.reverse();
  return chain;
}

const arraysEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * One override slot for get-messages, replaced by each successful
 * set-context:
 * - filterTail (no-write rewind): the session file still contains the
 *   superseded tail of the active chain; subtract those uuids from
 *   getSessionMessages output.
 * - synthesize (durable boundary append): getSessionMessages picks its tip as
 *   the latest user/assistant leaf in file order, so it reports the wrong
 *   chain for any playlist whose tip predates another dangling leaf (spec
 *   criterion 3 mechanism note); serve the chain straight from the session
 *   file instead.
 * Both variants are pinned to the transcript leaf they were installed at:
 * the next transcript write closes the synthesis window (getSessionMessages
 * agrees with the loader again) and makes the tail filter inert, so the slot
 * is dropped lazily when `lastTranscriptUuid` moves. Every transcript write
 * moves `lastTranscriptUuid`: the CLI echoes each appended user/assistant
 * entry on the stream with its transcript uuid, including host-pushed input
 * — the same echo that clears deliveredMessages (agent-state.ts fold).
 */
type GetMessagesOverride = (
  | { kind: "filterTail"; uuids: Set<string> }
  | { kind: "synthesize"; chain: UUID[] }
) & { installedAtLeafUuid: string | undefined };

/**
 * The synthesis window: the file's last boundary has no post-boundary
 * user/assistant entries besides its own summary. Returns the chain to
 * synthesize while the window is open, undefined otherwise. Being purely
 * file-derived, this also reconstructs the window at daemon startup — unlike
 * a no-write rewind, which the file carries no record of (criterion 8).
 */
function synthesizeWindowChain(entries: SessionEntry[]): UUID[] | undefined {
  const boundaryIndex = entries.findLastIndex(
    (entry) => entry.subtype === "compact_boundary",
  );
  if (boundaryIndex === -1) {
    return undefined;
  }
  const summaryUuid = summaryOf(entries, boundaryIndex)?.uuid;
  const windowClosed = entries
    .slice(boundaryIndex + 1)
    .some(
      (entry) =>
        (entry.type === "user" || entry.type === "assistant") &&
        entry.uuid !== summaryUuid,
    );
  return windowClosed ? undefined : effectiveChain(entries);
}

/** getSessionMessages' runtime objects also carry `timestamp`, absent from
 *  the SDK's declared SessionMessage type; synthesized output matches the
 *  wire shape. */
type SessionMessageOnWire = SessionMessage & { timestamp?: string };

/** The get-messages response for a synthesize override: the chain's entries
 *  mapped to SessionMessage shape, mirroring the SDK's own mapping and
 *  filters (user/assistant only, isMeta/isSidechain excluded,
 *  parent_tool_use_id always null in getSessionMessages output). */
function synthesizeMessages(
  filePath: string,
  chain: UUID[],
): SessionMessageOnWire[] {
  const byUuid = new Map<UUID, SessionEntry>();
  for (const entry of readSessionEntries(filePath)) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
    }
  }
  const messages: SessionMessageOnWire[] = [];
  for (const uuid of chain) {
    const entry = byUuid.get(uuid);
    if (
      entry === undefined ||
      (entry.type !== "user" && entry.type !== "assistant") ||
      entry.isMeta === true ||
      entry.isSidechain === true
    ) {
      continue;
    }
    messages.push({
      type: entry.type,
      uuid,
      session_id: entry.sessionId as string,
      message: entry.message,
      parent_tool_use_id: null,
      ...(typeof entry.timestamp === "string" && {
        timestamp: entry.timestamp,
      }),
    });
  }
  return messages;
}

function startupOverride(
  deps: RequestHandlerDeps,
): GetMessagesOverride | undefined {
  const sessionId = deps.events.agentState.sessionId;
  if (sessionId === undefined) {
    return undefined;
  }
  const filePath = deps.sessionFilePath(sessionId);
  if (!existsSync(filePath)) {
    return undefined;
  }
  const chain = synthesizeWindowChain(readSessionEntries(filePath));
  if (chain === undefined) {
    return undefined;
  }
  return {
    kind: "synthesize",
    chain,
    installedAtLeafUuid: deps.events.agentState.lastTranscriptUuid,
  };
}

export function createRequestHandler(
  deps: RequestHandlerDeps,
): (request: SdkRequestRecord, connection: SdkConnection) => Promise<unknown> {
  const { events } = deps;
  const gate = new QueryGate();

  // After a restart failure the daemon has no live Query; Query-bound
  // requests error until a subsequent set-context (or daemon restart)
  // reconstructs it. File reads keep working.
  let queryUnavailable = false;

  // Startup reconstruction (criterion 3): a daemon that (re)starts inside the
  // synthesis window must keep synthesizing — one session-file read here
  // identifies it. Only synthesize is reconstructible; a no-write rewind is
  // not durable until the next turn (criterion 8): the file carries no
  // record of it, so if the daemon exits first, a later resume sees the
  // un-rewound chain.
  let override: GetMessagesOverride | undefined = startupOverride(deps);

  /** Query-bound operations: gate shared, and refuse while no Query is up. */
  const acquireQuery = (): (() => void) => {
    if (queryUnavailable) {
      throw new Error("query restart failed; retry set-context");
    }
    return gate.sharedOrThrow();
  };

  const controlApplied = (record: SdkRequestRecord): void => {
    // The rest-over-a-union needs the cast; the payload is the request as
    // received, minus the transport id.
    const { id: _id, ...request } = record as SdkControlMutation & {
      id: string;
    };
    events.emit({
      kind: "controlApplied",
      request: request as SdkControlMutation,
    });
  };

  // Request dispatch is deliberately concurrent (a pending wait-idle must not
  // block the interrupt that would resolve it), so the mutation branch's
  // read-modify-write of the persisted options — spanning awaits — would
  // lose updates if two mutations were in flight. Chaining restores the actor
  // property for mutations only; they never wait on daemon state, so the
  // chain cannot deadlock.
  let mutationChain: Promise<unknown> = Promise.resolve();

  /** The current session's jsonl entries, after waiting for everything the
   *  daemon has already reported on the event stream to be on disk (read
   *  consistency; the leaf uuid is unset when no turn has run this daemon
   *  lifetime — the file is quiescent then). */
  const readCurrentEntries = async (
    sessionId: string,
  ): Promise<{ filePath: string; entries: SessionEntry[] }> => {
    const filePath = deps.sessionFilePath(sessionId);
    const leafUuid = events.agentState.lastTranscriptUuid;
    if (leafUuid !== undefined) {
      await waitForEntryOnDisk(filePath, leafUuid as UUID);
    }
    return { filePath, entries: readSessionEntries(filePath) };
  };

  const handleSetContext = async (
    parsed: SetContextRequest,
  ): Promise<SetContextResult> => {
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
          "set-context: duplicate uuids — the loader silently skips the whole relink (P3 m4)",
        );
      }
    }
    const sessionId = events.agentState.sessionId;
    if (sessionId === undefined) {
      throw new Error("set-context: no session yet");
    }

    const releaseGate = await gate.exclusiveOrThrow();
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
      const { filePath, entries } = await readCurrentEntries(sessionId);

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
        override = {
          kind: "synthesize",
          chain: effective,
          installedAtLeafUuid: events.agentState.lastTranscriptUuid,
        };
        try {
          await deps.restartQuery(sessionId);
        } catch (error) {
          queryUnavailable = true;
          throw new Error(
            `query restart failed; retry set-context (boundary already appended): ${String(error)}`,
          );
        }
        queryUnavailable = false;
        // This checks the loader's view of the FILE, not the live Query — a
        // streaming Query initializes on its first turn, so a bad resume can
        // still surface at the next turn. The check compares the effective
        // chain rather than asking the SDK: getSessionMessages picks its tip
        // as the LAST user/assistant leaf in file order across all dangling
        // leaves, so it reports the wrong chain for any playlist whose tip
        // predates another leaf (abandoned branch tips, orphaned summaries)
        // — the CLI loader honors those playlists (P9 a/b, wire-verified).
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
      throw new Error(`set-context: rewindTo ${rewindTo} is not in the session file`);
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
      // exactly these semantics (P2 d, P9 c) with no file mutation.
      await deps.teardownQuery();
      try {
        await deps.restartQuery(sessionId, rewindTo);
      } catch (error) {
        queryUnavailable = true;
        throw new Error(
          `query restart failed; retry set-context: ${String(error)}`,
        );
      }
      queryUnavailable = false;
      override = {
        kind: "filterTail",
        uuids: new Set(active.slice(targetPosition + 1)),
        installedAtLeafUuid: events.agentState.lastTranscriptUuid,
      };
      return {};
    }

    // Abandoned branch (unreachable by resumeSessionAt, P2 e) or boundary
    // playlist member (reachable but with boundary-kept semantics, P9 c):
    // append a no-summary boundary listing the computed chain (P9 a).
    // System entries on the chain (e.g. turn_duration) carry no context and
    // are left off the playlist.
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
    });
    await deps.teardownQuery();
    appendSessionEntries(filePath, built.entries);
    context.markMutated();
    await context.restartAndVerify(messageUuids);
    return built.result;
  };

  return async (
    request: SdkRequestRecord,
    connection: SdkConnection,
  ): Promise<unknown> => {
    switch (request.type) {
      case "query": {
        const releaseQuery = acquireQuery();
        try {
          const content = request.content;
          const trimmed = typeof content === "string" ? content.trim() : "";
          if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
            // Compaction is only valid while Idle; never queued behind turns.
            if (events.agentState.activity !== "idle") {
              throw new Error("/compact requires an idle assistant");
            }
            const message: SDKUserMessage = {
              type: "user",
              message: { role: "user", content },
              parent_tool_use_id: null,
            };
            // Compaction deliberately bypasses the queue model: pushed to the
            // TurnQueue directly and announced via its own event.
            deps.getTurnQueue().push(message);
            events.emit({ kind: "compactSent", message });
            return undefined;
          }
          const message: SDKUserMessage = {
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
            ...(request.priority !== undefined && {
              priority: request.priority,
            }),
            ...(request.shouldQuery === false && { shouldQuery: false }),
          };
          events.deliverUserMessage(message);
          // The response makes no delivery claim: a demotable message's fate
          // is unknown at accept time, and blocking until the next boundary
          // could hang for minutes. The queued/dequeued events on the stream
          // are the truth.
          return undefined;
        } finally {
          releaseQuery();
        }
      }
      case "interrupt": {
        const releaseQuery = acquireQuery();
        try {
          await deps.getQuery().interrupt();
          events.emit({ kind: "interruptSent" });
          return undefined;
        } finally {
          releaseQuery();
        }
      }
      case "wait-idle":
        await events.whenIdle();
        return undefined;
      case "get-messages": {
        const release = await gate.sharedWait();
        try {
          // Valid before the first init because the hub is seeded (on
          // revival, with the last recorded session).
          const sessionId = events.agentState.sessionId;
          if (sessionId === undefined) {
            return [];
          }
          if (
            override !== undefined &&
            override.installedAtLeafUuid !==
              events.agentState.lastTranscriptUuid
          ) {
            override = undefined;
          }
          const active = override;
          if (active?.kind === "synthesize") {
            return synthesizeMessages(
              deps.sessionFilePath(sessionId),
              active.chain,
            );
          }
          const messages = await getSessionMessages(sessionId, {
            dir: deps.cwd,
          });
          return active === undefined
            ? messages
            : messages.filter((message) => !active.uuids.has(message.uuid));
        } finally {
          release();
        }
      }
      case "get-entries":
      case "get-tree": {
        const release = await gate.sharedWait();
        try {
          const sessionId = events.agentState.sessionId;
          if (sessionId === undefined) {
            throw new Error(`${request.type}: no session yet`);
          }
          const { entries } = await readCurrentEntries(sessionId);
          return request.type === "get-entries" ? entries : buildTree(entries);
        } finally {
          release();
        }
      }
      case "set-context":
        // The socket casts untrusted JSON; the one destructive command is
        // parsed explicitly before any teardown.
        return await handleSetContext(
          parseSetContextRequest(request as unknown as Record<string, unknown>),
        );
      case "subscribe": {
        // State capture, response write, and sink attach happen in one
        // synchronous section, so the seed is exact: no event is lost or
        // duplicated between the response line and the first pushed event.
        // The generic respond path runs in a later microtask — an event
        // emitted in between would hit the wire before the response — so this
        // handler writes its own response and returns RESPONSE_SENT.
        const response: SdkResponse = {
          id: request.id,
          ok: true,
          data: events.agentState,
        };
        connection.write(`${JSON.stringify(response)}\n`);
        const unsubscribe = events.subscribe((line) => connection.write(line));
        connection.onClose(unsubscribe);
        return RESPONSE_SENT;
      }
    }
    // Everything else is the Query passthrough (DECISION-4), delegated to
    // sdk-passthrough.ts: mutations emit controlApplied and persist per
    // DECISION-5; reads emit nothing.
    if (isControlMutation(request)) {
      const releaseQuery = acquireQuery();
      const run = async (): Promise<unknown> => {
        const data = await applyMutation(deps.getQuery(), request);
        controlApplied(request);
        const persisted = await persistedOptionsAfter(
          request,
          deps.getPersistedOptions(),
        );
        if (persisted !== undefined) {
          deps.setPersistedOptions(persisted);
        }
        return data;
      };
      // Run after the previous mutation regardless of its outcome; a failed
      // mutation rejects its own requester without poisoning the chain.
      const result = mutationChain.then(run, run);
      mutationChain = result.catch(() => undefined);
      try {
        return await result;
      } finally {
        releaseQuery();
      }
    }
    const releaseQuery = acquireQuery();
    try {
      return await runRead(deps.getQuery(), request);
    } finally {
      releaseQuery();
    }
  };
}
