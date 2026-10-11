import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TimeTracker } from "./time-tracker.ts";

/** TimeTracker reads only `timestamp`. */
const at = (timestamp: string | undefined): SDKMessage =>
  ({ type: "assistant", timestamp }) as unknown as SDKMessage;

test("no previous entry → undefined", () => {
  assert.equal(
    new TimeTracker().secondsSincePrevious(at("2026-01-01T00:00:05Z")),
    undefined,
  );
});

test("seconds since the previous entry", () => {
  const tracker = new TimeTracker();
  tracker.stamp(at("2026-01-01T00:00:00Z"));
  assert.equal(tracker.secondsSincePrevious(at("2026-01-01T00:00:04.5Z")), 4.5);
});

test("time running backwards → undefined", () => {
  const tracker = new TimeTracker();
  tracker.stamp(at("2026-01-01T00:00:10Z"));
  assert.equal(
    tracker.secondsSincePrevious(at("2026-01-01T00:00:05Z")),
    undefined,
  );
});

test("stamp never moves backwards", () => {
  const tracker = new TimeTracker();
  tracker.stamp(at("2026-01-01T00:00:10Z"));
  tracker.stamp(at("2026-01-01T00:00:05Z"));
  assert.equal(tracker.secondsSincePrevious(at("2026-01-01T00:00:12Z")), 2);
});

test("a missing or invalid timestamp uses arrival time", (context) => {
  context.mock.method(Date, "now", () => Date.parse("2026-01-01T00:00:07Z"));
  for (const timestamp of [undefined, "not a date"]) {
    const tracker = new TimeTracker();
    tracker.stamp(at("2026-01-01T00:00:00Z"));
    assert.equal(tracker.secondsSincePrevious(at(timestamp)), 7);
    tracker.stamp(at(timestamp));
    assert.equal(tracker.secondsSincePrevious(at("2026-01-01T00:00:10Z")), 3);
  }
});
