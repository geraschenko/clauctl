// The recorded query/session pair in docs/derisk/stream-classification/
// captures/ pins two things: the classification table (spec, Classification)
// — for every uuid-carrying item the function's verdict equals what the other
// stream actually carried — and merge equivalence (spec, success criterion
// 3): folding the pair in any per-stream-ordered interleaving resolves every
// id, settles, and raises no anomaly.

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState, AgentEvent } from "./protocol/index.ts";
import {
  excludedFromQuery,
  excludedFromSession,
  initialAgentState,
  nextAgentState,
  settled,
} from "./agent-state/index.ts";
import { hasUuid, readSessionEntries } from "./session/file.ts";

const CAPTURES = new URL(
  "../../docs/derisk/stream-classification/captures/",
  import.meta.url,
);

const events: SDKMessage[] = readFileSync(new URL("events.jsonl", CAPTURES))
  .toString()
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as SDKMessage);
const entries = readSessionEntries(
  fileURLToPath(new URL("session.jsonl", CAPTURES)),
);

const queryUuids = new Set(events.map((message) => message.uuid));
const fileUuids = new Set(entries.map((entry) => entry.uuid));

test("excludedFromSession: a query message is excluded iff the file never carried its uuid", () => {
  assert.ok(events.length > 100);
  for (const message of events) {
    if (message.uuid === undefined) continue;
    assert.equal(
      excludedFromSession(message),
      !fileUuids.has(message.uuid),
      `${message.type}/${"subtype" in message ? message.subtype : "-"} ${message.uuid}`,
    );
  }
});

test("excludedFromQuery: a session entry is excluded iff the query stream never carried its uuid", () => {
  const stdout = entries.filter(
    (entry) =>
      entry.type === "user" &&
      typeof (entry.message as { content?: unknown }).content === "string" &&
      (entry.message as { content: string }).content.startsWith(
        "<local-command-stdout>",
      ),
  );
  assert.equal(
    stdout.length,
    1,
    "the pair should hold /compact's stdout entry",
  );
  for (const entry of entries.filter(hasUuid)) {
    assert.equal(
      excludedFromQuery(entry),
      !queryUuids.has(entry.uuid),
      `${entry.type}/${entry.subtype ?? "-"} ${entry.uuid}`,
    );
  }
});

// The recorded pair predates both `<synthetic>` assistant classes, so their
// rows are pinned on hand-built entries; tests/sdk/synthetic-assistant.test.ts
// checks the same verdicts against a live CLI.
test("excludedFromQuery: <synthetic> assistant entries split on isApiErrorMessage", () => {
  const synthetic = (text: string, isApiErrorMessage: boolean) => ({
    type: "assistant",
    uuid: randomUUID(),
    isApiErrorMessage,
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
    },
  });
  assert.equal(
    excludedFromQuery(synthetic("No response requested.", false)),
    true,
    "the resume turn closer is session-only",
  );
  assert.equal(
    excludedFromQuery(synthetic("API Error: 529 Overloaded", true)),
    false,
    "an API-error synthetic is shared",
  );
  assert.equal(
    excludedFromQuery({
      type: "assistant",
      uuid: randomUUID(),
      message: {
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [],
      },
    }),
    false,
    "a real assistant message is shared",
  );
});

// --- merge equivalence -------------------------------------------------------

const sessionId = "42a85bcd-fc5b-46ee-ba69-39fa6be66287" as UUID;
// As the hub publishes messages: a uuid-less one stamped.
const queryEvents: AgentEvent[] = events.map((message) => ({
  kind: "sdkMessage",
  message,
  ...(message.uuid === undefined ? { uuid: randomUUID() } : {}),
}));
// As TrackedSessionLog publishes entries: classified, the entry itself the
// leaf, nothing awaiting an anchor (the pair has one ordinary compaction),
// a uuid-less one stamped.
const logEvents: AgentEvent[] = entries.map((entry) => ({
  kind: "sessionEntry",
  entry,
  expectsSdkMessage: !excludedFromQuery(entry),
  leaf: hasUuid(entry) ? { uuid: entry.uuid } : null,
  awaitingAnchors: [],
  ...(hasUuid(entry) ? {} : { uuid: randomUUID() }),
}));
const fileOpened: AgentEvent[] = [
  { kind: "querySessionChanged", sessionId },
  { kind: "sessionFileChanged", sessionId },
  { kind: "scanComplete", uuid: randomUUID() },
];

function alternate(left: AgentEvent[], right: AgentEvent[]): AgentEvent[] {
  const merged: AgentEvent[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (i < left.length) merged.push(left[i]!);
    if (i < right.length) merged.push(right[i]!);
  }
  return merged;
}

function foldWithoutAnomaly(sequence: AgentEvent[]): AgentState {
  let state = initialAgentState();
  for (const event of sequence) {
    state = nextAgentState(state, event);
    assert.equal(
      state.anomaly,
      undefined,
      `${event.kind}: ${JSON.stringify(state.anomaly)}`,
    );
  }
  return state;
}

for (const [name, sequence] of [
  ["query first", [...fileOpened, ...queryEvents, ...logEvents]],
  ["log first", [...fileOpened, ...logEvents, ...queryEvents]],
  ["alternating", [...fileOpened, ...alternate(queryEvents, logEvents)]],
] as const) {
  test(`merge equivalence, ${name}: every id resolves, settled, no anomaly`, () => {
    assert.equal(
      events.every((message) => message.session_id === sessionId),
      true,
    );
    const state = foldWithoutAnomaly([...sequence]);
    assert.equal(state.querySessionId, sessionId);
    assert.equal(state.fileSessionId, sessionId);
    assert.deepEqual(state.sessions[sessionId]?.merge.nodes, {});
    assert.equal(settled(state), true);
  });
}
