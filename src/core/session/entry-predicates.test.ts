import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry } from "./file.ts";
import { isHumanPrompt } from "./entry-predicates.ts";

const uuid = (n: number): UUID =>
  `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000` as UUID;

/** A user entry with text that the CLI did not attribute to the human
 *  (command echo, isMeta expansion, task notification): origin-era writer,
 *  no `origin`. */
function nonHumanUserEntry(entryUuid: UUID, text: string): SessionEntry {
  return {
    uuid: entryUuid,
    parentUuid: null,
    type: "user",
    version: "2.1.258",
    message: { role: "user", content: text },
  };
}

/** A prompt the human typed, as an origin-era CLI records it. */
function userEntry(entryUuid: UUID, text: string): SessionEntry {
  return { ...nonHumanUserEntry(entryUuid, text), origin: { kind: "human" } };
}

function assistantEntry(entryUuid: UUID, text: string): SessionEntry {
  return {
    uuid: entryUuid,
    parentUuid: null,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    },
  };
}

test("isHumanPrompt on origin-era entries is the CLI's origin verdict", () => {
  assert.ok(isHumanPrompt(userEntry(uuid(1), "typed")));
  assert.ok(
    isHumanPrompt(
      userEntry(
        uuid(1),
        "<command-message>spec</command-message><command-args>x</command-args>",
      ),
    ),
  );
  for (const entry of [
    nonHumanUserEntry(uuid(1), "<command-name>/compact</command-name>"),
    nonHumanUserEntry(
      uuid(1),
      "<local-command-stdout>Compacted</local-command-stdout>",
    ),
    nonHumanUserEntry(uuid(1), "[Request interrupted by user]"),
    nonHumanUserEntry(uuid(1), "plain text without origin"),
    { ...nonHumanUserEntry(uuid(1), "meta text"), isMeta: true },
    { ...nonHumanUserEntry(uuid(1), "recap"), isCompactSummary: true },
    {
      ...nonHumanUserEntry(uuid(1), "done"),
      origin: { kind: "task-notification" },
    },
    { ...nonHumanUserEntry(uuid(1), "done"), origin: { kind: "robot" } },
    { ...nonHumanUserEntry(uuid(1), "done"), origin: "human" },
    { ...assistantEntry(uuid(1), "reply"), origin: { kind: "human" } },
    {
      ...nonHumanUserEntry(uuid(1), ""),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    },
  ]) {
    assert.ok(!isHumanPrompt(entry), JSON.stringify(entry));
  }
});

// TEMPORARY with the fallback (entry-predicates.ts PRE_ORIGIN_NON_HUMAN_PREFIXES).
test("isHumanPrompt before 2.1.190 falls back to isMeta and the echo prefixes", () => {
  const old = (text: string, version?: string): SessionEntry => ({
    ...nonHumanUserEntry(uuid(1), text),
    ...(version === undefined ? { version: undefined } : { version }),
  });
  assert.ok(isHumanPrompt(old("typed", "2.1.126")));
  assert.ok(isHumanPrompt(old("typed")));
  assert.ok(isHumanPrompt(old("typed", "unversioned")));
  // Numeric, element-wise comparison: 2.1.9 precedes 2.1.190.
  assert.ok(isHumanPrompt(old("typed", "2.1.9")));
  assert.ok(!isHumanPrompt(old("typed", "2.1.190")));
  for (const text of [
    "<command-name>/compact</command-name>",
    "<local-command-stdout>Compacted</local-command-stdout>",
    "<bash-input>ls</bash-input>",
    "<bash-stdout>a b</bash-stdout>",
    "[Request interrupted by user]",
  ]) {
    assert.ok(!isHumanPrompt(old(text, "2.1.126")), text);
  }
  assert.ok(!isHumanPrompt({ ...old("meta", "2.1.126"), isMeta: true }));
});
