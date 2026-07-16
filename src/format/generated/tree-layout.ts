// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

export interface LayoutNode<P> {
  readonly id: string;
  readonly children: readonly LayoutNode<P>[];
  readonly payload: P;
}

export interface TreeGutter {
  readonly position: number;
  readonly show: boolean;
}

export interface FlatLayoutNode<P> {
  readonly node: LayoutNode<P>;
  readonly indent: number;
  readonly showConnector: boolean;
  readonly isLast: boolean;
  readonly gutters: readonly TreeGutter[];
  readonly isVirtualRootChild: boolean;
  readonly isOnActivePath: boolean;
  readonly isCurrentLeaf: boolean;
}

interface FlatLayoutNodeDraft<P> {
  node: LayoutNode<P>;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  gutters: readonly TreeGutter[];
  isVirtualRootChild: boolean;
  isOnActivePath: boolean;
  isCurrentLeaf: boolean;
}

interface StackItem<P> {
  readonly node: LayoutNode<P>;
  readonly parentId: string | null;
  readonly indent: number;
  readonly justBranched: boolean;
  readonly showConnector: boolean;
  readonly isLast: boolean;
  readonly gutters: readonly TreeGutter[];
  readonly isVirtualRootChild: boolean;
}

interface FlattenAllResult<P> {
  readonly flatNodes: readonly FlatLayoutNodeDraft<P>[];
  readonly parentById: ReadonlyMap<string, string | null>;
}

function computeContainsActive<P>(
  roots: readonly LayoutNode<P>[],
  currentLeafId: string | null,
): Map<LayoutNode<P>, boolean> {
  const containsActive = new Map<LayoutNode<P>, boolean>();
  const allNodes: LayoutNode<P>[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    allNodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  for (let index = allNodes.length - 1; index >= 0; index -= 1) {
    const node = allNodes[index];
    if (node === undefined) {
      continue;
    }
    let has = currentLeafId !== null && node.id === currentLeafId;
    for (const child of node.children) {
      if (containsActive.get(child) === true) {
        has = true;
      }
    }
    containsActive.set(node, has);
  }
  return containsActive;
}

function flattenAll<P>(
  roots: readonly LayoutNode<P>[],
  currentLeafId: string | null,
): FlattenAllResult<P> {
  const flatNodes: FlatLayoutNodeDraft<P>[] = [];
  const parentById = new Map<string, string | null>();
  const containsActive = computeContainsActive(roots, currentLeafId);
  const multipleRoots = roots.length > 1;
  const stack: StackItem<P>[] = [];
  const orderedRoots = [...roots].sort(
    (a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)),
  );

  for (let index = orderedRoots.length - 1; index >= 0; index -= 1) {
    const root = orderedRoots[index];
    if (root === undefined) {
      continue;
    }
    stack.push({
      node: root,
      parentId: null,
      indent: multipleRoots ? 1 : 0,
      justBranched: multipleRoots,
      showConnector: multipleRoots,
      isLast: index === orderedRoots.length - 1,
      gutters: [],
      isVirtualRootChild: multipleRoots,
    });
  }

  // Adapted from pi TreeSelector flattenTree indentation and active-branch ordering.
  // pi repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      continue;
    }
    if (parentById.has(item.node.id)) {
      throw new Error(`Duplicate layout node id: ${item.node.id}`);
    }
    parentById.set(item.node.id, item.parentId);
    flatNodes.push({ ...item, isOnActivePath: false, isCurrentLeaf: false });

    const multipleChildren = item.node.children.length > 1;
    const orderedChildren: LayoutNode<P>[] = [];
    for (const child of item.node.children) {
      if (containsActive.get(child) === true) {
        orderedChildren.push(child);
      }
    }
    for (const child of item.node.children) {
      if (containsActive.get(child) !== true) {
        orderedChildren.push(child);
      }
    }

    const childIndent = multipleChildren
      ? item.indent + 1
      : item.justBranched && item.indent > 0
        ? item.indent + 1
        : item.indent;
    const connectorDisplayed = item.showConnector && !item.isVirtualRootChild;
    const currentDisplayIndent = multipleRoots
      ? Math.max(0, item.indent - 1)
      : item.indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed
      ? [...item.gutters, { position: connectorPosition, show: !item.isLast }]
      : item.gutters;

    for (let index = orderedChildren.length - 1; index >= 0; index -= 1) {
      const child = orderedChildren[index];
      if (child === undefined) {
        continue;
      }
      stack.push({
        node: child,
        parentId: item.node.id,
        indent: childIndent,
        justBranched: multipleChildren,
        showConnector: multipleChildren,
        isLast: index === orderedChildren.length - 1,
        gutters: childGutters,
        isVirtualRootChild: false,
      });
    }
  }
  return { flatNodes, parentById };
}

function buildActivePath(
  parentById: ReadonlyMap<string, string | null>,
  currentLeafId: string | null,
): Set<string> {
  const path = new Set<string>();
  let currentId = currentLeafId;
  while (currentId !== null) {
    path.add(currentId);
    currentId = parentById.get(currentId) ?? null;
  }
  return path;
}

