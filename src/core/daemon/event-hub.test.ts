import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
} from "../agent-state.ts";
import type { AgentEvent } from "../protocol.ts";
import type { SessionEntry } from "../session/file.ts";
import { AnomalyRecorder } from "./anomaly-bundle.ts";
import { EventHub, type EventHubOptions } from "./event-hub.ts";
import { SessionTracker } from "./session-tracker.ts";
import { tempDir } from "../../test-support/temp-dir.ts";

/** Bundle directory for hubs whose tests never raise an anomaly. */
const sharedBundleDir = tempDir("hub", { after });

function userMessage(overrides: Partial<SDKUserMessage> = {}): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
    ...overrides,
  };
}

function sdkMessage(
  type: "assistant" | "result",
  fields: Record<string, unknown> = {},
): SDKMessage {
  return {
    type,
    // The state fold reads message.usage off every assistant message.
    ...(type === "assistant" && {
      message: { usage: { input_tokens: 5, output_tokens: 7 } },
    }),
    ...fields,
  } as unknown as SDKMessage;
}

function hub(options: Partial<EventHubOptions> = {}): EventHub {
  return new EventHub({
    seed: { ...initialAgentState(), cwd: "/work" },
    deliver: () => {},
    tracker: () => undefined,
    log: () => {},
    anomalies: new AnomalyRecorder(sharedBundleDir),
    ...options,
  });
}

test("seeded cwd and querySessionId are visible before any event", () => {
  const seeded = hub({
    seed: { ...initialAgentState(), cwd: "/work", querySessionId: SESSION },
  });
  assert.equal(seeded.agentState.cwd, "/work");
  assert.equal(seeded.agentState.querySessionId, SESSION);
  assert.equal(seeded.agentState.activity, "idle");
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
          queuedMessages: [{ id: 1, message: userMessage() }],
        },
      }),
    /quiescent/,
  );
  assert.throws(
    () =>
      hub({
        seed: {
          ...initialAgentState(),
          cwd: "/work",
          deliveredMessages: [userMessage()],
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

test("deliverUserMessage while idle passes the message through to deliveredMessages", () => {
  const delivered: SDKUserMessage[] = [];
  const events = hub({ deliver: (message) => delivered.push(message) });
  const lines: AgentEvent[] = [];
  events.subscribe((event) => lines.push(event));
  const message = userMessage();
  events.deliverUserMessage(message);
  assert.deepEqual(delivered, [message]);
  assert.deepEqual(
    lines.map((event) => event.kind),
    ["userMessageQueued", "userMessageDequeued"],
  );
  assert.deepEqual(events.agentState.queuedMessages, []);
  assert.equal(events.agentState.deliveredMessages.length, 1);
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

test("observeSdkMessage emits the message first, then implied dequeues", () => {
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

const SESSION: UUID = "aaaaaaaa-0000-0000-0000-000000000001";

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
  assert.deepEqual(
    lines.map((event) => event.kind),
    ["trackerAnomaly"],
  );
  assert.equal(events.agentState.anomaly?.kind, "classification");
  assert.match(events.agentState.anomaly!.detail, new RegExp(prompt));
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /^error: tracker anomaly classification: /);
  const bundles = readdirSync(bundleDir).filter((name) =>
    name.startsWith("anomaly-"),
  );
  assert.equal(bundles.length, 1);
  const bundle = JSON.parse(
    readFileSync(join(bundleDir, bundles[0]!), "utf8"),
  ) as { anomaly: { kind: string }; recentEvents: { kind: string }[] };
  assert.equal(bundle.anomaly.kind, "classification");
  assert.deepEqual(
    bundle.recentEvents.map((event) => event.kind),
    ["sessionFileChanged", "sessionEntry", "trackerAnomaly"],
  );
  // The next fold clears the flag.
  events.emit({ kind: "interruptSent" });
  assert.equal(events.agentState.anomaly, undefined);
  await events.whenSettled();
});

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
  // Not in the index yet (the log lags), so the dedup site lets it through
  // and the merge rejects the repeat.
  events.observeSdkMessage(message);
  assert.equal(events.agentState.anomaly?.kind, "merge-error");
  assert.match(events.agentState.anomaly!.detail, new RegExp(reply));
  assert.equal(logged.length, 1);
  assert.equal(settled(events.agentState), false);
  logEntry(assistantEntry(reply, null));
  assert.equal(events.agentState.anomaly, undefined);
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
  logEntry(assistantEntry(reply, null));
  assert.equal(events.agentState.anomaly?.kind, "head-mismatch");
  assert.match(events.agentState.anomaly!.detail, new RegExp(skipped));
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
