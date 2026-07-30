/**
 * Request *semantics* for sdk.sock: what each request type means, done to the
 * daemon's moving parts. The neighboring seams: sdk-server.ts is transport
 * (framing, hello, response routing) and knows nothing about request types;
 * event-hub.ts is state and knows nothing about requests; this module turns
 * one into effects on the other. Deliberately a shallow relocation of the
 * dispatch switch, not a deep module — the leverage is that daemon.ts reads
 * as a composition root, and request semantics are testable through fake
 * deps without a real daemon. The deep request implementations live in
 * sibling modules: set-context.ts (boundary/rewind semantics) and
 * get-messages.ts (the override machinery keeping get-messages loader-true).
 */

import type { UUID } from "node:crypto";
import {
  getSessionMessages,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { treeNodeRefsEqual, type SessionSnapshot } from "../tree/nodes.ts";
import { loadedContext } from "../tree/loader.ts";
import { settingsSeed, type PersistedOptions } from "../options.ts";
import { readSessionEntries, type SessionEntry } from "../session/file.ts";
import {
  readEntriesAfterStreamFlush,
  waitForEntry,
} from "../session/entry-stream.ts";
import {
  applyMutation,
  isControlMutation,
  isControlRead,
  persistedOptionsAfter,
  runRead,
} from "../sdk-passthrough.ts";
import {
  parseSetContextRequest,
  type SdkControlApplied,
  type SdkControlMutation,
  type SdkRequestRecord,
  type SdkResponse,
} from "../sdk-socket.ts";
import type { EventHub } from "./event-hub.ts";
import {
  startupOverride,
  synthesizeMessages,
  type GetMessagesOverride,
} from "./get-messages.ts";
import { RwGate } from "./rw-gate.ts";
import { RESPONSE_SENT, type SdkConnection } from "./sdk-server.ts";
import { createSetContextHandler } from "./set-context.ts";
import type { TurnQueue } from "./turn-queue.ts";

export interface RequestHandlerDeps {
  /** The current Query — replaced by set-context, so resolved per use. */
  getQuery(): Query;
  events: EventHub;
  /** The daemon's one startup session-file read (undefined when no session
   *  file exists yet); also feeds the EventHub seed in daemon.ts. */
  startupEntries?: SessionEntry[];
  /** Compact-path pushes only; ordinary messages go through
   *  events.deliverUserMessage. Replaced alongside the Query. */
  getTurnQueue(): TurnQueue;
  /** getSessionMessages dir. */
  cwd: string;
  /** The daemon log; the sink for corrupt-session-file diagnostics. */
  log(message: string): void;
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
 * The controlApplied payload for a mutation (see SdkControlApplied): an
 * apply-flag-settings `effortLevel: null` clears the flag tier, so the
 * concrete post-clear level is resolved here — the same precedence as the
 * daemon's AgentState seed: an explicit spawn `--effort` wins, else the
 * settings cascade. Null survives only when neither specifies a level (the
 * CLI then uses its model-dependent default, which clauctl does not model).
 */
async function appliedRequest(
  request: SdkControlMutation,
  persisted: PersistedOptions,
  cwd: string,
): Promise<SdkControlApplied> {
  if (
    request.type !== "apply-flag-settings" ||
    request.settings.effortLevel !== null
  ) {
    return request;
  }
  const settings = await settingsSeed(persisted, cwd);
  return {
    ...request,
    settings: {
      ...request.settings,
      effortLevel: persisted.effort ?? settings.effortLevel ?? null,
    },
  };
}

export function createRequestHandler(
  deps: RequestHandlerDeps,
): (request: SdkRequestRecord, connection: SdkConnection) => Promise<unknown> {
  const { events } = deps;
  // Serializes set-context (the writer) against everything Query-bound.
  // Request dispatch is deliberately concurrent, so an idle check alone is a
  // moment-in-time read; the gate guarantees no request touches the old Query
  // during teardown/replacement. While set-context holds (or awaits) the
  // gate, Query-bound arrivals error and file reads wait.
  const gate = new RwGate();
  // Daemon policy, separate from the gate: a concurrent set-context errors
  // instead of queueing. Checked-and-set synchronously, so two arrivals
  // cannot both pass.
  let contextChangeInProgress = false;

  // After a restart failure the daemon has no live Query; Query-bound
  // requests error until a subsequent set-context (or daemon restart)
  // reconstructs it. File reads keep working.
  let queryAvailable = true;

  // Startup reconstruction (criterion 3): a daemon that (re)starts inside the
  // synthesis window must keep synthesizing — the startup entries identify
  // it. Only synthesize is reconstructible; a no-write rewind is not durable
  // until the next turn (criterion 8): the file carries no record of it, so
  // if the daemon exits first, a later resume sees the un-rewound chain.
  let override: GetMessagesOverride | undefined = startupOverride(
    deps.startupEntries,
    events.agentState.leaf,
    deps.log,
  );

  /** The get-messages override, dropped lazily once stale: the next transcript
   * write moves leaf, closing the window it corrected for. Shared
   * by get-messages and get-entries so both report the same context tip. */
  const freshOverride = (): GetMessagesOverride | undefined => {
    if (
      override !== undefined &&
      !treeNodeRefsEqual(override.installedAtLeaf, events.agentState.leaf)
    ) {
      override = undefined;
    }
    return override;
  };

  const handleSetContext = createSetContextHandler(deps, {
    gate,
    freshOverride,
    installOverride: (next) => {
      override = next;
    },
    setQueryAvailable: (available) => {
      queryAvailable = available;
    },
  });

  /** Query-bound operations: gate shared, and refuse while no Query is up.
   *  The flag check comes first so its message reaches the client; the
   *  gate's own tryShared refusal is unreachable while the flag is honest
   *  (set-context only holds the gate inside its flag window). */
  const acquireQuery = (): (() => void) => {
    if (!queryAvailable) {
      throw new Error("query restart failed; retry set-context");
    }
    if (contextChangeInProgress) {
      throw new Error("context change in progress");
    }
    return gate.tryShared();
  };

  const controlApplied = async (record: SdkRequestRecord): Promise<void> => {
    // The rest-over-a-union needs the cast; the payload is the request as
    // received, minus the transport id.
    const { id: _id, ...request } = record as SdkControlMutation & {
      id: string;
    };
    events.emit({
      kind: "controlApplied",
      request: await appliedRequest(
        request as SdkControlMutation,
        deps.getPersistedOptions(),
        deps.cwd,
      ),
    });
  };

  // Request dispatch is deliberately concurrent (a get-messages blocked on a
  // transcript flush must not stall the interrupt that would end the turn),
  // so the mutation branch's
  // read-modify-write of the persisted options — spanning awaits — would
  // lose updates if two mutations were in flight. Chaining restores the actor
  // property for mutations only; they never wait on daemon state, so the
  // chain cannot deadlock.
  let mutationChain: Promise<unknown> = Promise.resolve();

  return async (
    request: SdkRequestRecord,
    connection: SdkConnection,
  ): Promise<unknown> => {
    switch (request.type) {
      case "prompt": {
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
              // SDK 0.3.211 treats absent origin as unattributed at strict
              // human-input trust gates; this request came from the user CLI.
              origin: { kind: "human" },
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
            // SDK 0.3.211 treats absent origin as unattributed at strict
            // human-input trust gates; sdk.sock query requests are user input.
            origin: { kind: "human" },
            ...(request.priority !== undefined && {
              priority: request.priority,
            }),
            ...(request.shouldQuery === false && { shouldQuery: false }),
          };
          // An acceptance receipt, not a delivery claim: a demotable
          // message's fate is unknown at accept time, and blocking until the
          // next boundary could hang for minutes. The queued/dequeued events
          // on the stream are the truth; the id lets the submitter recognize
          // its own dequeue there.
          return { id: events.deliverUserMessage(message) };
        } finally {
          releaseQuery();
        }
      }
      case "interrupt": {
        const releaseQuery = acquireQuery();
        try {
          const receipt = await deps.getQuery().interrupt();
          events.emit({ kind: "interruptSent" });
          // SDK 0.3.211 returns the still-queued receipt when the bundled CLI
          // advertises interrupt_receipt_v1; preserve the Query passthrough.
          return receipt;
        } finally {
          releaseQuery();
        }
      }
      case "get-messages": {
        const release = await gate.awaitShared();
        try {
          // Valid before the first init because the hub is seeded (on
          // revival, with the last recorded session).
          const sessionId = events.agentState.sessionId;
          if (sessionId === undefined) {
            return [];
          }
          // The leaf flush gate covers BOTH response paths: getSessionMessages
          // reads the same file, with the same lag. A relinked leaf's newest
          // on-disk entry is its boundary, so the wait keys on
          // viaBoundary ?? uuid; an unset leaf has nothing to wait for.
          const filePath = deps.sessionFilePath(sessionId);
          const leaf = events.agentState.leaf;
          if (leaf !== undefined) {
            await waitForEntry(filePath, leaf.viaBoundary ?? leaf.uuid);
          }
          const active = freshOverride();
          if (active?.kind === "synthesize") {
            return synthesizeMessages(
              readSessionEntries(filePath),
              active.chain,
            );
          }
          const messages = await getSessionMessages(sessionId, {
            dir: deps.cwd,
          });
          return active === undefined
            ? messages
            : messages.filter(
                (message) => !active.droppedUuids.has(message.uuid),
              );
        } finally {
          release();
        }
      }
      case "get-entries": {
        const release = await gate.awaitShared();
        try {
          // Valid before the first init because the hub is seeded (on
          // revival, with the last recorded session); a truly fresh agent has
          // no history, so an empty snapshot — matching get-messages' [].
          const sessionId = events.agentState.sessionId;
          if (sessionId === undefined) {
            const empty: SessionSnapshot = { entries: [], leaf: null };
            return empty;
          }
          // Waiting on the last stream-reported leaf gives read consistency
          // across the CLI's flush lag; a relinked leaf's newest on-disk
          // entry is its boundary, so the wait keys on viaBoundary ?? uuid.
          // The leaf is unset when no turn has run this daemon lifetime —
          // the file is quiescent then.
          const stateLeaf = events.agentState.leaf;
          const entries = await readEntriesAfterStreamFlush(
            deps.sessionFilePath(sessionId),
            stateLeaf === undefined
              ? undefined
              : (stateLeaf.viaBoundary ?? stateLeaf.uuid),
          );
          // The snapshot leaf is the effective-context tip, minus a live
          // filterTail override's dropped uuids (a no-write rewind moves the
          // leaf to the rewind target; the synthesize variant needs nothing —
          // the re-read file already reflects the appended boundary).
          const active = freshOverride();
          const chain =
            active?.kind === "filterTail"
              ? loadedContext(entries, deps.log).filter(
                  (ref) => !active.droppedUuids.has(ref.uuid),
                )
              : loadedContext(entries, deps.log);
          const snapshot: SessionSnapshot = {
            entries,
            leaf: chain.at(-1) ?? null,
          };
          return snapshot;
        } finally {
          release();
        }
      }
      case "set-context": {
        // The socket casts untrusted JSON; the one destructive command is
        // parsed explicitly before any teardown.
        const parsed = parseSetContextRequest(
          request as unknown as Record<string, unknown>,
        );
        if (contextChangeInProgress) {
          throw new Error("context change in progress");
        }
        contextChangeInProgress = true;
        try {
          return await handleSetContext(parsed);
        } finally {
          contextChangeInProgress = false;
        }
      }
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
        await controlApplied(request);
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
    // The socket casts untrusted JSON, so an unrecognized type (e.g. a legacy
    // request from an old CLI) reaches this point despite the exhaustive
    // static types; reject it explicitly — runRead's switch has no default,
    // so falling through would answer `ok: true` for a request the daemon
    // never performed.
    if (!isControlRead(request)) {
      throw new Error(
        `unknown request type: ${(request as { type: string }).type}`,
      );
    }
    const releaseQuery = acquireQuery();
    try {
      return await runRead(deps.getQuery(), request);
    } finally {
      releaseQuery();
    }
  };
}
