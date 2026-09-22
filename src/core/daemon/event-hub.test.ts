import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { after, test, type TestContext } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  initialAgentState,
  SETTLE_TIMEOUT_MS,
  settled,
  type AgentState,
} from "../agent-state/agent-state.ts";
import type { AgentEvent } from "../protocol.ts";
import type { SessionEntry } from "../session/file.ts";
import { AnomalyRecorder } from "./anomaly-bundle.ts";
import { EventHub, type EventHubOptions } from "./event-hub.ts";
import { SessionTracker } from "./session-tracker.ts";
import { UUID_PATTERN } from "../uuid.ts";
import { tempDir } from "../../test-support/temp-dir.ts";

/** Bundle directory for hubs whose tests never raise an anomaly. */
const sharedBundleDir = tempDir("hub", { after });

/** The daemon's chosen session id, seeded as `querySessionId`. */
const SESSION: UUID = "aaaaaaaa-0000-0000-0000-000000000001";

function userMessage(overrides: Partial<SDKUserMessage> = {}): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
    ...overrides,
  };
}

let apiResponseCount = 0;

/** A query message on SESSION; each assistant frame is a top-level
 *  response of its own (its own `message.id`). */
function sdkMessage(
  type: "assistant" | "result",
  fields: Record<string, unknown> = {},
): SDKMessage {
  return {
    type,
    session_id: SESSION,
    // The state fold reads message.usage off every assistant message; the
    // queue model reads message.id and parent_tool_use_id.
    ...(type === "assistant" && {
      message: {
        id: `msg_${++apiResponseCount}`,
        usage: { input_tokens: 5, output_tokens: 7 },
      },
      parent_tool_use_id: null,
    }),
    ...fields,
  } as unknown as SDKMessage;
}

function hub(options: Partial<EventHubOptions> = {}): EventHub {
  return new EventHub({
    seed: { ...initialAgentState(), cwd: "/work", querySessionId: SESSION },
    deliver: () => {},
    tracker: () => undefined,
    log: () => {},
    anomalies: new AnomalyRecorder(sharedBundleDir),
    ...options,
  });
}

test("seeded cwd and querySessionId are visible before any event; the seeded session is announced at construction", () => {
  const seeded = hub();
  assert.equal(seeded.agentState.cwd, "/work");
  assert.equal(seeded.agentState.querySessionId, SESSION);
  assert.equal(seeded.agentState.activity, "idle");
  assert.deepEqual(
    seeded.agentState.sessions[SESSION]?.merge.nodes[SESSION]?.seenOn,
    ["query"],
  );
});

test("a new session id on the query stream is announced before its first message reaches the sinks", () => {
  const events = hub();
  const other: UUID = "bbbbbbbb-0000-0000-0000-000000000002";
  const lines: AgentEvent[] = [];
  events.subscribe((event) => lines.push(event));
  events.observeSdkMessage(sdkMessage("result", { session_id: other }));
  events.observeSdkMessage(sdkMessage("result", { session_id: other }));
  assert.deepEqual(
    lines.map((event) =>
      event.kind === "querySessionChanged"
        ? `${event.kind}:${event.sessionId}`
        : event.kind,
    ),
    [`querySessionChanged:${other}`, "sdkMessage", "sdkMessage"],
  );
  assert.equal(events.agentState.querySessionId, other);
  assert.equal(events.agentState.anomaly, undefined);
});

test("a non-quiescent seed is rejected loudly", () => {
  assert.throws(
    () =>
      hub({
        seed: { ...initialAgentState(), cwd: "/work", activity: "working" },
      }),
    /quiescent/,
  );
  assert.throws(
    () =>
      hub({
        seed: {
          ...initialAgentState(),
          cwd: "/work",
          queuedMessages: [{ uuid: randomUUID(), message: userMessage() }],
        },
      }),
    /quiescent/,
  );
});

test("a sink observes post-event state (fold before broadcast)", () => {
  const events = hub();
  const observed: AgentState[] = [];
  events.subscribe(() => observed.push(events.agentState));
  events.emit({ kind: "compactSent", message: userMessage() });
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.activity, "compacting");
});

test("deliverUserMessage calls deliver before its events reach sinks", () => {
  const order: string[] = [];
  const events = hub({ deliver: () => order.push("deliver") });
  events.subscribe(() => order.push("sink"));
  events.deliverUserMessage(userMessage());
  // Idle accept: queued + immediate dequeue, both after the delivery.
  assert.deepEqual(order, ["deliver", "sink", "sink"]);
});

test("deliverUserMessage stamps a uuid, delivers the stamped message and accepts it", () => {
  const delivered: SDKUserMessage[] = [];
  const events = hub({ deliver: (message) => delivered.push(message) });
  const lines: AgentEvent[] = [];
  events.subscribe((event) => lines.push(event));
  const message = userMessage();
  const uuid = events.deliverUserMessage(message);
  assert.match(uuid, UUID_PATTERN);
  assert.deepEqual(delivered, [{ ...message, uuid }]);
  assert.deepEqual(
    lines.map((event) => event.kind),
    ["userMessageQueued", "userMessageDequeued"],
  );
  assert.deepEqual(events.agentState.queuedMessages, []);
  assert.equal(events.agentState.activity, "pending");
});

