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
import { trackToolNames } from "../core/session/track-tool-names.ts";

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
  /** tool_use id → tool name over every entry held, so a tool_result can
   *  name its tool. */
  readonly toolNames = new Map<string, string>();
  /** The pending list in stream order: ids the merge has not resolved,
   *  with the query message a rebuild replays through `append` exactly
   *  as it rendered live. An undefined message is a node with no frame
   *  to replay: a stamped event (its own node, no rendering), or an id
   *  pending in the seed state at attach whose frame this process never
   *  saw. */
  readonly queryMessages = new Map<UUID, SDKMessage | undefined>();
  /** A steer's `queued_command` attachment under the steer's own uuid. */
  private readonly attachmentBySource = new Map<UUID, SessionEntry>();
  /** Uuid-bearing entries in file order that the trees do not hold yet:
   *  the file-side counterpart of `queryMessages`. An entry joins the
   *  trees when the merge resolves its id (`resolve`). */
  private readonly queuedEntries: SessionEntry[] = [];
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
      trackToolNames(entry, this.toolNames);
    }
    const sourceUuid = queuedCommandSourceUuid(entry);
    if (sourceUuid !== undefined && !this.attachmentBySource.has(sourceUuid)) {
      this.attachmentBySource.set(sourceUuid, entry);
    }
    this.queuedEntries.push(entry);
  }

  recordPending(uuid: UUID, message: SDKMessage | undefined): void {
    this.queryMessages.set(uuid, message);
  }

  /** The merge resolved `uuid`: retire it from the pending list and push
   *  the queued prefix through its entry into the trees; returns the
   *  entry that renders it (`entryFor`, undefined for a query-only id).
   *  Resolution order is file order among session ids, so a prefix
   *  longer than the head is a merge anomaly, and an id that is neither
   *  queued, pending nor retained is unknown; both are reported, the TUI
   *  keeps running. */
  resolve(uuid: UUID): SessionEntry | undefined {
    const wasPending = this.queryMessages.delete(uuid);
    const index = this.queuedEntries.findIndex((entry) => entry.uuid === uuid);
    if (index !== -1) {
      if (index > 0) {
        this.onInvalid(`${uuid} resolved behind ${index} queued entries`);
      }
      for (const entry of this.queuedEntries.splice(0, index + 1)) {
        this.trees.full.push(entry);
        this.trees.context.push();
        this.trees.display.push();
      }
    } else if (!wasPending && this.entryFor(uuid) === undefined) {
      this.onInvalid(`${uuid} resolved but never observed`);
    }
    return this.entryFor(uuid);
  }

  /** The file was replaced under this id: the trees and the queue restart
   *  from nothing, the payloads stay (the new tracker re-emits every
   *  uuid). */
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
