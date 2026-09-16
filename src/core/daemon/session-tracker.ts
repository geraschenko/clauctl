/**
 * The daemon's resident view of ONE session file (docs/specs/
 * session-tracker.md, "Session tracker"): an index of byte ranges + classes
 * and rolling trees, turning each pushed line into the socket's
 * `sessionEntry` event. Entries themselves are never retained — payloads
 * are re-read by range — which is daemon serving policy, not a file
 * property, hence daemon/ rather than session/.
 */

import type { UUID } from "node:crypto";
import { excludedFromQuery } from "../agent-state/agent-state.ts";
import type { AgentEvent } from "../protocol.ts";
import {
  readEntriesAt,
  type ByteRange,
  type ParsedEntry,
  type SessionEntry,
} from "../session/file.ts";
import { structuralEntry } from "../session/structural.ts";
import { SessionTreeBuilder } from "../tree/build-tree.ts";
import { ContextTreeBuilder, type ContextTree } from "../tree/context-tree.ts";
import type { OnInvalid } from "../tree/loader.ts";
import { parseTreeNodeRef, type TreeNodeRef } from "../tree/nodes.ts";

export type SessionTrackerEvent = Extract<
  AgentEvent,
  { kind: "sessionEntry" | "contextChanged" }
>;

export class SessionTracker {
  private readonly filePath: string;
  /** Canonical uuids in file order (insertion order) with what serving
   *  needs of each. */
  private readonly entryIndex = new Map<
    UUID,
    { range: ByteRange; expectsSdkMessage: boolean }
  >();
  /** Structural entries the builders have not consumed yet: a raw node
   *  deferred behind an absent anchor keeps its entry until placed. */
  private readonly byUuid = new Map<UUID, SessionEntry>();
  private readonly sessionTree: SessionTreeBuilder;
  private readonly contextTreeBuilder: ContextTreeBuilder;
  /** Index into sessionTree.nodes of the next node to prune the entry of. */
  private consumed = 0;

  constructor(filePath: string, onInvalid: OnInvalid) {
    this.filePath = filePath;
    this.sessionTree = new SessionTreeBuilder(onInvalid);
    this.contextTreeBuilder = new ContextTreeBuilder(
      this.sessionTree,
      this.byUuid,
    );
  }

  /** First-wins on uuid. Records the entry's range and class, pushes it
   *  through the two trees (on observation — structure is a function of
   *  file order; resolution is the fold's concern) and drops it once
   *  consumed, and returns the events to emit, in order: `[]` for a
   *  duplicate uuid; else the `sessionEntry` — the complete entry for a
   *  session-only class, `structuralEntry(entry)` for a shared one,
   *  `expectsSdkMessage` saying which — followed by one `contextChanged`
   *  per boundary this entry completed (its own, or those whose deferred
   *  blocks it anchored), in file order, each carrying the post-push leaf. */
  push(parsed: ParsedEntry): readonly SessionTrackerEvent[] {
    const { entry, range } = parsed;
    if (entry.uuid === undefined) {
      return [this.sessionEntryEvent(entry, false)];
    }
    if (this.entryIndex.has(entry.uuid)) {
      return [];
    }
    const expectsSdkMessage = !excludedFromQuery(entry);
    this.entryIndex.set(entry.uuid, { range, expectsSdkMessage });
    const structural = structuralEntry(entry);
    const awaitingBefore = this.sessionTree.awaitingAnchors;
    this.byUuid.set(entry.uuid, structural);
    this.sessionTree.push(structural);
    this.contextTreeBuilder.push();
    this.pruneConsumed();
    const awaitingAfter = new Set(this.sessionTree.awaitingAnchors);
    const completed = [
      ...awaitingBefore.filter((boundary) => !awaitingAfter.has(boundary)),
      ...(entry.subtype === "compact_boundary" && !awaitingAfter.has(entry.uuid)
        ? [entry.uuid]
        : []),
    ];
    const leaf = this.leaf;
    return [
      this.sessionEntryEvent(
        expectsSdkMessage ? structural : entry,
        expectsSdkMessage,
      ),
      ...completed.map((boundary): SessionTrackerEvent => ({
        kind: "contextChanged",
        boundary,
        leaf,
      })),
    ];
  }

  private sessionEntryEvent(
    entry: SessionEntry,
    expectsSdkMessage: boolean,
  ): SessionTrackerEvent {
    const leaf = this.leaf;
    const lastAssistant =
      leaf === null ? undefined : this.contextTreeBuilder.lastAssistantOn(leaf);
    return {
      kind: "sessionEntry",
      entry,
      expectsSdkMessage,
      leaf,
      ...(lastAssistant !== undefined && { lastAssistant }),
      awaitingAnchors: this.sessionTree.awaitingAnchors,
    };
  }

  /** Entries whose raw node every builder has consumed are dropped;
   *  relinked occurrences read nothing. */
  private pruneConsumed(): void {
    const nodes = this.sessionTree.nodes;
    for (; this.consumed < nodes.length; this.consumed++) {
      const ref = parseTreeNodeRef(nodes[this.consumed]!);
      if (ref.viaBoundary === undefined) {
        this.byUuid.delete(ref.uuid);
      }
    }
  }

  /** Canonical uuids after `since` in file order (throws when the cursor
   *  is unknown). */
  uuidsAfter(since: UUID | undefined): readonly UUID[] {
    if (since === undefined) {
      return [...this.entryIndex.keys()];
    }
    if (!this.entryIndex.has(since)) {
      throw new Error(`${this.filePath}: unknown entry uuid ${since}`);
    }
    const uuids: UUID[] = [];
    let after = false;
    for (const uuid of this.entryIndex.keys()) {
      if (after) {
        uuids.push(uuid);
      } else if (uuid === since) {
        after = true;
      }
    }
    return uuids;
  }

  /** Complete entries for these uuids via readEntriesAt over their
   *  ranges, requested order; throws on an unknown uuid. */
  payloads(uuids: readonly UUID[]): SessionEntry[] {
    return readEntriesAt(
      this.filePath,
      uuids.map((uuid) => {
        const indexed = this.entryIndex.get(uuid);
        if (indexed === undefined) {
          throw new Error(`${this.filePath}: unknown entry uuid ${uuid}`);
        }
        return indexed.range;
      }),
    );
  }

  /** The context at an occurrence, as refs in context order. */
  contextAt(at: TreeNodeRef): readonly TreeNodeRef[] {
    return this.contextTree.contextAt(at);
  }

  /** Every canonical uuid of the file with its byte range and class — the
   *  dedup site's existence/class check and set-context validation's
   *  existence check; entries themselves are read by range. */
  get index(): ReadonlyMap<
    UUID,
    { range: ByteRange; expectsSdkMessage: boolean }
  > {
    return this.entryIndex;
  }

  get contextTree(): ContextTree {
    return this.contextTreeBuilder.tree;
  }

  get leaf(): TreeNodeRef | null {
    return this.contextTree.leaf;
  }

  /** Entries still held for the builders (deferred behind an absent
   *  anchor); zero whenever nothing is deferred — the memory criterion's
   *  observable. */
  get residentEntries(): number {
    return this.byUuid.size;
  }
}
