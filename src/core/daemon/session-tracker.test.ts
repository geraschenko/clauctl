import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initialAgentState } from "../agent-state.ts";
import type { AgentEvent } from "../sdk-socket.ts";
import { SessionLogFollower } from "../session/entry-stream.ts";
import type { SessionEntry } from "../session/file.ts";
import { tempDir } from "../../test-support/temp-dir.ts";
import { AnomalyRecorder } from "./anomaly-bundle.ts";
import { EventHub } from "./event-hub.ts";
import { SessionTracker } from "./session-tracker.ts";

function userEntry(uuid: UUID, text: string): SessionEntry {
  return {
    uuid,
    parentUuid: null,
    type: "user",
    message: { role: "user", content: text },
  };
}

function assistantEntry(uuid: UUID, parentUuid: UUID): SessionEntry {
  return {
    uuid,
    parentUuid,
    type: "assistant",
    message: {
      role: "assistant",
      id: "msg_1",
      model: "m",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [{ type: "text", text: "reply" }],
    },
  };
}

const line = (entry: SessionEntry): string => `${JSON.stringify(entry)}\n`;

function sessionEntries(
  events: readonly AgentEvent[],
): Extract<AgentEvent, { kind: "sessionEntry" }>[] {
  return events.filter((event) => event.kind === "sessionEntry");
}

