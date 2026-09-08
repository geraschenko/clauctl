/**
 * Request *semantics* of the clauctl protocol: what each request type means, done to the
 * daemon's moving parts. The neighboring seams: protocol-server.ts is transport
 * (framing, hello, response routing) and knows nothing about request types;
 * event-hub.ts is state and knows nothing about requests; this module turns
 * one into effects on the other. Deliberately a shallow relocation of the
 * dispatch switch, not a deep module — the leverage is that daemon.ts reads
 * as a composition root, and request semantics are testable through fake
 * deps without a real daemon. The deep request implementations live in
 * sibling module set-context.ts (boundary/rewind semantics).
 */

import type { UUID } from "node:crypto";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isIdle, settled } from "../agent-state/index.ts";
import { settingsSeed, type PersistedOptions } from "../options.ts";
import type { SessionEntry } from "../session/file.ts";
import {
  applyMutation,
  persistedOptionsAfter,
  runRead,
} from "./sdk-passthrough.ts";
import {
  ENTRY_PAYLOADS,
  isControlMutation,
  isControlRead,
  parseSetContextRequest,
  type GetContextResponse,
  type EntryPayload,
  isGetEntriesByUuids,
  type SdkControlApplied,
  type SdkControlMutation,
  type ProtocolRequestRecord,
  type ProtocolResponse,
  type GetEntriesResponse,
  type SubscribeAttachment,
} from "../protocol/index.ts";
import type { EventHub } from "./event-hub.ts";
import {
  validatePermissionResult,
  type PermissionBroker,
} from "./permission-broker.ts";
import type { RwGate } from "./rw-gate.ts";
import { RESPONSE_SENT, type ProtocolConnection } from "./protocol-server.ts";
import { createSetContextHandler, type SetContextDeps } from "./set-context.ts";
import type { TurnQueue } from "./turn-queue.ts";

