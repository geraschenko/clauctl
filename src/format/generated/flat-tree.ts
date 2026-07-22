// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import type { LayoutNode } from "./tree-layout.ts";

/** Child id → parent id (null = root). Iteration order = input order. */
export type ParentMap = ReadonlyMap<string, string | null>;

/** Nested LayoutNode roots from a flat parent relation. Iterative, two
 *  passes (create shells, then link), so no parent-precedes-child ordering
 *  assumption. An id whose parent is not a key of the map becomes a root —
 *  matches pi's getTree(): orphaned entries are returned as roots. */
export function toLayoutTree<TPayload>(
  parentMap: ParentMap,
  payloadOf: (id: string) => TPayload,
): LayoutNode<TPayload>[] {
  interface MutableLayoutNode {
    readonly id: string;
    readonly children: MutableLayoutNode[];
    readonly payload: TPayload;
  }
  const shells = new Map<string, MutableLayoutNode>();
  for (const id of parentMap.keys()) {
    shells.set(id, { id, children: [], payload: payloadOf(id) });
  }
  const roots: MutableLayoutNode[] = [];
  for (const [id, shell] of shells) {
    const parentId = parentMap.get(id) ?? null;
    const parent = parentId === null ? undefined : shells.get(parentId);
    if (parent === undefined) {
      roots.push(shell);
    } else {
      parent.children.push(shell);
    }
  }
  return roots;
}
