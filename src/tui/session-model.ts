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
   *  them through `append` exactly as they rendered live. */
  readonly queryMessages = new Map<UUID, SDKMessage>();
  /** A steer's `queued_command` attachment under the steer's own uuid. */
  private readonly attachmentBySource = new Map<UUID, SessionEntry>();
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

  pushEntry(entry: SessionEntry): void {
    if (entry.uuid !== undefined && !this.byUuid.has(entry.uuid)) {
      this.byUuid.set(entry.uuid, entry);
    }
    const sourceUuid = queuedCommandSourceUuid(entry);
    if (sourceUuid !== undefined && !this.attachmentBySource.has(sourceUuid)) {
      this.attachmentBySource.set(sourceUuid, entry);
    }
    this.trees.full.push(entry);
    this.trees.context.push();
    this.trees.display.push();
  }

  recordPending(uuid: UUID, message: SDKMessage): void {
    this.queryMessages.set(uuid, message);
  }

  retire(uuid: UUID): void {
    this.queryMessages.delete(uuid);
  }

  /** The file was replaced under this id: the trees restart from nothing,
   *  the payloads stay (the new tracker re-emits every uuid). */
  resetTrees(): void {
    this.trees = rollingTrees(this.onInvalid, this.byUuid);
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