export interface RequestHandlerDeps extends SetContextDeps {
  /** The current Query — replaced by set-context, so resolved per use. */
  getQuery(): Query;
  /** Compact-path pushes only; ordinary messages go through
   *  events.deliverUserMessage. Replaced alongside the Query. */
  getTurnQueue(): TurnQueue;
  /** The daemon log; the sink for corrupt-session-file diagnostics. */
  log(message: string): void;
  /** Mutation persistence; the write itself is queued by daemon.ts. */
  getPersistedOptions(): PersistedOptions;
  setPersistedOptions(options: PersistedOptions): void;
  /** Register a live attacher; returns the deregister, wired to connection
   *  close. Implemented by daemon.ts (record write + audit). */
  registerAttachment(info: SubscribeAttachment): () => void;
  /** The request gate, shared with the tracked log's switch worker and the
   *  shutdown drain (daemon.ts owns it). */
  gate: RwGate;
  /** Pending permission asks (daemon.ts owns it; the Query's canUseTool
   *  feeds it). */
  permissionBroker: PermissionBroker;
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

function parseEntryPayload(value: unknown): EntryPayload {
  if (!ENTRY_PAYLOADS.includes(value as EntryPayload)) {
    throw new Error(
      `payload must be one of ${ENTRY_PAYLOADS.join("/")}, got ${JSON.stringify(value)}`,
    );
  }
  return value as EntryPayload;
}

/** Requests served from the tracker (spec, Data flow 4/5): settle outside
 *  the gate, acquire, and re-check — a switch or set-context that landed
 *  while waiting for the gate may have unsettled the state again. */
async function acquireSettled(
  events: EventHub,
  acquire: () => Promise<() => void>,
): Promise<() => void> {
  while (true) {
    await events.whenSettled();
    const release = await acquire();
    if (settled(events.agentState)) {
      return release;
    }
    release();
  }
}

export function createRequestHandler(
  deps: RequestHandlerDeps,
): (
  request: ProtocolRequestRecord,
  connection: ProtocolConnection,
) => Promise<unknown> {
  const { events, gate } = deps;
  // The gate serializes set-context (the writer) against everything
  // Query-bound. Request dispatch is deliberately concurrent, so an idle
  // check alone is a moment-in-time read; the gate guarantees no request
  // touches the old Query during teardown/replacement. While set-context
  // holds (or awaits) the gate, Query-bound arrivals error and file reads
  // wait.
  // Daemon policy, separate from the gate: a concurrent set-context errors
  // instead of queueing. Checked-and-set synchronously, so two arrivals
  // cannot both pass.
  let contextChangeInProgress = false;

  // After a restart failure the daemon has no live Query; Query-bound
  // requests error until a subsequent set-context (or daemon restart)
  // reconstructs it. File reads keep working.
  let queryAvailable = true;

  const handleSetContext = createSetContextHandler(deps, {
    acquireSettledExclusive: () =>
      acquireSettled(events, () => gate.awaitExclusive()),
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

  const controlApplied = async (
    record: ProtocolRequestRecord,
  ): Promise<void> => {
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

  // Request dispatch is deliberately concurrent (a get-context blocked on a
  // transcript flush must not stall the interrupt that would end the turn),
  // so the mutation branch's
  // read-modify-write of the persisted options — spanning awaits — would
  // lose updates if two mutations were in flight. Chaining restores the actor
  // property for mutations only; they never wait on daemon state, so the
  // chain cannot deadlock.
  let mutationChain: Promise<unknown> = Promise.resolve();

  return async (
    request: ProtocolRequestRecord,
    connection: ProtocolConnection,
  ): Promise<unknown> => {
    switch (request.type) {
      case "prompt": {
        const releaseQuery = acquireQuery();
        try {
          const content = request.content;
          const trimmed = typeof content === "string" ? content.trim() : "";
          if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
            // Compaction is only valid while Idle; never queued behind turns.
            if (!isIdle(events.agentState)) {
              throw new Error("/compact requires an idle assistant");
            }
            const message: SDKUserMessage = {
              type: "user",
              message: { role: "user", content },
              parent_tool_use_id: null,
              // Absent origin fails closed at strict isHuman() trust gates
              // (Origin declaration); this request came from the user CLI.
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
            // Absent origin fails closed at strict isHuman() trust gates
            // (Origin declaration); socket prompt requests are user input.
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
          // The SDK (0.3.250 through 0.3.280, tests/sdk/interrupt-queue.test.ts)
          // returns the still-queued receipt when the bundled CLI advertises
          // interrupt_receipt_v1; preserve the Query passthrough.
          return receipt;
        } finally {
          releaseQuery();
        }
      }
      // Not Query-bound: the broker settles a promise the SDK holds, and a
      // teardown cancels every ask itself, so no gate is taken.
      case "permission-response": {
        if (typeof request.toolUseId !== "string") {
          throw new Error("permission-response: toolUseId must be a string");
        }
        deps.permissionBroker.respond(
          request.toolUseId,
          validatePermissionResult(request.decision),
        );
        return undefined;
      }
      case "get-context":
      case "get-entries": {
        // The socket casts untrusted JSON: the payload selector is checked
        // before anything is served.
        const includeEntries =
          !isGetEntriesByUuids(request) &&
          parseEntryPayload(request.payload) === "full";
        // No tracker: nothing announced or scanned yet (a fresh agent, or a
        // resume whose file is missing) — nothing to serve.
        const release = await acquireSettled(events, () => gate.awaitShared());
        try {
          const tracker = deps.trackedLog.tracker;
          const entriesFor = (uuids: readonly UUID[]): SessionEntry[] =>
            tracker === undefined ? [] : tracker.payloads(uuids);
          if (isGetEntriesByUuids(request)) {
            return entriesFor(request.uuids);
          }
          if (request.type === "get-entries") {
            const uuids = tracker?.uuidsAfter(request.since) ?? [];
            const snapshot: GetEntriesResponse = {
              uuids: [...uuids],
              ...(includeEntries && { entries: entriesFor(uuids) }),
              leaf: tracker?.leaf ?? null,
            };
            return snapshot;
          }
          const tip = request.at ?? tracker?.leaf ?? null;
          const refs = tip === null ? [] : (tracker?.contextAt(tip) ?? []);
          const slice: GetContextResponse = {
            refs: [...refs],
            ...(includeEntries && {
              entries: entriesFor(refs.map((ref) => ref.uuid)),
            }),
          };
          return slice;
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
        // The socket casts untrusted JSON; validate the optional attachment
        // before any side effect (a malformed one rejects the request).
        let deregister: (() => void) | undefined;
        if (request.attachment !== undefined) {
          const { pid, client } = request.attachment as {
            pid?: unknown;
            client?: unknown;
          };
          if (typeof pid !== "number" || typeof client !== "string") {
            throw new Error(
              "subscribe: attachment must be { pid: number, client: string }",
            );
          }
          deregister = deps.registerAttachment({ pid, client });
        }
        // State capture, response write, and sink attach happen in one
        // synchronous section, so the seed is exact: no event is lost or
        // duplicated between the response line and the first pushed event.
        // The generic respond path runs in a later microtask — an event
        // emitted in between would hit the wire before the response — so this
        // handler writes its own response and returns RESPONSE_SENT.
        const response: ProtocolResponse = {
          id: request.id,
          ok: true,
          data: events.agentState,
        };
        connection.write(`${JSON.stringify(response)}\n`);
        const unsubscribe = events.subscribe((event) =>
          connection.write(`${JSON.stringify({ event })}\n`),
        );
        connection.onClose(unsubscribe);
        // Connection close counts as detach — the daemon-side registration is
        // what catches kill -9'd attachers.
        if (deregister !== undefined) {
          connection.onClose(deregister);
        }
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
