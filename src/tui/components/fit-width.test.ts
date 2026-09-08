import assert from "node:assert/strict";
import { test } from "node:test";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { FitWidth } from "./fit-width.ts";

const lines = (rendered: string[]): Component => ({
  render: () => rendered,
  invalidate: () => {},
});

test("an over-wide line is truncated to the width; others pass through", () => {
  const [short, long] = new FitWidth(lines(["short", "x".repeat(12)])).render(
    8,
  );
  assert.equal(short, "short");
  assert.equal(visibleWidth(long!), 8);
  assert.match(long!, /^xxxxxxx.*…/);
});
