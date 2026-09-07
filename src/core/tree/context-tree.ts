/**
 * The assistant-context relation over the full tree: every occurrence
 * except boundary rows, each under its context predecessor, so the
 * root-first path to any occurrence is the assistant context there (see
 * docs/specs/context-tree.md). The middle layer between buildTree (the
 * file view) and toDisplayTree (the human view); docs/session-views.md
 * explains why the three are kept apart.
 */

import type { UUID } from "node:crypto";
import { hasUuid, type SessionEntry, type UuidEntry } from "../session/file.ts";
import {
  formatTreeNodeRef,
  parseTreeNodeRef,
  type ParentMap,
  type TreeNodeRef,
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
  private readonly relinkedOccurrencesOf: ReadonlyMap<UUID, string[]>;

  constructor(
    parentMap: ParentMap,
    excluded: ReadonlySet<UUID>,
    leaf: TreeNodeRef | null,
    relinkedOccurrencesOf: ReadonlyMap<UUID, string[]>,
  ) {
    this.parentMap = parentMap;
    this.excluded = excluded;
    this.leaf = leaf;
    this.relinkedOccurrencesOf = relinkedOccurrencesOf;
  }

  /** Every occurrence of `uuid`, in materialization order. */
  occurrencesOf(uuid: UUID): string[] {
    return [
      ...(this.parentMap.has(uuid) ? [uuid] : []),
      ...(this.relinkedOccurrencesOf.get(uuid) ?? []),
    ];
  }

  /** The context predecessor of `id`: its nearest non-excluded ancestor. */
  nonExcludedPredecessor(id: string): string | null {
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
      let current: string | null = tip;
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

/** The context tree of a full tree built by buildTree, with byUuid from
 *  entriesByUuid over the same entries; throws when they disagree or a
 *  parent follows its child. Tool groups are linearized in canonical file
 *  order, which deliberately differs from the loader's splice order
 *  (docs/specs/context-tree.md, Edge cases). */
export function toContextTree(
  fullTree: ParentMap,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): ContextTree {
  const entryOf = (id: string): UuidEntry => {
    const entry = byUuid.get(parseTreeNodeRef(id).uuid);
    if (entry === undefined || !hasUuid(entry)) {
      throw new Error(`toContextTree: ${id} names no entry`);
    }
    return entry;
  };

  const parentMap = new Map<string, string | null>();
  const relinkedOccurrencesOf = new Map<UUID, string[]>();
  const excluded = new Set<UUID>();
  let leaf: TreeNodeRef | null = null;
  let group: ToolGroup | undefined;

  for (const [id, fullParent] of fullTree) {
    const ref = parseTreeNodeRef(id);
    const entry = entryOf(id);
    let parent = fullParent;
    if (ref.viaBoundary !== undefined) {
      const occurrences = relinkedOccurrencesOf.get(ref.uuid);
      if (occurrences === undefined) {
        relinkedOccurrencesOf.set(ref.uuid, [id]);
      } else {
        occurrences.push(id);
      }
    } else {
      const groupPredecessor = group?.push(entry);
      if (groupPredecessor !== undefined) {
        parent = groupPredecessor;
      } else {
        for (const uuid of group?.excludedAtEnd() ?? []) {
          excluded.add(uuid);
        }
        group = entry.type === "assistant" ? new ToolGroup(entry) : undefined;
      }
    }
    if (entry.subtype === "compact_boundary") {
      leaf = null;
      continue;
    }
    if (
      isToolResultEntry(entry) &&
      (entry.parentUuid == null || !byUuid.has(entry.parentUuid))
    ) {
      excluded.add(ref.uuid);
    }
    if (parent !== null && entryOf(parent).subtype === "compact_boundary") {
      parent = null;
    }
    if (parent !== null && !parentMap.has(parent)) {
      throw new Error(`toContextTree: ${id} precedes its parent ${parent}`);
    }
    parentMap.set(id, parent);
    leaf = ref;
  }
  for (const uuid of group?.excludedAtEnd() ?? []) {
    excluded.add(uuid);
  }
  return new ContextTree(parentMap, excluded, leaf, relinkedOccurrencesOf);
}

export interface PreservedListMatch {
  /** Occurrence id whose context the list's matched prefix reproduces. */
  branchPoint: string;
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
  materialized: Pick<ReadonlySet<string>, "has">,
  hidden: ReadonlySet<string>,
): PreservedListMatch | undefined {
  /** Occurrences of the previous list entry the path may continue from;
   *  undefined before the first non-excluded entry. */
  let previous: ReadonlySet<string> | undefined;
  let deepest: string[] | undefined;
  let index = 0;
  for (; index < preservedUuids.length; index++) {
    const uuid = preservedUuids[index]!;
    if (contextTree.excluded.has(uuid)) {
      continue;
    }
    const continuesPath = (occurrence: string): boolean => {
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
