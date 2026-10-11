import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type { TranscriptItem } from "./transcript-item.ts";
import { TranscriptItems } from "./transcript-items.ts";

/** TranscriptItems reads only `kind` and `uuid`. */
const keyed = (uuid: string): TranscriptItem =>
  ({ kind: "plain", uuid }) as unknown as TranscriptItem;
const unkeyed = (): TranscriptItem =>
  ({ kind: "plain" }) as unknown as TranscriptItem;
const openStream = (): TranscriptItem =>
  ({ kind: "assistant" }) as unknown as TranscriptItem;

const uuid = (value: string): UUID => value as UUID;

function parts(items: TranscriptItems): {
  resolved: readonly TranscriptItem[];
  pending: readonly TranscriptItem[];
} {
  return { resolved: items.resolved, pending: items.pending };
}

test("a keyed item goes to its part", () => {
  const items = new TranscriptItems();
  const a = keyed("a");
  const b = keyed("b");
  items.insert(a, "pending");
  items.insert(b, "resolved");
  assert.deepEqual(parts(items), { resolved: [b], pending: [a] });
});

test("an unkeyed item goes to resolved when pending is empty, behind pending otherwise", () => {
  const items = new TranscriptItems();
  const first = unkeyed();
  items.insert(first, "pending");
  const a = keyed("a");
  items.insert(a, "pending");
  const second = unkeyed();
  items.insert(second, "resolved");
  assert.deepEqual(parts(items), { resolved: [first], pending: [a, second] });
});

test("an open stream's item goes to pending", () => {
  const items = new TranscriptItems();
  const stream = openStream();
  items.insert(stream, "resolved");
  assert.deepEqual(parts(items), { resolved: [], pending: [stream] });
});

test("before: in the target list inserts ahead; elsewhere or absent appends", () => {
  const items = new TranscriptItems();
  const stream = openStream();
  const r = keyed("r");
  items.insert(stream, "pending");
  items.insert(r, "resolved");
  const ahead = keyed("x");
  items.insert(ahead, "pending", stream);
  const otherList = keyed("y");
  items.insert(otherList, "resolved", stream);
  const absent = keyed("z");
  items.insert(absent, "pending", keyed("missing"));
  assert.deepEqual(parts(items), {
    resolved: [r, otherList],
    pending: [ahead, stream, absent],
  });
});

test("last: pending's last, else resolved's", () => {
  const items = new TranscriptItems();
  assert.equal(items.last(), undefined);
  const r = keyed("r");
  items.insert(r, "resolved");
  assert.equal(items.last(), r);
  const p = keyed("p");
  items.insert(p, "pending");
  assert.equal(items.last(), p);
});

test("resolveThrough moves through the last item sharing the uuid and the unkeyed items after it, stopping at a keyed item", () => {
  const items = new TranscriptItems();
  const a1 = keyed("a");
  const a2 = keyed("a");
  const banner = unkeyed();
  const b = keyed("b");
  items.insert(a1, "pending");
  items.insert(a2, "pending");
  items.insert(banner, "pending");
  items.insert(b, "pending");
  items.resolveThrough(uuid("a"));
  assert.deepEqual(parts(items), { resolved: [a1, a2, banner], pending: [b] });
});

test("resolveThrough stops at an open stream", () => {
  const items = new TranscriptItems();
  const a = keyed("a");
  const stream = openStream();
  items.insert(a, "pending");
  items.insert(stream, "pending");
  const banner = unkeyed();
  items.insert(banner, "pending");
  items.resolveThrough(uuid("a"));
  assert.deepEqual(parts(items), { resolved: [a], pending: [stream, banner] });
});

test("resolveThrough an unknown uuid is a no-op", () => {
  const items = new TranscriptItems();
  const a = keyed("a");
  items.insert(a, "pending");
  items.resolveThrough(uuid("b"));
  assert.deepEqual(parts(items), { resolved: [], pending: [a] });
});

test("removePending of an absent item is a no-op", () => {
  const items = new TranscriptItems();
  const a = keyed("a");
  items.insert(a, "pending");
  items.removePending(keyed("a"));
  assert.deepEqual(parts(items), { resolved: [], pending: [a] });
});

test("removePending of a non-head item resolves nothing", () => {
  const items = new TranscriptItems();
  const a = keyed("a");
  const stream = openStream();
  const banner = unkeyed();
  items.insert(a, "pending");
  items.insert(stream, "pending");
  items.insert(banner, "pending");
  items.removePending(stream);
  assert.deepEqual(parts(items), { resolved: [], pending: [a, banner] });
});

test("removePending of the head resolves the unkeyed items behind it, stopping at an open stream", () => {
  const items = new TranscriptItems();
  const stream = openStream();
  const banner = unkeyed();
  const later = openStream();
  const trailing = unkeyed();
  items.insert(stream, "pending");
  items.insert(banner, "pending");
  items.insert(later, "pending");
  items.insert(trailing, "pending");
  items.removePending(stream);
  assert.deepEqual(parts(items), {
    resolved: [banner],
    pending: [later, trailing],
  });
});

test("clear empties both parts", () => {
  const items = new TranscriptItems();
  items.insert(keyed("r"), "resolved");
  items.insert(keyed("p"), "pending");
  items.clear();
  assert.deepEqual(parts(items), { resolved: [], pending: [] });
});
