/**
 * The tree vocabulary and pure tree operations: node/ref types shared by the
 * chain computation (effective-chain.ts), tree construction (build-tree.ts),
 * and every consumer of get-tree output. Depends only on session-file types,
 * so both siblings import from here without a cycle; `buildTree` itself stays
 * in build-tree.ts — construction needs the relink machinery.
 */

import type { UUID } from "node:crypto";
import type { SessionEntry } from "./session-file.ts";

/** Identifies one tree node: a raw node (viaBoundary absent) or a
 *  boundary-substructure relinked node (viaBoundary = the boundary's
 *  uuid). */
export interface TreeNodeRef {
  uuid: UUID;
  viaBoundary?: UUID;
}

export interface TreeNode {
  /** The entry, embedded verbatim. Entries lacking a uuid
   *  (file-history-snapshot, queue-operation) get no tree node and are
   *  visible via get-entries only. Relinked nodes (boundary substructure)
   *  serialize their payload once per node — accepted for a self-contained
   *  format input. */
  entry: SessionEntry;
  children: TreeNode[];
  /** Set when the edge to this node's parent comes from a boundary relink
   *  rather than the entry's raw parentUuid. */
  viaBoundary?: UUID;
}

export interface SessionTree {
  tree: TreeNode[];
  /** The current-leaf tree node — where the next turn attaches. The tip of
   *  the current effective context, daemon-computed (effectiveTreeNodeChain
   *  minus a live filterTail override). Null when the session has no chain
   *  entries. */
  leaf: TreeNodeRef | null;
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

function refOf(node: TreeNode): TreeNodeRef {
  return {
    uuid: node.entry.uuid!,
    ...(node.viaBoundary !== undefined && { viaBoundary: node.viaBoundary }),
  };
}

/** Root-first path to the leaf occurrence; [] when leaf is null or absent. */
export function pathToLeaf(
  tree: TreeNode[],
  leaf: TreeNodeRef | null,
): TreeNode[] {
  if (leaf === null) {
    return [];
  }
  const path: TreeNode[] = [];
  const visit = (node: TreeNode): boolean => {
    path.push(node);
    if (treeNodeRefsEqual(refOf(node), leaf)) {
      return true;
    }
    if (node.children.some(visit)) {
      return true;
    }
    path.pop();
    return false;
  };
  return tree.some(visit) ? path : [];
}

/** No child of this occurrence continues the same assistant API message
 *  (shares message.id) — the entry is a valid rewindTo target. False for
 *  non-assistant entries. */
export function isFinalAssistantEntry(node: TreeNode): boolean {
  if (node.entry.type !== "assistant") {
    return false;
  }
  const apiMessageId = (node.entry.message as { id?: string } | undefined)?.id;
  if (apiMessageId === undefined) {
    return true;
  }
  return !node.children.some(
    (child) =>
      (child.entry.message as { id?: string } | undefined)?.id === apiMessageId,
  );
}
