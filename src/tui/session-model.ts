/**
 * The TUI's local copy of one session (docs/specs/session-tracker.md, Data
 * flow 6): every entry seen, the query pending list, and the full/context/
 * display trees extended from the `sessionEntry` stream — the same function
 * of the entry stream the daemon computes — so `/tree` and transcript
 * rebuilds read local state and never refetch. `SessionModels` owns one per
 * session id and does all routing; nothing here names another session.
 */

import type { UUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  queuedCommandSourceUuid,
  type SessionEntry,
} from "../core/session/file.ts";
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
import { pathToLeaf, type TreeNodeRef } from "../core/tree/nodes.ts";

/** An entry awaiting its resolution; `contextChangedAfter` when a
 *  `contextChanged` followed it in the file stream — the daemon emits one
 *  right after the entry that completed a boundary (the boundary itself,
 *  or the anchor a deferred boundary waited for), so the rebuild it asks
 *  for belongs to that entry's resolution. */
interface QueuedEntry {
  entry: SessionEntry;
  contextChangedAfter: boolean;
}

/** What `resolve` found for an id: the entry that renders it (`entryFor`,
 *  undefined for a query-only id) and whether pushing the queue prefix
 *  crossed a `contextChanged`. */
export interface Resolution {
  entry: SessionEntry | undefined;
  contextChanged: boolean;
}

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
  /** Complete entries, first-wins per uuid and never cleared: an entry is
   *  immutable per uuid, so a same-file rescan (or `/fork`'s re-persisted
   *  entries) rebuilds only the trees over this map. */
  readonly byUuid = new Map<UUID, SessionEntry>();
  /** The query pending list in query order: messages the query stream
   *  reported whose ids the merge has not resolved; a rebuild replays
   *  them through `append` exactly as they rendered live. An undefined
   *  message is an id pending in the seed state at attach (mid-turn:
   *  stream events, a result) whose frame this process never saw. */
  readonly queryMessages = new Map<UUID, SDKMessage | undefined>();
  /** A steer's `queued_command` attachment under the steer's own uuid. */
  private readonly attachmentBySource = new Map<UUID, SessionEntry>();
  /** Uuid-bearing entries in file order that the trees do not hold yet:
   *  the file-side counterpart of `queryMessages`. An entry joins the
   *  trees when the merge resolves its id (`resolve`). */
  private readonly queuedEntries: QueuedEntry[] = [];
  private readonly onInvalid: OnInvalid;
  private trees: RollingTrees;

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

  /** The file-side leaf: the context tree's leaf over the entries held,
   *  always a node of `displayTree`/`contextTree`. */
  get leaf(): TreeNodeRef | null {
    return this.contextTree.leaf;
  }

  /** Retain the entry; a uuid-bearing one waits in `queuedEntries` for its
   *  resolution (uuid-less entries never reach the trees). */
  enqueueEntry(entry: SessionEntry): void {
    if (entry.uuid === undefined) {
      return;
    }
    if (!this.byUuid.has(entry.uuid)) {
      this.byUuid.set(entry.uuid, entry);
    }
    const sourceUuid = queuedCommandSourceUuid(entry);
    if (sourceUuid !== undefined && !this.attachmentBySource.has(sourceUuid)) {
      this.attachmentBySource.set(sourceUuid, entry);
    }
    this.queuedEntries.push({ entry, contextChangedAfter: false });
  }

  /** A `contextChanged` arrived: it belongs to the queue's tail, whose
   *  resolution will report it. True when nothing is queued — the entry
   *  it followed resolved already, so it is due now. */
  enqueueContextChange(): boolean {
    const tail = this.queuedEntries.at(-1);
    if (tail === undefined) {
      return true;
    }
    tail.contextChangedAfter = true;
    return false;
  }

  recordPending(uuid: UUID, message: SDKMessage | undefined): void {
    this.queryMessages.set(uuid, message);
  }

  /** The merge resolved `uuid`: retire it from the pending list and push
   *  the queued prefix through its entry into the trees. Resolution order
   *  is file order among session ids, so a prefix longer than the head is
   *  a merge anomaly, and an id that is neither queued, pending nor
   *  retained is unknown; both are reported, the TUI keeps running. */
  resolve(uuid: UUID): Resolution {
    const wasPending = this.queryMessages.delete(uuid);
    const index = this.queuedEntries.findIndex(
      (queued) => queued.entry.uuid === uuid,
    );
    let contextChanged = false;
    if (index !== -1) {
      if (index > 0) {
        this.onInvalid(`${uuid} resolved behind ${index} queued entries`);
      }
      for (const queued of this.queuedEntries.splice(0, index + 1)) {
        this.trees.full.push(queued.entry);
        this.trees.context.push();
        this.trees.display.push();
        contextChanged ||= queued.contextChangedAfter;
      }
    } else if (!wasPending && this.entryFor(uuid) === undefined) {
      this.onInvalid(`${uuid} resolved but never observed`);
    }
    return { entry: this.entryFor(uuid), contextChanged };
  }

  /** The file was replaced under this id: the trees and the queue (its
   *  contextChanged flags with it) restart from nothing, the payloads stay
   *  (the new tracker re-emits every uuid). */
  resetTrees(): void {
    this.trees = rollingTrees(this.onInvalid, this.byUuid);
    this.queuedEntries.length = 0;
  }

  /** The entry that renders `uuid`: its own, else the steer attachment
   *  recorded under it. A retained entry for a uuid the current trees lack
   *  is the same entry the file re-wrote (first-wins, as everywhere). */
  entryFor(uuid: UUID): SessionEntry | undefined {
    return this.byUuid.get(uuid) ?? this.attachmentBySource.get(uuid);
  }

  /** The display path to `leaf`: a hidden relinked leaf renders as the
   *  visible node that carries it. */
  pathToLeaf(): TreeNodeRef[] {
    const leaf = this.leaf;
    const visibleLeaf =
      leaf === null ? null : this.displayTree.nearestVisibleNode(leaf);
    return pathToLeaf(
      this.displayTree.parentMap,
      this.byUuid,
      visibleLeaf ?? null,
    );
  }
}
