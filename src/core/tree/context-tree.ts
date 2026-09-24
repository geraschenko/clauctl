/**
 * The assistant-context relation over the full tree: every occurrence
 * except boundary rows, each under its context predecessor, so the
 * root-first path to any occurrence is the assistant context there (see
 * docs/specs/context-tree.md). The middle layer between the session tree
 * (the file view) and the display tree (the human view);
 * docs/session-views.md explains why the three are kept apart.
 */

import type { UUID } from "node:crypto";
import type {
  NonNullableUsage,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { toNonNullableUsage } from "../to-non-nullable-usage.ts";
import { hasUuid, type SessionEntry, type UuidEntry } from "../session/file.ts";
import { finishedTreeView, type FullTreeView } from "./build-tree.ts";
import {
  formatTreeNodeRef,
  parseTreeNodeRef,
  type ParentMap,
  type TreeNodeRef,
  type TreeNodeStr,
} from "./nodes.ts";
import { isToolResultEntry } from "./loader.ts";
import { ToolGroup } from "./tool-group.ts";

export class ContextTree {
  /** Full-tree (materialization) order minus boundary rows; every parent
   *  precedes its children. Parallel tool groups are linearized in file
   *  order; a row whose full-tree parent is a boundary row is a context
   *  root. */
  readonly parentMap: ParentMap;
  /** Entries no normalizePreservedUuids-accepted list can contain: tool
   *  calls with no result in the file, results with no call entry, and
   *  thinking-only assistants whose API message group has no other
   *  surviving member. Matching skips them on both sides. */
  readonly excluded: ReadonlySet<UUID>;
  /** Where the next turn attaches: the last row of the walk that is not a
   *  boundary row, boundary rows resetting it — so a bare wipe yields null,
   *  an up_to compaction its last preserved relinked row, a from-shape
   *  compaction its summary, and any later entry itself (system and
   *  attachment entries included: the CLI parents turns on them).
   *  `contextAt(leaf)` is the context the next turn will see. */
  readonly leaf: TreeNodeRef | null;
  private readonly relinkedOccurrencesOf: ReadonlyMap<UUID, TreeNodeStr[]>;

  constructor(
    parentMap: ParentMap,
    excluded: ReadonlySet<UUID>,
    leaf: TreeNodeRef | null,
    relinkedOccurrencesOf: ReadonlyMap<UUID, TreeNodeStr[]>,
  ) {
    this.parentMap = parentMap;
    this.excluded = excluded;
    this.leaf = leaf;
    this.relinkedOccurrencesOf = relinkedOccurrencesOf;
  }

  /** Every occurrence of `uuid`, in materialization order. */
  occurrencesOf(uuid: UUID): TreeNodeStr[] {
    return [
      ...(this.parentMap.has(uuid) ? [uuid] : []),
      ...(this.relinkedOccurrencesOf.get(uuid) ?? []),
    ];
  }

  /** The context predecessor of `id`: its nearest non-excluded ancestor. */
  nonExcludedPredecessor(id: TreeNodeStr): TreeNodeStr | null {
    let current = this.parentMap.get(id) ?? null;
    while (
      current !== null &&
      this.excluded.has(parseTreeNodeRef(current).uuid)
    ) {
      current = this.parentMap.get(current) ?? null;
    }
    return current;
  }

  /** The assistant context with `ref` as the tip. Throws on a ref absent
   *  from parentMap. */
  contextAt(ref: TreeNodeRef): TreeNodeRef[] {
    const tip = formatTreeNodeRef(ref);
    if (!this.parentMap.has(tip)) {
      throw new Error(`contextAt: ${tip} is not a context-tree occurrence`);
    }
    const path: TreeNodeRef[] = [];
    for (
      let current: TreeNodeStr | null = tip;
      current !== null;
      current = this.parentMap.get(current) ?? null
    ) {
      const parsed = parseTreeNodeRef(current);
      if (!this.excluded.has(parsed.uuid)) {
        path.push(parsed);
      }
    }
    path.reverse();
    return path;
  }
}

/** The context tree of a full tree as it grows, with byUuid holding every
 *  entry the full tree has placed; throws when they disagree or a parent
 *  follows its child. Tool groups are linearized in canonical file order,
 *  which deliberately differs from the loader's splice order
 *  (docs/specs/context-tree.md, Edge cases). */
export class ContextTreeBuilder {
  private readonly fullTree: FullTreeView;
  private readonly byUuid: ReadonlyMap<UUID, SessionEntry>;
  private readonly parentMap = new Map<TreeNodeStr, TreeNodeStr | null>();
  private readonly relinkedOccurrencesOf = new Map<UUID, TreeNodeStr[]>();
  private readonly excluded = new Set<UUID>();
  /** usage/model of every placed non-sidechain assistant, taken at push so
   *  lastAssistantOn reads no entries (the daemon drops them once
   *  consumed). */
  private readonly assistantUsage = new Map<
    UUID,
    { usage?: NonNullableUsage; model?: string }
  >();
  /** Boundary entries placed so far: what a later occurrence's parent
   *  check needs once the caller has dropped the entry itself. */
  private readonly boundaryUuids = new Set<UUID>();
  private leaf: TreeNodeRef | null = null;
  private group: ToolGroup | undefined;
  /** Index into fullTree.nodes of the next node to place. */
  private cursor = 0;
  private finished = false;

  constructor(fullTree: FullTreeView, byUuid: ReadonlyMap<UUID, SessionEntry>) {
    this.fullTree = fullTree;
    this.byUuid = byUuid;
  }

  /** Live view over the builder's maps: parentMap/excluded/leaf reflect
   *  every push so far. */
  get tree(): ContextTree {
    return new ContextTree(
      this.parentMap,
      this.excluded,
      this.leaf,
      this.relinkedOccurrencesOf,
    );
  }

  get awaitingAnchors(): readonly UUID[] {
    return this.fullTree.awaitingAnchors;
  }

  /** Consume the full-tree nodes materialized since the last push. */
  push(): void {
    if (this.finished) {
      throw new Error("ContextTreeBuilder: push after finish");
    }
    const nodes = this.fullTree.nodes;
    for (; this.cursor < nodes.length; this.cursor++) {
      this.place(nodes[this.cursor]!);
    }
  }

  /** End of input: the open tool group ends at the file's end. The daemon
   *  never calls it; live, a call awaits its result. */
  finish(): void {
    this.finished = true;
    this.endGroup(true);
  }

  /** usage/model of the last non-excluded, non-sidechain assistant on
   *  contextAt(ref): a parent walk from ref over the per-assistant record
   *  (no memo — exclusion is retroactive at group end); O(distance to the
   *  previous eligible assistant). */
  lastAssistantOn(
    ref: TreeNodeRef,
  ): { usage?: NonNullableUsage; model?: string } | undefined {
    for (
      let current: TreeNodeStr | null = formatTreeNodeRef(ref);
      current !== null;
      current = this.parentMap.get(current) ?? null
    ) {
      const uuid = parseTreeNodeRef(current).uuid;
      const recorded = this.assistantUsage.get(uuid);
      if (recorded !== undefined && !this.excluded.has(uuid)) {
        return recorded;
      }
    }
    return undefined;
  }

  private entryOf(id: TreeNodeStr): UuidEntry {
    const entry = this.byUuid.get(parseTreeNodeRef(id).uuid);
    if (entry === undefined || !hasUuid(entry)) {
      throw new Error(`ContextTreeBuilder: ${id} names no entry`);
    }
    return entry;
  }

  private endGroup(atFileEnd: boolean): void {
    for (const uuid of this.group?.excludedAtEnd(atFileEnd) ?? []) {
      this.excluded.add(uuid);
    }
    this.group = undefined;
  }

  /** The entry is read at its raw placement only — every judgement a
   *  relinked occurrence needs was recorded then — so a caller may drop
   *  an entry from byUuid once its raw node is consumed. */
  private place(id: TreeNodeStr): void {
    const ref = parseTreeNodeRef(id);
    let parent = this.fullTree.parentMap.get(id) ?? null;
    if (ref.viaBoundary !== undefined) {
      const occurrences = this.relinkedOccurrencesOf.get(ref.uuid);
      if (occurrences === undefined) {
        this.relinkedOccurrencesOf.set(ref.uuid, [id]);
      } else {
        occurrences.push(id);
      }
    } else {
      const entry = this.entryOf(id);
      if (entry.type === "assistant" && entry.isSidechain !== true) {
        const message = entry.message as SDKAssistantMessage["message"];
        this.assistantUsage.set(ref.uuid, {
          ...(message.usage !== undefined && {
            usage: toNonNullableUsage(message.usage),
          }),
          ...(message.model !== undefined && { model: message.model }),
        });
      }
      if (entry.subtype === "compact_boundary") {
        this.boundaryUuids.add(ref.uuid);
      }
      const groupPredecessor = this.group?.push(entry);
      if (groupPredecessor !== undefined) {
        parent = groupPredecessor;
      } else {
        this.endGroup(false);
        this.group =
          entry.type === "assistant" ? new ToolGroup(entry) : undefined;
      }
      // A result whose call entry is not in the tree (none in the file, or
      // not before the result) can never be preserved.
      if (
        isToolResultEntry(entry) &&
        (entry.parentUuid == null ||
          !this.fullTree.parentMap.has(
            formatTreeNodeRef({ uuid: entry.parentUuid }),
          ))
      ) {
        this.excluded.add(ref.uuid);
      }
    }
    if (this.boundaryUuids.has(ref.uuid)) {
      this.leaf = null;
      return;
    }
    if (
      parent !== null &&
      this.boundaryUuids.has(parseTreeNodeRef(parent).uuid)
    ) {
      parent = null;
    }
    if (parent !== null && !this.parentMap.has(parent)) {
      throw new Error(
        `ContextTreeBuilder: ${id} precedes its parent ${parent}`,
      );
    }
    this.parentMap.set(id, parent);
    this.leaf = ref;
  }
}

/** The context tree of a whole-file tree built by buildTree, with byUuid
 *  from entriesByUuid over the same entries. */
export function toContextTree(
  fullTree: ParentMap,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): ContextTree {
  const builder = new ContextTreeBuilder(finishedTreeView(fullTree), byUuid);
  builder.push();
  builder.finish();
  return builder.tree;
}

export interface PreservedListMatch {
  /** Occurrence id whose context the list's matched prefix reproduces. */
  branchPoint: TreeNodeStr;
  /** Index into preservedUuids of the first non-excluded entry that did not
   *  match; preservedUuids.length when everything matched (pure rewind). */
  remainderFrom: number;
}

/** Where a boundary's preserved list branches off the context tree: the
 *  list is walked forward as a path through `materialized` occurrences
 *  (matching details in docs/specs/context-tree.md). Undefined when the
 *  list matches nothing branchable — the boundary is a new root. */
export function matchPreservedList(
  contextTree: ContextTree,
  preservedUuids: readonly UUID[],
  anchorIsSummary: boolean,
  materialized: Pick<ReadonlySet<TreeNodeStr>, "has">,
  hidden: ReadonlySet<TreeNodeStr>,
): PreservedListMatch | undefined {
  /** Occurrences of the previous list entry the path may continue from;
   *  undefined before the first non-excluded entry. */
  let previous: ReadonlySet<TreeNodeStr> | undefined;
  let deepest: TreeNodeStr[] | undefined;
  let index = 0;
  for (; index < preservedUuids.length; index++) {
    const uuid = preservedUuids[index]!;
    if (contextTree.excluded.has(uuid)) {
      continue;
    }
    const continuesPath = (occurrence: TreeNodeStr): boolean => {
      if (!materialized.has(occurrence)) {
        return false;
      }
      const predecessor = contextTree.nonExcludedPredecessor(occurrence);
      if (previous === undefined) {
        // The list's first entry must be a context root, except under a
        // summary (native compaction lists a mid-context suffix).
        return anchorIsSummary || predecessor === null;
      }
      return predecessor !== null && previous.has(predecessor);
    };
    const candidates = contextTree.occurrencesOf(uuid).filter(continuesPath);
    if (candidates.length === 0) {
      break;
    }
    previous = new Set(candidates);
    deepest = candidates;
  }
  const branchPoint = deepest?.find((occurrence) => !hidden.has(occurrence));
  return branchPoint === undefined
    ? undefined
    : { branchPoint, remainderFrom: index };
}
