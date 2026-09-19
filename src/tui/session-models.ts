/**
 * The TUI's mirror of `AgentState.sessions`: one `SessionModel` per session
 * id, fed every subscription event with the state it folded to. Routing is
 * the fold's — an entry belongs to `state.fileSessionId`, a query message
 * to its `session_id`, and a session model lives exactly as long as its
 * `SessionState` — so they cannot disagree with the state about
 * which session anything belongs to (docs/specs/query-pending-list.md,
 * Decisions).
 */

import type { UUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "../core/agent-state/agent-state.ts";
import { type AgentEvent, sdkMessageOf } from "../core/protocol.ts";
import type { SessionEntry } from "../core/session/file.ts";
import type { OnInvalid } from "../core/tree/loader.ts";
import { SessionModel } from "./session-model.ts";

/** A step resolved `uuid` on `sessionId`; fires after the entry that
 *  resolved it was pushed, so `entryFor(uuid)` is the canonical rendering
 *  when the session model has it. */
export type OnResolved = (sessionId: UUID, uuid: UUID) => void;

type SessionStreamEvent = Extract<
  AgentEvent,
  { kind: "sessionEntry" | "sessionFileChanged" }
>;

interface HeldEvent {
  /** Socket position, the coordinate of `applySnapshot`'s `eventsBefore`. */
  position: number;
  event: SessionStreamEvent;
  state: AgentState;
}

export class SessionModels {
  private readonly sessionModels = new Map<UUID, SessionModel>();
  private readonly onInvalid: OnInvalid;
  private readonly onResolved: OnResolved;
  private eventsObserved = 0;
  /** Session-stream events observed before the snapshot response, held
   *  until the response says where its cut falls; undefined once the
   *  snapshot is applied. */
  private heldForSnapshot: HeldEvent[] | undefined = [];
  /** The state of the last observed event: what `applySnapshot` prunes
   *  against, since the snapshot and the held events predate it. */
  private latestState: AgentState | undefined;

  constructor(onInvalid: OnInvalid, onResolved: OnResolved) {
    this.onInvalid = onInvalid;
    this.onResolved = onResolved;
  }

  get(sessionId: UUID): SessionModel | undefined {
    return this.sessionModels.get(sessionId);
  }

  /** Every event of the subscription in socket order, with the state it
   *  folded to. Entries and file switches feed the trees (held until the
   *  snapshot, see `applySnapshot`); the query-stream message the event
   *  carries joins the pending list of its session iff the fold observed
   *  its id on `query`; the step's resolutions retire and fire
   *  `onResolved`; session models the state dropped go with it. */
  observe(event: AgentEvent, state: AgentState): void {
    this.eventsObserved += 1;
    this.latestState = state;
    if (event.kind === "sessionEntry" || event.kind === "sessionFileChanged") {
      if (this.heldForSnapshot !== undefined) {
        this.heldForSnapshot.push({
          position: this.eventsObserved,
          event,
          state,
        });
      } else {
        this.applySessionStream(event, state);
      }
    }
    const message = sdkMessageOf(event);
    if (message !== undefined) {
      this.recordPending(message, state);
    }
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      const sessionModel = this.sessionModels.get(sessionId as UUID);
      for (const node of session.resolved) {
        sessionModel?.retire(node.id);
        this.onResolved(sessionId as UUID, node.id);
      }
    }
    this.prune(state);
  }

  /**
   * The `get-entries {payload: "full"}` response into the session model of
   * `stateAtCut.fileSessionId` — `stateAtCut` being the state the daemon
   * answered against: the seed folded through the first `eventsBefore`
   * events. Held events after the cut extend the snapshot with their own
   * states (only their tree effects: pending-list bookkeeping ran when they
   * were observed); session models they or the snapshot revive for sessions the
   * latest state has since dropped are pruned again. A failed fetch applies
   * an empty snapshot at position 0, so the trees still grow from every
   * event received.
   */
  applySnapshot(
    entries: readonly SessionEntry[],
    eventsBefore: number,
    stateAtCut: AgentState,
  ): void {
    if (stateAtCut.fileSessionId !== undefined) {
      const sessionModel = this.sessionModelFor(stateAtCut.fileSessionId);
      for (const entry of entries) {
        sessionModel.pushEntry(entry);
      }
    }
    const held = this.heldForSnapshot ?? [];
    this.heldForSnapshot = undefined;
    for (const { position, event, state } of held) {
      if (position > eventsBefore) {
        this.applySessionStream(event, state);
      }
    }
    this.prune(this.latestState ?? stateAtCut);
  }

  private prune(state: AgentState): void {
    for (const sessionId of this.sessionModels.keys()) {
      if (!(sessionId in state.sessions)) {
        this.sessionModels.delete(sessionId);
      }
    }
  }

  private applySessionStream(
    event: SessionStreamEvent,
    state: AgentState,
  ): void {
    if (event.kind === "sessionFileChanged") {
      this.sessionModelFor(event.sessionId).resetTrees();
      return;
    }
    if (state.fileSessionId !== undefined) {
      this.sessionModelFor(state.fileSessionId).pushEntry(event.entry);
    }
  }

  /** The store rule: recorded iff the folded merge saw the id on `query`
   *  (an entry-first id resolved in the same step has no node; a failed
   *  observation leaves an existing session-only node untouched). Types
   *  the file never carries are recorded too: they resolve with their
   *  `query` predecessors, so the list is the query tail past the last
   *  file-settled message, and a rebuild replays it through `append`
   *  exactly as the live stream did. */
  private recordPending(message: SDKMessage, state: AgentState): void {
    if (message.uuid === undefined) {
      return;
    }
    const sessionId = message.session_id as UUID;
    const node = state.sessions[sessionId]?.merge.nodes[message.uuid];
    if (node === undefined || !node.seenOn.includes("query")) {
      return;
    }
    this.sessionModelFor(sessionId).recordPending(message.uuid, message);
  }

  private sessionModelFor(sessionId: UUID): SessionModel {
    let sessionModel = this.sessionModels.get(sessionId);
    if (sessionModel === undefined) {
      sessionModel = new SessionModel(this.onInvalid);
      this.sessionModels.set(sessionId, sessionModel);
    }
    return sessionModel;
  }
}
