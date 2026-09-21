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
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentState,
  joinedPrompt,
} from "../core/agent-state/agent-state.ts";
import { type AgentEvent, sdkMessageOf } from "../core/protocol.ts";
import type { SessionEntry } from "../core/session/file.ts";
import { pending } from "../core/stream-merge.ts";
import type { OnInvalid } from "../core/tree/loader.ts";
import { SessionModel } from "./session-model.ts";

/** A step resolved `uuid` on `sessionId`, reported in resolution order
 *  after the session model pushed its entry into the trees; `entry` is
 *  what renders `uuid` (`entryFor`), undefined for a query-only uuid. */
export type OnResolved = (
  sessionId: UUID,
  uuid: UUID,
  entry: SessionEntry | undefined,
) => void;

/** A `contextChanged` on `sessionId` resolved: the entry it followed is in
 *  the trees (or already was when it arrived), so the path is current. */
export type OnContextChanged = (sessionId: UUID) => void;

interface HeldEvent {
  /** Socket position, the coordinate of `applySnapshot`'s `eventsBefore`. */
  position: number;
  event: AgentEvent;
  state: AgentState;
}

export class SessionModels {
  private readonly sessionModels = new Map<UUID, SessionModel>();
  /** Accepted prompts by stamped uuid, from `userMessageQueued` and the
   *  seed state; a dequeue takes its uuids out. */
  private readonly queued = new Map<UUID, SDKUserMessage>();
  private readonly onInvalid: OnInvalid;
  private readonly onResolved: OnResolved;
  private readonly onContextChanged: OnContextChanged;
  private eventsObserved = 0;
  /** Events observed before the snapshot response, held until the
   *  response says where its cut falls; undefined once the snapshot is
   *  applied. */
  private heldForSnapshot: HeldEvent[] | undefined = [];
  /** The state of the last observed event: what `applySnapshot` prunes
   *  against, since the snapshot and the held events predate it. */
  private latestState: AgentState | undefined;

  constructor(
    onInvalid: OnInvalid,
    onResolved: OnResolved,
    onContextChanged: OnContextChanged,
  ) {
    this.onInvalid = onInvalid;
    this.onResolved = onResolved;
    this.onContextChanged = onContextChanged;
  }

  get(sessionId: UUID): SessionModel | undefined {
    return this.sessionModels.get(sessionId);
  }

