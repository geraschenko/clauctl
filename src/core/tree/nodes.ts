/**
 * The tree vocabulary and pure tree operations: ref/node types shared by
 * the loader model (loader.ts), tree construction (build-tree.ts), and
 * every consumer of get-entries output. Its only non-core dependency is
 * the shared ParentMap type; construction stays in build-tree.ts — it
 * needs the relink machinery.
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session/file.ts";
import type { ParentMap } from "../../format/generated/flat-tree.ts";
import { isUuidPrefix, resolveUuidPrefix, UUID_PATTERN } from "../uuid.ts";

export type { ParentMap };

/** Identifies one tree occurrence: a raw node (viaBoundary absent) or a
 *  boundary-substructure relinked node (viaBoundary = the boundary's
 *  uuid). */
export interface TreeNodeRef {
  uuid: UUID;
  viaBoundary?: UUID;
}

/** The tree as its parent relation: child occurrence id → parent occurrence
 *  id (null = root). Both sides are formatTreeNodeRef output — Map keys need
 *  strings because JS Maps compare objects by reference (refs are produced
 *  independently: fold, wire, parse), and the value matches so edges stay in
 *  one id space and the map composes with itself (`id = map.get(id)` walks
 *  up). Iteration order = materialization order: raw entries at file
 *  position, relinked occurrences at their boundary's file position.
 *  Deliberately flat: a nested node type nests one JSON level per entry on a
 *  mostly-linear session, and JSON.stringify overflows the call stack near
 *  depth ~5000. ParentMap is re-exported above to preserve this core API. */

/** get-entries response: every file entry verbatim, plus the daemon-computed
 *  context tip resolved to its occurrence in these entries. Entries lacking
 *  a uuid (file-history-snapshot, queue-operation) get no tree occurrence
 *  and are visible in `entries` only. */
export interface SessionSnapshot {
  entries: SessionEntry[];
  /** The current-leaf occurrence — where the next turn attaches. The tip of
   *  the current effective context, daemon-computed (loadedContext minus a
   *  live filterTail override). Null when the session has no chain
   *  entries. */
  leaf: TreeNodeRef | null;
}

/** "<uuid>" or "<uuid>@<viaBoundary>" ("@" cannot appear in a uuid). */
export function formatTreeNodeRef(ref: TreeNodeRef): string {
  return ref.viaBoundary === undefined
    ? ref.uuid
    : `${ref.uuid}@${ref.viaBoundary}`;
}

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

/** parseTreeNodeRef where each "@"-separated half may also be a unique
 *  prefix of a session entry uuid; full uuids pass through unresolved (and
 *  unchecked — the daemon keeps membership validation). Throws on malformed
 *  input like parseTreeNodeRef, and on unresolvable prefixes like
 *  resolveUuidPrefix. */
export function resolveTreeNodeRef(
  text: string,
  sessionUuids: ReadonlySet<UUID>,
): TreeNodeRef {
  const [uuid, viaBoundary, ...rest] = text.split("@");
  if (
    rest.length > 0 ||
    uuid === undefined ||
    !isUuidPrefix(uuid) ||
    (viaBoundary !== undefined && !isUuidPrefix(viaBoundary))
  ) {
    throw new Error(
      `expected "<uuid>" or "<uuid>@<boundary-uuid>" (unique prefixes ` +
        `accepted), got ${JSON.stringify(text)}`,
    );
  }
  const resolve = (half: string): UUID =>
    UUID_PATTERN.test(half)
      ? (half as UUID)
      : resolveUuidPrefix(half, sessionUuids);
  return {
    uuid: resolve(uuid),
    ...(viaBoundary !== undefined && { viaBoundary: resolve(viaBoundary) }),
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
 *  from the tree. Iterative parent walk (no recursion). Throws on a parent
 *  cycle or an occurrence whose uuid is missing from byUuid — both are
 *  corruption, impossible from buildTree + entriesByUuid over the same
 *  entries. */
export function pathToLeaf(
  parentMap: ParentMap,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
  leaf: TreeNodeRef | null,
): TreeNodeRef[] {
  if (leaf === null || !parentMap.has(formatTreeNodeRef(leaf))) {
    return [];
  }
  const path: TreeNodeRef[] = [];
  const seen = new Set<string>();
  let current: string | null = formatTreeNodeRef(leaf);
  while (current !== null) {
    if (seen.has(current)) {
      throw new Error(`pathToLeaf revisited ${current} — parent cycle`);
    }
    seen.add(current);
    // A recorded parent always names a tree occurrence (buildTree falls
    // back to root otherwise), so mid-walk absence is corruption.
    const parent: string | null | undefined = parentMap.get(current);
    if (parent === undefined) {
      throw new Error(`pathToLeaf: parent ${current} names no tree occurrence`);
    }
    const ref = parseTreeNodeRef(current);
    if (!byUuid.has(ref.uuid)) {
      throw new Error(`pathToLeaf: no entry for uuid ${ref.uuid}`);
    }
    path.push(ref);
    current = parent;
  }
  path.reverse();
  return path;
}

/** Child occurrence ids per parent id, roots under null. Materialization
 *  order. Derived by inverting `parentMap`. */
export function treeChildren(
  parentMap: ParentMap,
): Map<string | null, string[]> {
  const children = new Map<string | null, string[]>();
  for (const [id, parent] of parentMap) {
    const siblings = children.get(parent);
    if (siblings === undefined) {
      children.set(parent, [id]);
    } else {
      siblings.push(id);
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
  id: string,
  children: ReadonlyMap<string | null, readonly string[]>,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): boolean {
  const entry = byUuid.get(parseTreeNodeRef(id).uuid);
  if (entry?.type !== "assistant") {
    return false;
  }
  const apiMessageId = apiMessageIdOf(entry);
  if (apiMessageId === undefined) {
    return true;
  }
  const childIds = children.get(id) ?? [];
  return !childIds.some(
    (child) =>
      apiMessageIdOf(byUuid.get(parseTreeNodeRef(child).uuid)) === apiMessageId,
  );
}