// The data path end to end (spec, Module layering): follower →
// SessionTracker.push → EventHub.emit → sinks, on a temp file. A
// session-only entry (the prompt) crosses intact, a shared one (the
// assistant) as its structural projection; the tracker keeps only the
// index and serves payloads by range.
test("tracer: follower → tracker → hub delivers per-class entry shapes", (t) => {
  const dir = tempDir("tracer", t);
  const filePath = join(dir, "session.jsonl");
  const prompt = randomUUID();
  const reply = randomUUID();
  writeFileSync(
    filePath,
    line(userEntry(prompt, "hi")) + line(assistantEntry(reply, prompt)),
  );

  const hub = new EventHub({
    seed: initialAgentState(),
    deliver: () => {},
    tracker: () => tracker,
    log: () => {},
    anomalies: new AnomalyRecorder(dir),
  });
  const received: AgentEvent[] = [];
  hub.subscribe((event) => received.push(event));
  const tracker = new SessionTracker(filePath, () => {});
  const follower = new SessionLogFollower(
    filePath,
    (parsed) => {
      for (const event of tracker.push(parsed)) {
        hub.emit(event);
      }
    },
    (line) => assert.fail(`malformed line ${line.lineNumber}: ${line.reason}`),
    (error) => assert.fail(`follower failed: ${error}`),
  );
  follower.start();
  try {
    const [promptEvent, replyEvent] = sessionEntries(received);
    assert.deepEqual(
      [promptEvent, replyEvent].map((event) => [
        event!.entry.uuid,
        event!.expectsSdkMessage,
      ]),
      [
        [prompt, false],
        [reply, true],
      ],
    );
    assert.deepEqual(promptEvent!.entry, userEntry(prompt, "hi"));
    const structural = assistantEntry(reply, prompt);
    (structural.message as { content: { text: string }[] }).content[0]!.text =
      "";
    assert.deepEqual(replyEvent!.entry, structural);
    assert.deepEqual(
      [promptEvent, replyEvent].map((event) => [
        event!.leaf,
        event!.lastAssistant,
        event!.awaitingAnchors,
      ]),
      [
        [{ uuid: prompt }, undefined, []],
        [
          { uuid: reply },
          {
            model: "m",
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          [],
        ],
      ],
    );
    assert.equal(tracker.residentEntries, 0);
    assert.deepEqual(
      [...tracker.index].map(([uuid, { expectsSdkMessage }]) => [
        uuid,
        expectsSdkMessage,
      ]),
      [
        [prompt, false],
        [reply, true],
      ],
    );

    // Live append: a new entry and a duplicate of an old one; the duplicate
    // is first-wins dropped at the tracker.
    const late = randomUUID();
    appendFileSync(
      filePath,
      line(userEntry(late, "later")) + line(userEntry(prompt, "again")),
    );
    follower.drainVisibleBytes();
    assert.deepEqual(
      sessionEntries(received).map((event) => event.entry.uuid),
      [prompt, reply, late],
    );
    assert.deepEqual(tracker.payloads([late, reply]), [
      userEntry(late, "later"),
      assistantEntry(reply, prompt),
    ]);
  } finally {
    follower.close();
  }
});

// --- tree-facing behaviour, pushed directly (no file needed) ----------------

function boundaryEntry(
  uuid: UUID,
  preserved: UUID[],
  anchorUuid: UUID,
  logicalParentUuid: UUID | null,
): SessionEntry {
  return {
    uuid,
    parentUuid: null,
    logicalParentUuid,
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: {
      trigger: "manual",
      preservedMessages: { anchorUuid, uuids: preserved, allUuids: preserved },
    },
  };
}

function summaryEntry(uuid: UUID, boundaryUuid: UUID): SessionEntry {
  return {
    uuid,
    parentUuid: boundaryUuid,
    type: "user",
    message: { role: "user", content: "summary" },
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  };
}

const RANGE = { offset: 0, length: 0 };

function directTracker(): SessionTracker {
  return new SessionTracker("/nonexistent/session.jsonl", (message) =>
    assert.fail(`unexpected onInvalid: ${message}`),
  );
}

// An up_to compaction's boundary completes only when its summary anchors
// the block: the boundary's own push reports it awaiting; the summary's
// push emits the contextChanged with the post-push leaf (the last
// preserved relinked row), and nothing stays resident afterwards.
test("up_to boundary: contextChanged arrives with the anchoring summary", () => {
  const tracker = directTracker();
  const [prompt, reply, boundary, summary] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ] as const;
  tracker.push({ entry: userEntry(prompt, "hi"), range: RANGE });
  tracker.push({ entry: assistantEntry(reply, prompt), range: RANGE });
  const boundaryEvents = tracker.push({
    entry: boundaryEntry(boundary, [prompt, reply], summary, reply),
    range: RANGE,
  });
  assert.deepEqual(
    boundaryEvents.map((event) => event.kind),
    ["sessionEntry"],
  );
  assert.deepEqual(sessionEntries(boundaryEvents)[0]!.awaitingAnchors, [
    boundary,
  ]);
  const summaryEvents = tracker.push({
    entry: summaryEntry(summary, boundary),
    range: RANGE,
  });
  const leaf = { uuid: reply, viaBoundary: boundary };
  assert.deepEqual(
    summaryEvents.map((event) => [event.kind, event.leaf]),
    [
      ["sessionEntry", leaf],
      ["contextChanged", leaf],
    ],
  );
  assert.deepEqual(summaryEvents[1], {
    kind: "contextChanged",
    boundary,
    leaf,
  });
  assert.deepEqual(sessionEntries(summaryEvents)[0]!.awaitingAnchors, []);
  assert.equal(tracker.residentEntries, 0);
  assert.deepEqual(tracker.contextAt(leaf), [
    { uuid: summary },
    { uuid: prompt, viaBoundary: boundary },
    leaf,
  ]);
  assert.deepEqual(tracker.uuidsAfter(reply), [boundary, summary]);
  assert.deepEqual(tracker.uuidsAfter(undefined), [
    prompt,
    reply,
    boundary,
    summary,
  ]);
  assert.throws(() => tracker.uuidsAfter(randomUUID()), /unknown entry uuid/);
});

// A self-anchored boundary (bare wipe) completes on its own push.
test("self-anchored boundary: contextChanged on the boundary's own push", () => {
  const tracker = directTracker();
  const prompt = randomUUID();
  const boundary = randomUUID();
  tracker.push({ entry: userEntry(prompt, "hi"), range: RANGE });
  const events = tracker.push({
    entry: boundaryEntry(boundary, [], boundary, null),
    range: RANGE,
  });
  assert.deepEqual(
    events.map((event) => [event.kind, event.leaf]),
    [
      ["sessionEntry", null],
      ["contextChanged", null],
    ],
  );
  assert.equal(tracker.leaf, null);
});
