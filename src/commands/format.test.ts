import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry } from "../core/session/file.ts";
import { leafContext } from "./format.ts";

const uuids = Array.from(
  { length: 6 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID,
);

function entry(
  index: number,
  type: string,
  extra: Record<string, unknown> = {},
): SessionEntry {
  return {
    uuid: uuids[index],
    parentUuid: index === 0 ? null : uuids[index - 1],
    type,
    ...extra,
  };
}

const chain: SessionEntry[] = [
  entry(0, "user", { message: { role: "user", content: "a" } }),
  entry(1, "assistant", {
    message: {
      role: "assistant",
      id: "m1",
      model: "m",
      content: [{ type: "text", text: "b" }],
    },
  }),
  entry(2, "attachment", {
    attachment: { type: "total_tokens_reminder", text: "t" },
    rendered: null,
  }),
  entry(3, "user", { message: { role: "user", content: "c" } }),
  entry(4, "assistant", {
    message: {
      role: "assistant",
      id: "m2",
      model: "m",
      content: [{ type: "text", text: "d" }],
    },
  }),
];

// `clauctl get-context` prints a chain; piping it into `format api-request`
// must convert exactly that chain, so the chain's leaf context is itself.
test("a chain input is its own leaf context", () => {
  assert.deepEqual(leafContext(chain), chain);
});

test("a file input converts the leaf context, not every entry", () => {
  const sibling = entry(5, "user", { message: { role: "user", content: "e" } });
  sibling.parentUuid = uuids[1];
  const context = leafContext([...chain, sibling]);
  assert.deepEqual(
    context.map((contextEntry) => contextEntry.uuid),
    [uuids[0], uuids[1], sibling.uuid],
  );
});
