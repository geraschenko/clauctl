/**
 * The TUI's local copy of the session (docs/specs/session-tracker.md, Data
 * flow 6): every entry seen with the best payload held for it, and the
 * full/context/display trees extended from the `sessionEntry` stream — the
 * same function of the entry stream the daemon computes — so `/tree` and
 * transcript redraws read local state and never refetch.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UUID } from "node:crypto";
import type { AgentEvent } from "../core/sdk-socket.ts";
import type { SessionEntry } from "../core/session/file.ts";
import { completedEntry } from "../core/session/structural.ts";
import { SessionTreeBuilder } from "../core/tree/build-tree.ts";
import {
  ContextTreeBuilder,
  type ContextTree,
} from "../core/tree/context-tree.ts";
import {
  DisplayTreeBuilder,
  type DisplayTree,
} from "../core/tree/display-tree.ts";
import type { OnInvalid } from "../core/tree/loader.ts";
import type { TreeNodeRef } from "../core/tree/nodes.ts";

type SessionStreamEvent = Extract<
  AgentEvent,
  { kind: "sessionEntry" | "sessionFileChanged" }
>;

interface RollingTrees {
  full: SessionTreeBuilder;
  context: ContextTreeBuilder;
  display: DisplayTreeBuilder;
}

function rollingTrees(
  onInvalid: OnInvalid,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): RollingTrees {
  const full = new SessionTreeBuilder(onInvalid);
  const context = new ContextTreeBuilder(full, byUuid);
  return {
    full,
    context,
    display: new DisplayTreeBuilder(full, context, byUuid),
  };
}

export class SessionModel {
  /**
   * First-wins per uuid and never cleared: a history entry is complete, a
   * session-only live entry arrives complete, a shared-class live entry
   * arrives structural and takes its payload from its `sdkMessage` twin,
   * whichever side arrives first. An entry is immutable per uuid, so a file
   * switch (`/fork` re-persists the old entries, structurally on the wire)
   * rebuilds only the trees over this map.
   */
  readonly byUuid = new Map<UUID, SessionEntry>();
  /** Twins whose entry has not arrived yet. */
  private readonly twins = new Map<UUID, SDKMessage>();
  private readonly onInvalid: OnInvalid;
  private trees: RollingTrees;
  /** Socket position of the last observed event — the coordinate of
   *  `applySnapshot`'s `eventsBefore`. */
  private eventsObserved = 0;
  /**
   * Session-stream events observed before the snapshot response, held
   * with their positions until the response says where its cut falls;
   * undefined once the snapshot is applied.
   */
  private heldForSnapshot:
    Array<{ position: number; event: SessionStreamEvent }> | undefined = [];

  constructor(onInvalid: OnInvalid) {
    this.onInvalid = onInvalid;
    this.trees = rollingTrees(onInvalid, this.byUuid);
  }

  get contextTree(): ContextTree {
    return this.trees.context.tree;
  }

  get displayTree(): DisplayTree {
    return this.trees.display.tree;
  }

  /**
   * The file-side leaf: the context tree's leaf over the entries held,
   * always a node of `displayTree`/`contextTree`. Use it wherever the leaf
   * must be looked up in those trees (the `/tree` marker, the endpoint of
   * the display path). `leaf(agentState)` is the query-side leaf instead:
   * the same tree leaf, or the pending SDK message's uuid while the query
   * leads the file — not yet an entry here. Use that one where the
   * question is where the live event stream stands (the replay cut in
   * renderHistory, after which buffered live events resume).
   */
  get leaf(): TreeNodeRef | null {
    return this.contextTree.leaf;
  }

  /** Every event of the subscription, in socket order, from the first. */
  observe(event: AgentEvent): void {
    this.eventsObserved += 1;
    if (event.kind === "sdkMessage") {
      this.recordTwin(event.message);
      return;
    }
    if (event.kind !== "sessionEntry" && event.kind !== "sessionFileChanged") {
      return;
    }
    if (this.heldForSnapshot !== undefined) {
      this.heldForSnapshot.push({ position: this.eventsObserved, event });
      return;
    }
    this.apply(event);
  }

  /**
   * The `get-entries {payload: "full"}` response: `entries` in file order,
   * and how many of the events observed so far precede the response on the
   * socket — those are in the snapshot; the held events after them extend
   * it. A failed fetch applies an empty snapshot at position 0, so the
   * trees still grow from every event received.
   */
  applySnapshot(entries: readonly SessionEntry[], eventsBefore: number): void {
    for (const entry of entries) {
      this.pushEntry(entry);
    }
    const held = this.heldForSnapshot ?? [];
    this.heldForSnapshot = undefined;
    for (const { position, event } of held) {
      if (position > eventsBefore) {
        this.apply(event);
      }
    }
  }

  private apply(event: SessionStreamEvent): void {
    if (event.kind === "sessionFileChanged") {
      this.trees = rollingTrees(this.onInvalid, this.byUuid);
      return;
    }
    this.pushEntry(event.entry);
  }

  private pushEntry(entry: SessionEntry): void {
    const uuid = entry.uuid;
    if (uuid !== undefined && !this.byUuid.has(uuid)) {
      const twin = this.twins.get(uuid);
      this.twins.delete(uuid);
      this.byUuid.set(
        uuid,
        twin === undefined ? entry : completedEntry(entry, twin),
      );
    }
    this.trees.full.push(entry);
    this.trees.context.push();
    this.trees.display.push();
  }

  private recordTwin(message: SDKMessage): void {
    if (
      (message.type !== "user" && message.type !== "assistant") ||
      message.uuid === undefined
    ) {
      return;
    }
    const uuid = message.uuid as UUID;
    const entry = this.byUuid.get(uuid);
    if (entry === undefined) {
      this.twins.set(uuid, message);
    } else {
      this.byUuid.set(uuid, completedEntry(entry, message));
    }
  }
}
