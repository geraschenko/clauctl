import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { appendFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  initialAgentState,
  settled,
  type TrackerAnomaly,
} from "../agent-state.ts";
import type { AgentEvent } from "../protocol.ts";
import type { SessionEntry } from "../session/file.ts";
import { tempDir } from "../../test-support/temp-dir.ts";
import { AnomalyRecorder } from "./anomaly-bundle.ts";
import { EventHub } from "./event-hub.ts";
import { RwGate } from "./rw-gate.ts";
import { TrackedSessionLog } from "./tracked-session-log.ts";

function assistantEntry(uuid: UUID, parentUuid: UUID | null): SessionEntry {
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

function assistantMessage(uuid: UUID, sessionId: UUID): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { usage: { input_tokens: 1, output_tokens: 2 }, model: "m" },
  } as unknown as SDKMessage;
}

function userEntry(uuid: UUID, parentUuid: UUID | null): SessionEntry {
  return {
    uuid,
    parentUuid,
    type: "user",
    message: { role: "user", content: "hi" },
  };
}

/** A boundary preserving `uuids` under `anchorUuid` (the summary that
 *  follows it in a CLI-written log). */
function boundaryEntry(
  uuid: UUID,
  uuids: UUID[],
  anchorUuid: UUID,
  logicalParentUuid: UUID,
): SessionEntry {
  return {
    uuid,
    parentUuid: null,
    logicalParentUuid,
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: {
      trigger: "manual",
      preservedMessages: { anchorUuid, uuids, allUuids: uuids },
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

const line = (entry: SessionEntry): string => `${JSON.stringify(entry)}\n`;

function anomalies(events: readonly AgentEvent[]): TrackerAnomaly[] {
  return events.flatMap((event) =>
    event.kind === "trackerAnomaly" ? [event.anomaly] : [],
  );
}

function harness(t: TestContext): {
  dir: string;
  hub: EventHub;
  trackedLog: TrackedSessionLog;
  /** The events received since the last drain. */
  drain: () => AgentEvent[];
  /** Resolves on the next event of this kind. */
  whenNext: (kind: AgentEvent["kind"]) => Promise<void>;
} {
  const dir = tempDir("tracked-log", t);
  const hub: EventHub = new EventHub({
    seed: initialAgentState(),
    deliver: () => {},
    tracker: () => trackedLog.tracker,
    log: () => {},
    anomalies: new AnomalyRecorder(dir),
  });
  const received: AgentEvent[] = [];
  hub.subscribe((event) => received.push(event));
  const trackedLog: TrackedSessionLog = new TrackedSessionLog({
    hub,
    gate: new RwGate(),
    sessionFilePath: (sessionId) => join(dir, `${sessionId}.jsonl`),
    onInvalid: (message) => assert.fail(`unexpected onInvalid: ${message}`),
    log: () => {},
  });
  return {
    dir,
    hub,
    trackedLog,
    drain: () => received.splice(0),
    whenNext: (kind) =>
      new Promise((resolve) => {
        const unsubscribe = hub.subscribe((event) => {
          if (event.kind === kind) {
            unsubscribe();
            resolve();
          }
        });
      }),
  };
}

// Data flow 1 then 3: the seed file is announced and scanned at start; a
// query message on another file switches the follower there once the old
// file is settled and quiet, under the gate, announcing and scanning it.
test("startup scan, then a switch to the query's file", async (t) => {
  const { dir, hub, trackedLog, drain, whenNext } = harness(t);
  const fileA = randomUUID();
  const fileB = randomUUID();
  const entryA = randomUUID();
  const entryB = randomUUID();
  writeFileSync(
    join(dir, `${fileA}.jsonl`),
    line(assistantEntry(entryA, null)),
  );
  writeFileSync(
    join(dir, `${fileB}.jsonl`),
    line(assistantEntry(entryB, null)),
  );
  try {
    trackedLog.start(fileA);
    assert.deepEqual(
      drain().map((event) => event.kind),
      ["sessionFileChanged", "sessionEntry", "scanComplete"],
    );
    assert.equal(hub.agentState.fileSessionId, fileA);
    assert.deepEqual(trackedLog.tracker?.leaf, { uuid: entryA });

    const scanned = whenNext("scanComplete");
    hub.observeSdkMessage(assistantMessage(entryB, fileB));
    assert.equal(hub.agentState.querySessionId, fileB);
    assert.equal(settled(hub.agentState), false);
    await scanned;
    assert.deepEqual(
      drain().map((event) => event.kind),
      ["sdkMessage", "sessionFileChanged", "sessionEntry", "scanComplete"],
    );
    assert.equal(hub.agentState.fileSessionId, fileB);
    assert.equal(settled(hub.agentState), true);
    assert.equal(trackedLog.tracker?.index.has(entryB), true);
    await hub.whenSettled();
  } finally {
    trackedLog.close();
  }
});

// A follower failure (truncation) is reported and answered by a same-file
// rescan under the gate: announced again, scanned again. The query-pending
// id survives the rescan (spec, Anomalies: recovery keeps the query side)
// and settles when the rewritten file delivers it (criterion 11).
test("follower failure: anomaly, then a same-file rescan; the tracker settles on the rewritten file", async (t) => {
  const { dir, hub, trackedLog, drain, whenNext } = harness(t);
  const fileA = randomUUID();
  const path = join(dir, `${fileA}.jsonl`);
  const reply = randomUUID();
  writeFileSync(path, line(assistantEntry(randomUUID(), null)));
  try {
    trackedLog.start(fileA);
    drain();
    hub.observeSdkMessage(assistantMessage(reply, fileA));
    assert.equal(settled(hub.agentState), false);
    const rescanned = whenNext("scanComplete");
    truncateSync(path, 0);
    await rescanned;
    const events = drain();
    assert.deepEqual(
      events.map((event) => event.kind),
      ["sdkMessage", "trackerAnomaly", "sessionFileChanged", "scanComplete"],
    );
    assert.equal(anomalies(events)[0]!.kind, "follower-failure");
    assert.equal(hub.agentState.fileSessionId, fileA);
    assert.deepEqual(trackedLog.tracker?.uuidsAfter(undefined), []);
    assert.equal(settled(hub.agentState), false);
    appendFileSync(path, line(assistantEntry(reply, null)));
    trackedLog.drainVisibleBytes();
    assert.deepEqual(
      drain().map((event) => event.kind),
      ["sessionEntry"],
    );
    await hub.whenSettled();
  } finally {
    trackedLog.close();
  }
});

// The follower skips a line that does not parse and continues; the entries
// around it are tracked and the tracker settles (criterion 11).
test("malformed line: anomaly naming the byte range; the entries around it are tracked", async (t) => {
  const { dir, hub, trackedLog, drain } = harness(t);
  const fileA = randomUUID();
  const path = join(dir, `${fileA}.jsonl`);
  const [first, second] = [randomUUID(), randomUUID()];
  const firstLine = line(assistantEntry(first, null));
  const garbage = "{not json\n";
  writeFileSync(
    path,
    `${firstLine}${garbage}${line(assistantEntry(second, first))}`,
  );
  try {
    trackedLog.start(fileA);
    const events = drain();
    assert.deepEqual(
      events.map((event) => event.kind),
      [
        "sessionFileChanged",
        "sessionEntry",
        "trackerAnomaly",
        "sessionEntry",
        "scanComplete",
      ],
    );
    const [anomaly] = anomalies(events);
    assert.equal(anomaly!.kind, "malformed-line");
    assert.match(
      anomaly!.detail,
      new RegExp(`bytes ${firstLine.length}\\+${garbage.length}`),
    );
    assert.deepEqual(trackedLog.tracker?.uuidsAfter(undefined), [
      first,
      second,
    ]);
    assert.deepEqual(trackedLog.tracker?.leaf, { uuid: second });
    await hub.whenSettled();
  } finally {
    trackedLog.close();
  }
});

// A boundary whose anchor (its summary) is not the next entry is reported;
// the anchor still completes it when it arrives (criterion 11).
test("awaiting-anchor: a boundary still awaiting after the next entry is reported; the anchor completes it", async (t) => {
  const { dir, hub, trackedLog, drain } = harness(t);
  const fileA = randomUUID();
  const path = join(dir, `${fileA}.jsonl`);
  const [prompt, reply, boundary, stray, summary] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  writeFileSync(
    path,
    [
      userEntry(prompt, null),
      assistantEntry(reply, prompt),
      boundaryEntry(boundary, [prompt, reply], summary, reply),
    ]
      .map(line)
      .join(""),
  );
  try {
    trackedLog.start(fileA);
    assert.deepEqual(anomalies(drain()), []);
    appendFileSync(path, line(userEntry(stray, reply)));
    trackedLog.drainVisibleBytes();
    const events = drain();
    assert.deepEqual(
      events.map((event) => event.kind),
      ["sessionEntry", "trackerAnomaly"],
    );
    const [anomaly] = anomalies(events);
    assert.equal(anomaly!.kind, "awaiting-anchor");
    assert.match(anomaly!.detail, new RegExp(boundary));
    appendFileSync(path, line(summaryEntry(summary, boundary)));
    trackedLog.drainVisibleBytes();
    assert.deepEqual(
      drain().map((event) => event.kind),
      ["sessionEntry", "contextChanged"],
    );
    assert.deepEqual(hub.agentState.sessions[fileA]?.awaitingAnchors, []);
    await hub.whenSettled();
  } finally {
    trackedLog.close();
  }
});
