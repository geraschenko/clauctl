/**
 * The TUI's mirror of `AgentState.sessions`: one `SessionModel` per session
 * id, fed every subscription event with the state it folded to. Routing is
 * the fold's (`observedSessions`: an entry belongs to `state.fileSessionId`,
 * a query message to `state.querySessionId`), and a session model lives
 * exactly as long as its
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
  type MergeStream,
  type AgentEvent,
  eventNodes,
  sdkMessageOf,
} from "../core/protocol/index.ts";
import {
  joinedPrompt,
  observedSessions,
  eventStream,
} from "../core/agent-state/index.ts";
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
 *  the trees, so the path is current. */
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
  /** Events with an effect at resolution (`contextChanged`), by their
   *  merge node, until the step that resolves it dispatches them. */
  private readonly pendingEvents = new Map<UUID, AgentEvent>();
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

  /** The seed state: its pending uuids on either stream (attaching
   *  mid-turn, or before the file exists) recorded without their frames
   *  so their resolutions are known uuids, not "never observed"; its
   *  queued prompts held for their dequeues. */
  seed(state: AgentState): void {
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      const sessionModel = this.sessionModelFor(sessionId as UUID);
      for (const uuid of pending(session.merge, "query")) {
        sessionModel.recordPending(uuid, undefined);
      }
      for (const uuid of pending(session.merge, "session")) {
        if (!session.merge.nodes[uuid]!.seenOn.includes("query")) {
          sessionModel.recordPending(uuid, undefined);
        }
      }
    }
    for (const { uuid, message } of state.queuedMessages) {
      this.queued.set(uuid, message);
    }
  }

  /** Every event of the subscription in socket order, with the state it
   *  folded to. Its merge node joins the pending list of its session iff
   *  the fold observed it (`recordObserved`); the event's tree effects
   *  (`applyEntry`, `applyResolutions`) run now, or wait for the
   *  snapshot; session models the state dropped go with it. */
  observe(event: AgentEvent, state: AgentState): void {
    this.eventsObserved += 1;
    this.latestState = state;
    switch (event.kind) {
      case "userMessageQueued":
        this.queued.set(event.message.uuid as UUID, event.message);
        this.recordObserved(event, state);
        break;
      case "userMessageDequeued":
        this.recordDequeued(event, state);
        break;
      case "compactSent":
      case "interruptSent":
      case "controlApplied":
      case "contextChanged":
      case "sdkMessage":
      case "sessionEntry":
      case "querySessionChanged":
      case "sessionFileChanged":
      case "scanComplete":
      case "sessionAppended":
      case "trackerAnomaly":
      case "shutdown":
        this.recordObserved(event, state);
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
   * snapshot (and the attach render) holds the rest. A session the latest
   * state has since dropped has no session model: its snapshot is
   * discarded rather than revived, its resolutions are not reported, and
   * a session model a held entry revives for it is pruned again. A failed
   * fetch applies an empty snapshot at position 0, so the trees still
   * grow from every event received.
   */
  applySnapshot(
    entries: readonly SessionEntry[],
    eventsBefore: number,
    stateAtCut: AgentState,
  ): void {
    const snapshotSessionId = stateAtCut.fileSessionId;
    if (
      snapshotSessionId !== undefined &&
      snapshotSessionId in (this.latestState ?? stateAtCut).sessions
    ) {
      const sessionModel = this.sessionModelFor(snapshotSessionId);
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

  /** The event's file-side effect: its entry enqueued on the session
   *  model of `state.fileSessionId`; a `contextChanged` held for its
   *  resolution; a file switch resets that session's trees. */
  private applyEntry(event: AgentEvent, state: AgentState): void {
    switch (event.kind) {
      case "sessionFileChanged":
        this.sessionModelFor(event.sessionId).resetTrees();
        break;
      case "contextChanged":
        this.pendingEvents.set(event.uuid, event);
        break;
      case "sessionEntry":
        if (state.fileSessionId !== undefined) {
          this.sessionModelFor(state.fileSessionId).enqueueEntry(event.entry);
        }
        break;
      case "userMessageQueued":
      case "userMessageDequeued":
      case "compactSent":
      case "interruptSent":
      case "controlApplied":
      case "sdkMessage":
      case "querySessionChanged":
      case "scanComplete":
      case "sessionAppended":
      case "trackerAnomaly":
      case "shutdown":
        break;
    }
  }

  /** The step's resolutions, per session in order, each pushing through
   *  the session model and reported; a resolved event's own effect is
   *  dispatched after. A session without a session model was dropped by
   *  a later state (a held step replayed after the drop): nothing to
   *  retire, nothing to report. */
  private applyResolutions(state: AgentState): void {
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      const sessionModel = this.sessionModels.get(sessionId as UUID);
      if (sessionModel === undefined) continue;
      for (const node of session.resolved) {
        const entry = sessionModel.resolve(node.id);
        this.onResolved(sessionId as UUID, node.id, entry);
        const pendingEvent = this.pendingEvents.get(node.id);
        if (pendingEvent !== undefined) {
          this.pendingEvents.delete(node.id);
          if (pendingEvent.kind === "contextChanged") {
            this.onContextChanged(sessionId as UUID);
          }
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
      "query",
    );
  }

  /** The event's merge nodes into the pending lists of the sessions the
   *  fold observed it on (`observedSessions`, `eventNodes`): a query
   *  message with its frame (the rebuild replays it), any other event
   *  frameless — its resolution retires it quietly. An entry the file
   *  names is the session model's `queuedEntries` business, not the
   *  pending list's. */
  private recordObserved(event: AgentEvent, state: AgentState): void {
    if (event.kind === "sessionEntry" && event.entry.uuid !== undefined) {
      return;
    }
    const message = sdkMessageOf(event);
    const frame = message?.uuid === undefined ? undefined : message;
    const stream = eventStream(event);
    for (const sessionId of observedSessions(state, event)) {
      for (const node of eventNodes(event)) {
        this.recordIfObserved(sessionId, node, frame, state, stream);
      }
    }
  }

  /** The store rule: recorded iff the fold observed the uuid on `stream`
   *  — its merge node has it, or the step resolved it with it (the merge
   *  forgets resolved nodes; a failed observation leaves an existing node
   *  untouched). A uuid resolved in its own step is retired by
   *  `applyResolutions` right after. Types the file never carries are
   *  recorded too: they resolve with their `query` predecessors, so the
   *  list is the query tail past the last file-settled message, and a
   *  rebuild replays it through `append` exactly as the live stream did. */
  private recordIfObserved(
    sessionId: UUID,
    uuid: UUID,
    message: SDKMessage | undefined,
    state: AgentState,
    stream: MergeStream,
  ): void {
    const session = state.sessions[sessionId];
    const seenOn =
      session?.merge.nodes[uuid]?.seenOn ??
      session?.resolved.find((node) => node.id === uuid)?.seenOn;
    if (seenOn === undefined || !seenOn.includes(stream)) {
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
