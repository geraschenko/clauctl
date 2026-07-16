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
import { buildTree } from "../build-tree.ts";
import type { PersistedOptions } from "../options.ts";
import {
  readEntriesAfterStreamFlush,
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
    events.agentState.lastTranscriptUuid,
  );

  const handleSetContext = createSetContextHandler(deps, {
    gate,
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
        const release = await gate.awaitShared();
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
            : messages.filter(
                (message) => !active.droppedUuids.has(message.uuid),
              );
        } finally {
          release();
        }
      }
      case "get-entries":
      case "get-tree": {
        const release = await gate.awaitShared();
        try {
          const sessionId = events.agentState.sessionId;
          if (sessionId === undefined) {
            throw new Error(`${request.type}: no session yet`);
          }
          // Waiting on the last stream-reported leaf gives read consistency
          // across the CLI's flush lag; the leaf uuid is unset when no turn
          // has run this daemon lifetime — the file is quiescent then.
          const entries = await readEntriesAfterStreamFlush(
            deps.sessionFilePath(sessionId),
            events.agentState.lastTranscriptUuid as UUID | undefined,
          );
          return request.type === "get-entries" ? entries : buildTree(entries);
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