  /** The seed state: its query-pending uuids (attaching mid-turn) recorded
   *  without their frames so their resolutions are known uuids, not
   *  "never observed"; its queued prompts held for their dequeues. */
  seed(state: AgentState): void {
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      for (const uuid of pending(session.merge, "query")) {
        this.sessionModelFor(sessionId as UUID).recordPending(uuid, undefined);
      }
    }
    for (const { uuid, message } of state.queuedMessages) {
      this.queued.set(uuid, message);
    }
  }

  /** Every event of the subscription in socket order, with the state it
   *  folded to. The query-stream message the event carries, or the prompt
   *  a dequeue delivers (the run's joined prompt under its run key), joins
   *  the pending list of its session iff the fold observed its uuid on
   *  `query`; the event's tree effects
   *  (`applyEntry`, `applyResolutions`) run now, or wait for the snapshot;
   *  session models the state dropped go with it. */
  observe(event: AgentEvent, state: AgentState): void {
    this.eventsObserved += 1;
    this.latestState = state;
    const message = sdkMessageOf(event);
    if (message !== undefined && message.uuid !== undefined) {
      this.recordIfObserved(
        message.session_id as UUID,
        message.uuid as UUID,
        message,
        state,
      );
    }
    if (event.kind === "userMessageQueued") {
      this.queued.set(event.uuid, event.message);
    } else if (event.kind === "userMessageDequeued") {
      this.recordDequeued(event, state);
    }
    if (this.heldForSnapshot !== undefined) {
      this.heldForSnapshot.push({
        position: this.eventsObserved,
        event,
        state,
      });
    } else {
      this.applyEntry(event, state);
      this.applyResolutions(state);
    }
    this.prune(state);
  }

  /**
   * The `get-entries {payload: "full"}` response into the session model of
   * `stateAtCut.fileSessionId` — `stateAtCut` being the state the daemon
   * answered against: the seed folded through the first `eventsBefore`
   * events. The snapshot is the file prefix, and file order is resolution
   * order among session ids, so each entry is enqueued and resolved in
   * turn (`settled` rules out query-pending uuids, not session-pending ones:
   * a tail entry whose echo has not arrived is pushed now, and its later
   * resolution finds it retained with nothing queued). Then the held
   * events replay their tree effects with their own states — resolutions
   * for all of them, since uuids recorded before the cut must still retire;
   * entries, context changes and file switches only after the cut, the
   * snapshot (and the attach render) holds the rest. Session models they
   * or the snapshot revive for sessions the
   * latest state has since dropped are pruned again. A failed fetch
   * applies an empty snapshot at position 0, so the trees still grow from
   * every event received.
   */
  applySnapshot(
    entries: readonly SessionEntry[],
    eventsBefore: number,
    stateAtCut: AgentState,
  ): void {
    if (stateAtCut.fileSessionId !== undefined) {
      const sessionModel = this.sessionModelFor(stateAtCut.fileSessionId);
      for (const entry of entries) {
        sessionModel.enqueueEntry(entry);
        if (entry.uuid !== undefined) {
          sessionModel.resolve(entry.uuid);
        }
      }
    }
    const held = this.heldForSnapshot ?? [];
    this.heldForSnapshot = undefined;
    for (const { position, event, state } of held) {
      if (position > eventsBefore) {
        this.applyEntry(event, state);
      }
      this.applyResolutions(state);
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

  /** The event's file-side effect on the session model of
   *  `state.fileSessionId`: its entry enqueued, its `contextChanged`
   *  queued behind the entry it followed (reported at once when that
   *  entry resolved already); a file switch resets that session's
   *  trees. */
  private applyEntry(event: AgentEvent, state: AgentState): void {
    if (event.kind === "sessionFileChanged") {
      this.sessionModelFor(event.sessionId).resetTrees();
      return;
    }
    if (state.fileSessionId === undefined) {
      return;
    }
    if (event.kind === "sessionEntry") {
      this.sessionModelFor(state.fileSessionId).enqueueEntry(event.entry);
    } else if (
      event.kind === "contextChanged" &&
      this.sessionModelFor(state.fileSessionId).enqueueContextChange()
    ) {
      this.onContextChanged(state.fileSessionId);
    }
  }

  /** The step's resolutions, per session in order, each pushing through
   *  the session model and reported; a `contextChanged` the push crossed
   *  is reported after its entry. */
  private applyResolutions(state: AgentState): void {
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      const sessionModel = this.sessionModels.get(sessionId as UUID);
      for (const node of session.resolved) {
        const resolution = sessionModel?.resolve(node.id);
        this.onResolved(sessionId as UUID, node.id, resolution?.entry);
        if (resolution?.contextChanged === true) {
          this.onContextChanged(sessionId as UUID);
        }
      }
    }
  }

  /** A dequeue's prompts leave `queued` for the query session's pending
   *  list, joined under the run key the fold observed. A run none of
   *  whose prompts this process held (queued before an attach whose seed
   *  lacked them) is recorded frameless, like a seed-pending uuid. */
  private recordDequeued(
    event: Extract<AgentEvent, { kind: "userMessageDequeued" }>,
    state: AgentState,
  ): void {
    const messages = event.uuids.flatMap((uuid) => {
      const message = this.queued.get(uuid);
      this.queued.delete(uuid);
      return message === undefined ? [] : [message];
    });
    if (state.querySessionId === undefined) {
      return;
    }
    this.recordIfObserved(
      state.querySessionId,
      event.uuids.at(-1)!,
      joinedPrompt(messages),
      state,
    );
  }

  /** The store rule: recorded iff the fold observed the uuid on `query` —
   *  its merge node has `query`, or the step resolved it with `query`
   *  (the merge forgets resolved nodes; a failed observation leaves an
   *  existing session-only node untouched). A uuid resolved in its own
   *  step is retired by `applyResolutions` right after. Types the file
   *  never carries are recorded too: they resolve with their `query`
   *  predecessors, so the list is the query tail past the last
   *  file-settled message, and a rebuild replays it through `append`
   *  exactly as the live stream did. */
  private recordIfObserved(
    sessionId: UUID,
    uuid: UUID,
    message: SDKMessage | undefined,
    state: AgentState,
  ): void {
    const session = state.sessions[sessionId];
    const seenOn =
      session?.merge.nodes[uuid]?.seenOn ??
      session?.resolved.find((node) => node.id === uuid)?.seenOn;
    if (seenOn === undefined || !seenOn.includes("query")) {
      return;
    }
    this.sessionModelFor(sessionId).recordPending(uuid, message);
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