test("deliverUserMessage while busy queues without dequeuing", () => {
  const events = hub();
  events.deliverUserMessage(userMessage());
  events.observeSdkMessage(sdkMessage("assistant"));
  assert.equal(events.agentState.activity, "working");
  const lines: AgentEvent[] = [];
  events.subscribe((event) => lines.push(event));
  events.deliverUserMessage(userMessage());
  assert.deepEqual(
    lines.map((event) => event.kind),
    ["userMessageQueued"],
  );
  assert.equal(events.agentState.queuedMessages.length, 1);
});

test("observeSdkMessage emits the result first, then the turn it dequeues", () => {
  const events = hub();
  events.deliverUserMessage(userMessage());
  events.observeSdkMessage(sdkMessage("assistant"));
  events.deliverUserMessage(userMessage()); // queued behind the running turn
  const lines: AgentEvent[] = [];
  events.subscribe((event) => lines.push(event));
  events.observeSdkMessage(sdkMessage("result"));
  assert.deepEqual(
    lines.map((event) => event.kind),
    ["sdkMessage", "userMessageDequeued"],
  );
});

test("observeSdkMessage emits a steer dequeue before the assistant frame that triggered it", () => {
  const events = hub();
  events.deliverUserMessage(userMessage());
  events.observeSdkMessage(sdkMessage("assistant"));
  events.deliverUserMessage(userMessage()); // queued behind the running turn
  events.observeSdkMessage(
    userMessage({
      session_id: SESSION,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    }),
  );
  const lines: AgentEvent[] = [];
  events.subscribe((event) => lines.push(event));
  events.observeSdkMessage(sdkMessage("assistant"));
  assert.deepEqual(
    lines.map((event) =>
      event.kind === "userMessageDequeued"
        ? `${event.kind}:${event.delivery}`
        : event.kind,
    ),
    ["userMessageDequeued:steer", "sdkMessage"],
  );
});

test("unsubscribe detaches the sink", () => {
  const events = hub();
  const lines: AgentEvent[] = [];
  const unsubscribe = events.subscribe((event) => lines.push(event));
  events.emit({ kind: "interruptSent" });
  unsubscribe();
  events.emit({ kind: "interruptSent" });
  assert.equal(lines.length, 1);
});

// --- step 4: dedup, settle waits, anomaly reporting -------------------------

function userEntry(uuid: UUID, text: string): SessionEntry {
  return {
    uuid,
    parentUuid: null,
    type: "user",
    message: { role: "user", content: text },
  };
}

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

const RANGE = { offset: 0, length: 0 };

/** A hub tracking SESSION through a direct-push tracker; `logEntry` pushes
 *  an entry through the tracker and emits what it returns, as
 *  TrackedSessionLog will. */
function trackedHub(t: TestContext): {
  events: EventHub;
  logEntry: (entry: SessionEntry) => void;
  logged: string[];
  bundleDir: string;
} {
  const bundleDir = tempDir("hub", t);
  const logged: string[] = [];
  const tracker = new SessionTracker("/nonexistent/session.jsonl", (message) =>
    assert.fail(`unexpected onInvalid: ${message}`),
  );
  const events = hub({
    tracker: () => tracker,
    log: (message) => logged.push(message),
    anomalies: new AnomalyRecorder(bundleDir),
  });
  events.emit({ kind: "sessionFileChanged", sessionId: SESSION });
  return {
    events,
    logEntry: (entry) => {
      for (const event of tracker.push({ entry, range: RANGE })) {
        events.emit(event);
      }
    },
    logged,
    bundleDir,
  };
}

test("dedup: a shared uuid the merge resolved is dropped silently on repeat", (t) => {
  const { events, logEntry, logged } = trackedHub(t);
  const reply = randomUUID();
  const message = sdkMessage("assistant", {
    uuid: reply,
    session_id: SESSION,
    parent_tool_use_id: null,
  });
  events.observeSdkMessage(message);
  logEntry(assistantEntry(reply, null));
  const lines: AgentEvent[] = [];
  events.subscribe((event) => lines.push(event));
  events.observeSdkMessage(message);
  assert.deepEqual(lines, []);
  assert.equal(events.agentState.anomaly, undefined);
  assert.deepEqual(logged, []);
});

