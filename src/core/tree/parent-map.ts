/**
 * Portable tree primitives over a flat parent relation. No clauctl
 * imports, so pictl can adopt the file verbatim.
 */

/** Child id → parent id (null = root). Iteration order = materialization
 *  order; a row always follows its parent. */
export type ParentMap = ReadonlyMap<string, string | null>;

/** Child ids per parent id, roots under null, in ParentMap order. */
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
