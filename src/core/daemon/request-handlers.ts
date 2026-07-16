/**
 * Request *semantics* for sdk.sock: what each request type means, done to the
 * daemon's moving parts. The neighboring seams: sdk-server.ts is transport
 * (framing, hello, response routing) and knows nothing about request types;
 * event-hub.ts is state and knows nothing about requests; this module turns
 * one into effects on the other. Deliberately a shallow relocation of the
 * dispatch switch, not a deep module — the leverage is that daemon.ts reads
 * as a composition root, and request semantics are testable through fake
 * deps without a real daemon.
 */

import {
  getSessionMessages,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PersistedOptions } from "../options.ts";
import {
  applyMutation,
  isControlMutation,
  persistedOptionsAfter,
  runRead,
} from "../sdk-passthrough.ts";
import type {
  SdkControlMutation,
  SdkRequestRecord,
  SdkResponse,
} from "../sdk-socket.ts";
import type { EventHub } from "./event-hub.ts";
import { RESPONSE_SENT, type SdkConnection } from "./sdk-server.ts";
import type { TurnQueue } from "./turn-queue.ts";

export interface RequestHandlerDeps {
  claudeQuery: Query;
  events: EventHub;
  /** Compact-path pushes only; ordinary messages go through
   *  events.deliverUserMessage. */
  turnQueue: TurnQueue;
  /** getSessionMessages dir. */
  cwd: string;
  /** Mutation persistence; the write itself is queued by daemon.ts. */
  getPersistedOptions(): PersistedOptions;
  setPersistedOptions(options: PersistedOptions): void;
}

export function createRequestHandler(
  deps: RequestHandlerDeps,
): (request: SdkRequestRecord, connection: SdkConnection) => Promise<unknown> {
  const { claudeQuery, events, turnQueue } = deps;

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
          turnQueue.push(message);
          events.emit({ kind: "compactSent", message });
          return undefined;
        }
        const message: SDKUserMessage = {
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          ...(request.priority !== undefined && { priority: request.priority }),
          ...(request.shouldQuery === false && { shouldQuery: false }),
        };
        events.deliverUserMessage(message);
        // The response makes no delivery claim: a demotable message's fate is
        // unknown at accept time, and blocking until the next boundary could
        // hang for minutes. The queued/dequeued events on the stream are the
        // truth.
        return undefined;
      }
      case "interrupt":
        await claudeQuery.interrupt();
        events.emit({ kind: "interruptSent" });
        return undefined;
      case "wait-idle":
        await events.whenIdle();
        return undefined;
      case "get-messages": {
        // Valid before the first init because the hub is seeded (on revival,
        // with the last recorded session).
        const sessionId = events.agentState.sessionId;
        if (sessionId === undefined) {
          return [];
        }
        return await getSessionMessages(sessionId, { dir: deps.cwd });
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
      const run = async (): Promise<unknown> => {
        const data = await applyMutation(claudeQuery, request);
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
      return await result;
    }
    return await runRead(claudeQuery, request);
  };
}
