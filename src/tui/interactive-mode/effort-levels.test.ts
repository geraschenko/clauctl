import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { effortLevelsOf } from "./effort-levels.ts";

const OPUS: ModelInfo = {
  value: "opus",
  resolvedModel: "claude-opus-4-6",
  displayName: "Opus",
  description: "",
  supportedEffortLevels: ["low", "high"],
};
const HAIKU: ModelInfo = {
  value: "haiku",
  displayName: "Haiku",
  description: "",
};

test("no model matches the current one", () => {
  assert.deepEqual(effortLevelsOf([OPUS], "sonnet"), { kind: "unknownModel" });
  assert.deepEqual(effortLevelsOf([OPUS], undefined), {
    kind: "unknownModel",
  });
});

test("a model without effort levels", () => {
  assert.deepEqual(effortLevelsOf([OPUS, HAIKU], "haiku"), {
    kind: "noEffortLevels",
  });
});

test("the current model matches by value or by resolved id", () => {
  const expected = { kind: "levels", model: OPUS, levels: ["low", "high"] };
  assert.deepEqual(effortLevelsOf([HAIKU, OPUS], "opus"), expected);
  assert.deepEqual(effortLevelsOf([HAIKU, OPUS], "claude-opus-4-6"), expected);
});
