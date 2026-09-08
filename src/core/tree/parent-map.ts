/**
 * Portable tree primitives over a flat parent relation. No clauctl
 * imports, so pictl can adopt the file verbatim.
 */

/** A serialized tree occurrence id: "<uuid>" or "<uuid>@<boundary-uuid>"
 *  (formatTreeNodeRef output). Strings because Maps compare objects by
 *  reference and refs are produced independently (fold, wire, parse). */
export type TreeNodeStr = string;

/** Child id → parent id (null = root). Iteration order = materialization
 *  order; a node always follows its parent. */
export type ParentMap = ReadonlyMap<TreeNodeStr, TreeNodeStr | null>;

/** Child ids per parent id, roots under null, in ParentMap order. */
export function treeChildren(
  parentMap: ParentMap,
): Map<TreeNodeStr | null, TreeNodeStr[]> {
  const children = new Map<TreeNodeStr | null, TreeNodeStr[]>();
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
