/**
 * The forest vocabulary and pure forest operations: ref/node types shared by
 * the chain computation (effective-chain.ts), forest construction
 * (forest.ts), and every consumer of get-entries output. Depends only on
 * session-file types, so both siblings import from here without a cycle;
 * `buildForest` itself stays in forest.ts — construction needs the relink
 * machinery.
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "./session-file.ts";

/** Identifies one forest occurrence: a raw node (viaBoundary absent) or a
 *  boundary-substructure relinked node (viaBoundary = the boundary's
 *  uuid). */
export interface TreeNodeRef {
  uuid: UUID;
  viaBoundary?: UUID;
}

export interface ForestNode {
  ref: TreeNodeRef;
  /** Null = root. */
  parent: TreeNodeRef | null;
}

/** Parent relation over occurrences. Key: formatTreeNodeRef(node.ref) —
 *  string keys because Map uses reference equality for objects and refs are
 *  produced independently (fold, wire, parse). Iteration order =
 *  materialization order: raw entries at file position, relinked occurrences
 *  at their boundary's summary position. Deliberately flat: a nested node
 *  type nests one JSON level per entry on a mostly-linear session, and
 *  JSON.stringify overflows the call stack near depth ~5000. */
export type Forest = ReadonlyMap<string, ForestNode>;

/** get-entries response: every file entry verbatim, plus the daemon-computed
 *  context tip resolved to its occurrence in these entries. Entries lacking
 *  a uuid (file-history-snapshot, queue-operation) get no forest occurrence
 *  and are visible in `entries` only. */
export interface SessionSnapshot {
  entries: SessionEntry[];
  /** The current-leaf occurrence — where the next turn attaches. The tip of
   *  the current effective context, daemon-computed (effectiveTreeNodeChain
   *  minus a live filterTail override). Null when the session has no chain
   *  entries. */
  leaf: TreeNodeRef | null;
}

/** One occurrence with its entry payload — the render/path unit. */
export interface PathNode {
  ref: TreeNodeRef;
  entry: SessionEntry;
}

/** "<uuid>" or "<uuid>@<viaBoundary>" ("@" cannot appear in a uuid). */
export function formatTreeNodeRef(ref: TreeNodeRef): string {
  return ref.viaBoundary === undefined
    ? ref.uuid
    : `${ref.uuid}@${ref.viaBoundary}`;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Inverse of formatTreeNodeRef; throws on malformed input. */
export function parseTreeNodeRef(text: string): TreeNodeRef {
  const [uuid, viaBoundary, ...rest] = text.split("@");
  if (
    rest.length > 0 ||
    uuid === undefined ||
    !UUID_PATTERN.test(uuid) ||
    (viaBoundary !== undefined && !UUID_PATTERN.test(viaBoundary))
  ) {
    throw new Error(
      `expected "<uuid>" or "<uuid>@<boundary-uuid>", got ${JSON.stringify(text)}`,
    );
  }
  return {
    uuid: uuid as UUID,
    ...(viaBoundary !== undefined && { viaBoundary: viaBoundary as UUID }),
  };
}

/** Structural equality (uuid + viaBoundary); undefined equals undefined.
 *  Needed because refs are produced independently (the state fold,
 *  set-context, seedFromEntries, wire deserialization), so `===` reference
 *  equality never holds between them. */
export function treeNodeRefsEqual(
  a: TreeNodeRef | undefined,
  b: TreeNodeRef | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.uuid === b.uuid && a.viaBoundary === b.viaBoundary;
}

/** Root-first path to the leaf occurrence; [] when leaf is null or absent
 *  from the forest. Iterative parent walk (no recursion). Throws on a parent
 *  cycle or an occurrence whose uuid is missing from entryOf — both are
 *  corruption, impossible from buildForest + entriesByUuid over the same
 *  entries. */
export function pathToLeaf(
  forest: Forest,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
  leaf: TreeNodeRef | null,
): PathNode[] {
  if (leaf === null || !forest.has(formatTreeNodeRef(leaf))) {
    return [];
  }
  const path: PathNode[] = [];
  const seen = new Set<string>();
  let current: TreeNodeRef | null = leaf;
  while (current !== null) {
    const key = formatTreeNodeRef(current);
    if (seen.has(key)) {
      throw new Error(`pathToLeaf revisited ${key} — parent cycle`);
    }
    seen.add(key);
    // A recorded parent always names a forest occurrence (buildForest falls
    // back to root otherwise), so mid-walk absence is corruption.
    const node = forest.get(key);
    if (node === undefined) {
      throw new Error(`pathToLeaf: parent ${key} names no forest occurrence`);
    }
    const entry = entryOf.get(current.uuid);
    if (entry === undefined) {
      throw new Error(`pathToLeaf: no entry for uuid ${current.uuid}`);
    }
    path.push({ ref: node.ref, entry });
    current = node.parent;
  }
  path.reverse();
  return path;
}

/** Children per parent key (formatTreeNodeRef), roots under null.
 *  Materialization order. Derived by inverting `forest`. */
export function forestChildren(
  forest: Forest,
): Map<string | null, TreeNodeRef[]> {
  const children = new Map<string | null, TreeNodeRef[]>();
  for (const node of forest.values()) {
    const parentKey =
      node.parent === null ? null : formatTreeNodeRef(node.parent);
    const siblings = children.get(parentKey);
    if (siblings === undefined) {
      children.set(parentKey, [node.ref]);
    } else {
      siblings.push(node.ref);
    }
  }
  return children;
}

function apiMessageIdOf(entry: SessionEntry | undefined): string | undefined {
  return (entry?.message as { id?: string } | undefined)?.id;
}

/** No child of this occurrence continues the same assistant API message
 *  (shares message.id) — the entry is a valid rewindTo target. False for
 *  non-assistant entries. */
export function isFinalAssistantEntry(
  ref: TreeNodeRef,
  children: ReadonlyMap<string | null, readonly TreeNodeRef[]>,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
): boolean {
  const entry = entryOf.get(ref.uuid);
  if (entry?.type !== "assistant") {
    return false;
  }
  const apiMessageId = apiMessageIdOf(entry);
  if (apiMessageId === undefined) {
    return true;
  }
  const childRefs = children.get(formatTreeNodeRef(ref)) ?? [];
  return !childRefs.some(
    (child) => apiMessageIdOf(entryOf.get(child.uuid)) === apiMessageId,
  );
}
