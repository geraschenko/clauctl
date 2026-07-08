import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelCommand } from "./interactive-mode.ts";

test("bare /model opens the menu", () => {
  assert.deepEqual(parseModelCommand("/model"), { model: undefined });
  assert.deepEqual(parseModelCommand("  /model  "), { model: undefined });
});

test("/model with an argument passes the trimmed remainder verbatim", () => {
  assert.deepEqual(parseModelCommand("/model opus"), { model: "opus" });
  assert.deepEqual(parseModelCommand("/model  claude-sonnet-4-6  "), {
    model: "claude-sonnet-4-6",
  });
  assert.deepEqual(parseModelCommand("/model opus with words"), {
    model: "opus with words",
  });
});

test("only an exact case-sensitive /model token matches", () => {
  assert.equal(parseModelCommand("/Model"), null);
  assert.equal(parseModelCommand("/models"), null);
  assert.equal(parseModelCommand("/model/x"), null);
  assert.equal(parseModelCommand("model"), null);
  assert.equal(parseModelCommand("tell me about /model"), null);
  assert.equal(parseModelCommand("/compact"), null);
});