function recalculateVisibleStructure<P>(
  visibleFlatNodes: readonly FlatLayoutNodeDraft<P>[],
  parentById: ReadonlyMap<string, string | null>,
  activePath: ReadonlySet<string>,
  currentLeafId: string | null,
): readonly FlatLayoutNode<P>[] {
  const visibleIds = new Set(visibleFlatNodes.map((node) => node.node.id));
  const visibleChildren = new Map<string | null, string[]>();
  visibleChildren.set(null, []);

  for (const flatNode of visibleFlatNodes) {
    let parentId = parentById.get(flatNode.node.id) ?? null;
    while (parentId !== null && !visibleIds.has(parentId)) {
      parentId = parentById.get(parentId) ?? null;
    }
    const children = visibleChildren.get(parentId) ?? [];
    children.push(flatNode.node.id);
    visibleChildren.set(parentId, children);
  }

  const multipleRoots = (visibleChildren.get(null) ?? []).length > 1;
  const byId = new Map(visibleFlatNodes.map((node) => [node.node.id, node]));
  const result: FlatLayoutNode<P>[] = [];
  const stack: Array<{
    readonly nodeId: string;
    readonly indent: number;
    readonly justBranched: boolean;
    readonly showConnector: boolean;
    readonly isLast: boolean;
    readonly gutters: readonly TreeGutter[];
    readonly isVirtualRootChild: boolean;
  }> = [];
  const rootIds = visibleChildren.get(null) ?? [];

  for (let index = rootIds.length - 1; index >= 0; index -= 1) {
    const nodeId = rootIds[index];
    if (nodeId !== undefined) {
      stack.push({
        nodeId,
        indent: multipleRoots ? 1 : 0,
        justBranched: multipleRoots,
        showConnector: multipleRoots,
        isLast: index === rootIds.length - 1,
        gutters: [],
        isVirtualRootChild: multipleRoots,
      });
    }
  }

  // Adapted from pi TreeSelector recalculateVisualStructure.
  // pi repo-relative: packages/coding-agent/src/modes/interactive/components/tree-selector.ts
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      continue;
    }
    const flatNode = byId.get(item.nodeId);
    if (flatNode === undefined) {
      continue;
    }
    result.push({
      node: flatNode.node,
      indent: item.indent,
      showConnector: item.showConnector,
      isLast: item.isLast,
      gutters: item.gutters,
      isVirtualRootChild: item.isVirtualRootChild,
      isOnActivePath: activePath.has(item.nodeId),
      isCurrentLeaf: item.nodeId === currentLeafId,
    });

    const children = visibleChildren.get(item.nodeId) ?? [];
    const multipleChildren = children.length > 1;
    const childIndent = multipleChildren
      ? item.indent + 1
      : item.justBranched && item.indent > 0
        ? item.indent + 1
        : item.indent;
    const connectorDisplayed = item.showConnector && !item.isVirtualRootChild;
    const currentDisplayIndent = multipleRoots
      ? Math.max(0, item.indent - 1)
      : item.indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed
      ? [...item.gutters, { position: connectorPosition, show: !item.isLast }]
      : item.gutters;

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) {
        stack.push({
          nodeId: child,
          indent: childIndent,
          justBranched: multipleChildren,
          showConnector: multipleChildren,
          isLast: index === children.length - 1,
          gutters: childGutters,
          isVirtualRootChild: false,
        });
      }
    }
  }
  return result;
}

/** flattenAll → active path → filter → recalculateVisibleStructure.
 *  The predicate closes over whatever it needs (filter mode, current-leaf
 *  exemptions); pass `() => true` for the full unfiltered list. */
export function flattenVisibleTree<P>(
  roots: readonly LayoutNode<P>[],
  currentLeafId: string | null,
  passesFilter: (node: LayoutNode<P>) => boolean,
): readonly FlatLayoutNode<P>[] {
  const { flatNodes, parentById } = flattenAll(roots, currentLeafId);
  const activePath = buildActivePath(parentById, currentLeafId);
  const filtered = flatNodes.filter((flatNode) => passesFilter(flatNode.node));
  return recalculateVisibleStructure(
    filtered,
    parentById,
    activePath,
    currentLeafId,
  );
}

export function treePrefix(flatNode: FlatLayoutNode<unknown>): string {
  const displayIndent = flatNode.isVirtualRootChild
    ? Math.max(0, flatNode.indent - 1)
    : flatNode.indent;
  const connector =
    flatNode.showConnector && !flatNode.isVirtualRootChild
      ? flatNode.isLast
        ? "└─ "
        : "├─ "
      : "";
  const connectorPosition = connector === "" ? -1 : displayIndent - 1;
  const chars: string[] = [];
  for (let index = 0; index < displayIndent * 3; index += 1) {
    const level = Math.floor(index / 3);
    const posInLevel = index % 3;
    const gutter = flatNode.gutters.find(
      (candidate) => candidate.position === level,
    );
    if (gutter !== undefined) {
      chars.push(posInLevel === 0 && gutter.show ? "│" : " ");
    } else if (connector !== "" && level === connectorPosition) {
      chars.push(
        posInLevel === 0 ? (connector[0] ?? "") : posInLevel === 1 ? "─" : " ",
      );
    } else {
      chars.push(" ");
    }
  }
  return chars.join("");
}