test("dedup: a session-only uuid on the query stream is a classification anomaly, logged and bundled", async (t) => {
  const { events, logEntry, logged, bundleDir } = trackedHub(t);
  const prompt = randomUUID();
  logEntry(userEntry(prompt, "hi"));
  const lines: AgentEvent[] = [];
  events.subscribe((event) => lines.push(event));
  events.observeSdkMessage(userMessage({ uuid: prompt, session_id: SESSION }));
  const report = reportedAnomaly(lines);
  assert.equal(report.anomaly.kind, "classification");
  assert.match(report.anomaly.detail, /^classification: /);
  assert.match(report.anomaly.detail, new RegExp(prompt));
  // The report is not an anomaly of the hub's own fold.
  assert.equal(events.agentState.anomaly, undefined);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /^error: tracker anomaly classification: /);
  const bundles = readdirSync(bundleDir).filter((name) =>
    name.startsWith("anomaly-"),
  );
  assert.deepEqual(bundles, [basename(report.bundlePath)]);
  const bundle = JSON.parse(readFileSync(report.bundlePath, "utf8")) as {
    anomaly: { kind: string };
    recentEvents: { kind: string }[];
  };
  assert.equal(bundle.anomaly.kind, "classification");
  assert.deepEqual(
    bundle.recentEvents.map((event) => event.kind),
    ["querySessionChanged", "sessionFileChanged", "sessionEntry"],
  );
  await events.whenSettled();
});

/** The one `trackerAnomaly` among `lines`. */
function reportedAnomaly(
  lines: readonly AgentEvent[],
): Extract<AgentEvent, { kind: "trackerAnomaly" }> {
  const reports = lines.filter((event) => event.kind === "trackerAnomaly");
  assert.equal(reports.length, 1, lines.map((event) => event.kind).join(","));
  return reports[0]!;
}

// Criterion 11: the anomaly is reported and the tracker settles afterwards.
test("merge-error: a query duplicate the dedup cannot see is reported; the log's entry still settles the tracker", async (t) => {
  const { events, logEntry, logged } = trackedHub(t);
  const reply = randomUUID();
  const message = sdkMessage("assistant", {
    uuid: reply,
    session_id: SESSION,
    parent_tool_use_id: null,
  });
  events.observeSdkMessage(message);
  const lines: AgentEvent[] = [];
  events.subscribe((event) => lines.push(event));
  const before = events.agentState;
  // Not in the index yet (the log lags), so the dedup site lets it through
  // and the merge rejects the repeat.
  events.observeSdkMessage(message);
  // The fold-detected anomaly is reported as the event after its cause,
  // naming a bundle written from the state the failing fold started from.
  assert.deepEqual(
    lines.map((event) => event.kind),
    ["sdkMessage", "trackerAnomaly"],
  );
  const report = reportedAnomaly(lines);
  assert.equal(report.anomaly.kind, "merge-error");
  assert.match(report.anomaly.detail, new RegExp(reply));
  const bundle = JSON.parse(readFileSync(report.bundlePath, "utf8")) as {
    sessionsBefore: unknown;
  };
  assert.deepEqual(
    bundle.sessionsBefore,
    JSON.parse(JSON.stringify(before.sessions)),
  );
  assert.equal(events.agentState.anomaly, undefined);
  assert.equal(logged.length, 1);
  assert.equal(settled(events.agentState), false);
  logEntry(assistantEntry(reply, null));
  await events.whenSettled();
});

test("head-mismatch: an id the log skipped is reported when a later one resolves; the tracker settles", async (t) => {
  const { events, logEntry, logged } = trackedHub(t);
  const skipped = randomUUID();
  const reply = randomUUID();
  for (const uuid of [skipped, reply]) {
    events.observeSdkMessage(
      sdkMessage("assistant", {
        uuid,
        session_id: SESSION,
        parent_tool_use_id: null,
      }),
    );
  }
  assert.equal(settled(events.agentState), false);
  const lines: AgentEvent[] = [];
  events.subscribe((event) => lines.push(event));
  logEntry(assistantEntry(reply, null));
  const report = reportedAnomaly(lines);
  assert.equal(report.anomaly.kind, "head-mismatch");
  assert.match(report.anomaly.detail, new RegExp(skipped));
  assert.equal(logged.length, 1);
  await events.whenSettled();
});

test("whenSettled resolves once the log catches up with the query stream", async (t) => {
  const { events, logEntry } = trackedHub(t);
  const reply = randomUUID();
  events.observeSdkMessage(
    sdkMessage("assistant", {
      uuid: reply,
      session_id: SESSION,
      parent_tool_use_id: null,
    }),
  );
  let resolved = false;
  const wait = events.whenSettled().then(() => {
    resolved = true;
  });
  events.emit({ kind: "interruptSent" });
  assert.equal(resolved, false);
  logEntry(assistantEntry(reply, null));
  await wait;
  assert.equal(resolved, true);
  await events.whenSettled();
  await events.whenFileSettled(SESSION);
});

test("whenSettled rejects after SETTLE_TIMEOUT_MS naming the pending uuids", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { events } = trackedHub(t);
  const reply = randomUUID();
  events.observeSdkMessage(
    sdkMessage("assistant", {
      uuid: reply,
      session_id: SESSION,
      parent_tool_use_id: null,
    }),
  );
  const wait = events.whenSettled();
  t.mock.timers.tick(SETTLE_TIMEOUT_MS);
  await assert.rejects(wait, new RegExp(`pending on query: \\[${reply}\\]`));
});
