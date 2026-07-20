// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import assert from "node:assert/strict";
import { test } from "node:test";
import { toLayoutTree } from "./flat-tree.ts";

interface Shape {
  readonly id: string;
  readonly children: readonly Shape[];
}

function shape(node: {
  readonly id: string;
  readonly children: readonly Shape[];
}): Shape {
  return { id: node.id, children: node.children.map(shape) };
}

test("toLayoutTree nests children under parents with payloads", () => {
  const parentMap = new Map<string, string | null>([
    ["root", null],
    ["a", "root"],
    ["b", "root"],
    ["a1", "a"],
  ]);

  const roots = toLayoutTree(parentMap, (id) => id.toUpperCase());

  assert.deepEqual(roots.map(shape), [
    {
      id: "root",
      children: [
        { id: "a", children: [{ id: "a1", children: [] }] },
        { id: "b", children: [] },
      ],
    },
  ]);
  assert.equal(roots[0]?.payload, "ROOT");
  assert.equal(roots[0]?.children[0]?.children[0]?.payload, "A1");
});

test("toLayoutTree links children listed before their parent", () => {
  const parentMap = new Map<string, string | null>([
    ["child", "parent"],
    ["parent", null],
  ]);

  const roots = toLayoutTree(parentMap, () => null);

  assert.deepEqual(roots.map(shape), [
    { id: "parent", children: [{ id: "child", children: [] }] },
  ]);
});

test("toLayoutTree treats ids with missing parents as roots", () => {
  const parentMap = new Map<string, string | null>([
    ["root", null],
    ["orphan", "not-in-map"],
  ]);

  const roots = toLayoutTree(parentMap, () => null);

  assert.deepEqual(roots.map(shape), [
    { id: "root", children: [] },
    { id: "orphan", children: [] },
  ]);
});
