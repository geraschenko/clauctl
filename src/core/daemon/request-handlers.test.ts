/**
 * Probe ids in comments (e.g. P9 c) cite the experiments in
 * docs/derisk/compact-boundary-injection/FINDINGS.md that established each
 * behavior.
 */

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import fs, {
  appendFileSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { initialAgentState } from "../agent-state.ts";
import type { GetContextResponse, GetEntriesResponse } from "../protocol.ts";
import type { TreeNodeRef } from "../tree/nodes.ts";
import type { PersistedOptions } from "../options.ts";
import {
  readSessionEntries,
  sessionFilePath,
  type SessionEntry,
} from "../session/file.ts";
import type {
  AgentEvent,
  ProtocolRequestRecord,
  SubscribeAttachment,
} from "../protocol.ts";
import { AnomalyRecorder } from "./anomaly-bundle.ts";
import { EventHub } from "./event-hub.ts";
import {
  createRequestHandler,
  type RequestHandlerDeps,
} from "./request-handlers.ts";
import { RwGate } from "./rw-gate.ts";
import { RESPONSE_SENT, type ProtocolConnection } from "./protocol-server.ts";
import { TrackedSessionLog } from "./tracked-session-log.ts";
import type { TurnQueue } from "./turn-queue.ts";
import { tempDir } from "../../test-support/temp-dir.ts";

const uuid = (): UUID => randomUUID();

// --- entry builders ------------------------------------------------------------

function userEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
  text = "hi",
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "user",
    sessionId,
    message: { role: "user", content: text },
  };
}

function assistantEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
  apiMessageId = `msg_${randomUUID().slice(0, 8)}`,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "assistant",
    sessionId,
    message: {
      role: "assistant",
      id: apiMessageId,
      content: [{ type: "text", text: "ok" }],
    },
  };
}

function boundaryEntry(params: {
  sessionId: UUID;
  uuids: UUID[];
  anchor: "own" | UUID;
  logicalParentUuid?: UUID;
}): SessionEntry & { uuid: UUID } {
  const boundaryUuid = uuid();
  return {
    uuid: boundaryUuid,
    parentUuid: null,
    logicalParentUuid: params.logicalParentUuid ?? null,
    type: "system",
    subtype: "compact_boundary",
    sessionId: params.sessionId,
    compactMetadata: {
      trigger: "manual",
      preservedMessages: {
        anchorUuid: params.anchor === "own" ? boundaryUuid : params.anchor,
        uuids: params.uuids,
        allUuids: params.uuids,
      },
    },
  };
}

function summaryEntry(
  boundaryUuid: UUID,
  sessionId: UUID,
  presetUuid?: UUID,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: presetUuid ?? uuid(),
    parentUuid: boundaryUuid,
    type: "user",
    sessionId,
    message: { role: "user", content: "summary text" },
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  };
}

// --- fixture ---------------------------------------------------------------

interface Fixture {
  handle: (
    request: ProtocolRequestRecord,
    connection?: ProtocolConnection,
  ) => Promise<unknown>;
  events: EventHub;
  pushed: SDKUserMessage[];
  persisted: PersistedOptions[];
  /** Every hub event except the session log's own (`sessionFileChanged`,
   *  `scanComplete`, `sessionEntry`), which every file write produces. */
  emitted: AgentEvent[];
  teardowns: number;
  restarts: string[];
  registeredAttachments: SubscribeAttachment[];
  deregisteredAttachments: SubscribeAttachment[];
  sessionId: UUID;
  file: string;
  /** The history a (re)started daemon finds on disk: writes the file and
   *  starts tracking it (scanned, so excluded from query matching). Once
   *  per fixture. */
  writeEntries: (entries: SessionEntry[]) => void;
  /** What the CLI writes while running: appended after the scan and
   *  drained into the tracker. */
  appendEntries: (entries: SessionEntry[]) => void;
}

interface FixtureOptions {
  claudeQuery?: Partial<Query>;
  /** Initial persisted options (default {}). */
  persistedOptions?: PersistedOptions;
  withSession?: boolean;
  teardownQuery?: () => Promise<void>;
  restartQuery?: () => Promise<void>;
}

const LOG_EVENT_KINDS = new Set<AgentEvent["kind"]>([
  "sessionFileChanged",
  "scanComplete",
  "sessionEntry",
]);

function fixture(t: TestContext, options: FixtureOptions = {}): Fixture {
  const pushed: SDKUserMessage[] = [];
  const persisted: PersistedOptions[] = [];
  let persistedOptions: PersistedOptions = options.persistedOptions ?? {};
  const sessionId = uuid();
  const cwd = "/work/fixture";
  const configDir = tempDir("rh", t);
  // Settings resolution reads CLAUDE_CONFIG_DIR at call time; tests in one
  // file run sequentially, so this does not race.
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const file = sessionFilePath(configDir, cwd, sessionId);
  mkdirSync(join(configDir, "projects", "-work-fixture"), { recursive: true });
  const events: EventHub = new EventHub({
    seed: {
      ...initialAgentState(),
      cwd,
      ...(options.withSession !== false && { querySessionId: sessionId }),
    },
    deliver: (message) => pushed.push(message),
    tracker: () => trackedLog.tracker,
    log: () => {},
    anomalies: new AnomalyRecorder(configDir),
  });
  const failLoudly = (message: string): never => {
    throw new Error(`unexpected daemon-log diagnostic: ${message}`);
  };
  const gate = new RwGate();
  const trackedLog: TrackedSessionLog = new TrackedSessionLog({
    hub: events,
    gate,
    sessionFilePath: (id) => sessionFilePath(configDir, cwd, id),
    onInvalid: failLoudly,
    log: failLoudly,
  });
  t.after(() => trackedLog.close());
  const emitted: AgentEvent[] = [];
  events.subscribe((event) => {
    if (!LOG_EVENT_KINDS.has(event.kind)) {
      emitted.push(event);
    }
  });
  const serialize = (entries: SessionEntry[]): string =>
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  let started = false;
  const f: Fixture = {
    handle: (request, connection = { write: () => {}, onClose: () => {} }) =>
      handler(request, connection),
    events,
    pushed,
    persisted,
    emitted,
    teardowns: 0,
    restarts: [],
    registeredAttachments: [],
    deregisteredAttachments: [],
    sessionId,
    file,
    writeEntries: (entries) => {
      assert.equal(started, false, "writeEntries is the pre-start history");
      started = true;
      writeFileSync(file, serialize(entries));
      trackedLog.start(sessionId);
    },
    appendEntries: (entries) => {
      appendFileSync(file, serialize(entries));
      trackedLog.drainVisibleBytes();
    },
  };
  const deps: RequestHandlerDeps = {
    getQuery: () => (options.claudeQuery ?? {}) as Query,
    events,
    gate,
    // The compact path only pushes; a recording stub suffices.
    getTurnQueue: () =>
      ({
        push: (message: SDKUserMessage) => pushed.push(message),
      }) as unknown as TurnQueue,
    cwd,
    log: failLoudly,
    getPersistedOptions: () => persistedOptions,
    setPersistedOptions: (next) => {
      persistedOptions = next;
      persisted.push(next);
    },
    sessionFilePath: (id) => sessionFilePath(configDir, cwd, id as UUID),
    teardownQuery: async () => {
      f.teardowns += 1;
      await options.teardownQuery?.();
    },
    restartQuery: async (resume) => {
      f.restarts.push(resume);
      await options.restartQuery?.();
    },
    trackedLog,
    registerAttachment: (info) => {
      f.registeredAttachments.push(info);
      return () => f.deregisteredAttachments.push(info);
    },
  };
  const handler = createRequestHandler(deps);
  return f;
}

/** Uuids of the get-context response (at the leaf, or at `at`). */
async function contextUuids(
  f: Fixture,
  at?: TreeNodeRef,
): Promise<(UUID | undefined)[]> {
  const slice = (await f.handle({
    type: "get-context",
    payload: "full",
    ...(at !== undefined && { at }),
    id: "g",
  })) as GetContextResponse;
  return slice.entries!.map((entry) => entry.uuid);
}

function userMessage(): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
  };
}

/** A linear two-turn session: u1 → a1 → u2 → a2. */
function linearSession(f: Fixture): {
  u1: SessionEntry & { uuid: UUID };
  a1: SessionEntry & { uuid: UUID };
  u2: SessionEntry & { uuid: UUID };
  a2: SessionEntry & { uuid: UUID };
} {
  const u1 = userEntry(null, f.sessionId, "first question");
  const a1 = assistantEntry(u1.uuid, f.sessionId);
  const u2 = userEntry(a1.uuid, f.sessionId, "second question");
  const a2 = assistantEntry(u2.uuid, f.sessionId);
  f.writeEntries([u1, a1, u2, a2]);
  return { u1, a1, u2, a2 };
}

// --- pre-existing request semantics ------------------------------------------

test("prompt delivers through the hub and returns the acceptance receipt", async (t) => {
  const f = fixture(t);
  const result = await f.handle({ type: "prompt", content: "hi", id: "r1" });
  assert.deepEqual(result, { id: 1 });
  assert.equal(f.pushed.length, 1);
  assert.deepEqual(f.pushed[0]!.origin, { kind: "human" });
  assert.equal(f.events.agentState.activity, "pending");
});

test("/compact while idle pushes directly and emits compactSent", async (t) => {
  const f = fixture(t);
  await f.handle({ type: "prompt", content: "/compact", id: "r1" });
  assert.equal(f.pushed.length, 1);
  assert.deepEqual(f.pushed[0]!.origin, { kind: "human" });
  assert.deepEqual(
    f.emitted.map((event) => event.kind),
    ["compactSent"], // no queued/dequeued pair
  );
  assert.equal(f.events.agentState.activity, "compacting");
});

test("/compact is rejected when not idle", async (t) => {
  const f = fixture(t);
  f.events.deliverUserMessage(userMessage());
  assert.equal(f.events.agentState.activity, "pending");
  await assert.rejects(
    f.handle({ type: "prompt", content: "/compact", id: "r2" }),
    /requires an idle assistant/,
  );
});

test("subscribe writes its own response carrying events.agentState", async (t) => {
  const f = fixture(t);
  f.events.deliverUserMessage(userMessage());
  const written: string[] = [];
  const connection: ProtocolConnection = {
    write: (line) => written.push(line),
    onClose: () => {},
  };
  const result = await f.handle({ type: "subscribe", id: "s1" }, connection);
  assert.equal(result, RESPONSE_SENT);
  const response = JSON.parse(written[0]!) as {
    id: string;
    ok: boolean;
    data: unknown;
  };
  assert.equal(response.id, "s1");
  assert.equal(response.ok, true);
  assert.deepEqual(
    response.data,
    JSON.parse(JSON.stringify(f.events.agentState)),
  );
  // The attached sink receives every later event.
  f.events.emit({ kind: "interruptSent" });
  assert.equal(written.length, 2);
  // Bare subscribe (tail) registers no attachment.
  assert.equal(f.registeredAttachments.length, 0);
});

test("subscribe with an attachment registers it and deregisters on connection close", async (t) => {
  const f = fixture(t);
  const closers: Array<() => void> = [];
  const connection: ProtocolConnection = {
    write: () => {},
    onClose: (callback) => closers.push(callback),
  };
  const result = await f.handle(
    {
      type: "subscribe",
      attachment: { pid: 4242, client: "clauctl attach" },
      id: "s1",
    },
    connection,
  );
  assert.equal(result, RESPONSE_SENT);
  assert.deepEqual(f.registeredAttachments, [
    { pid: 4242, client: "clauctl attach" },
  ]);
  assert.deepEqual(f.deregisteredAttachments, []);
  for (const close of closers) {
    close();
  }
  assert.deepEqual(f.deregisteredAttachments, [
    { pid: 4242, client: "clauctl attach" },
  ]);
});

test("subscribe rejects a malformed attachment before any side effect", async (t) => {
  const f = fixture(t);
  const written: string[] = [];
  const connection: ProtocolConnection = {
    write: (line) => written.push(line),
    onClose: () => {},
  };
  await assert.rejects(
    f.handle(
      {
        type: "subscribe",
        attachment: { pid: "not-a-number", client: 7 },
        id: "s1",
      } as unknown as ProtocolRequestRecord,
      connection,
    ),
    /attachment must be \{ pid: number, client: string \}/,
  );
  assert.equal(f.registeredAttachments.length, 0);
  assert.equal(written.length, 0); // no seed response was written
});

// runRead's switch has no default, so without the explicit rejection an
// unknown type would fall through to `ok: true` — an old CLI's archive would
// take a false "wait-idle" acknowledgement as "idle" and SIGTERM a busy agent.
test("an unknown request type (e.g. legacy wait-idle) is rejected, not acknowledged", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.handle({
      type: "wait-idle",
      id: "w1",
    } as unknown as ProtocolRequestRecord),
    /unknown request type: wait-idle/,
  );
  // Inherited property names must not classify as known request types (the
  // type tables are consulted with hasOwn, not `in`).
  await assert.rejects(
    f.handle({
      type: "constructor",
      id: "w2",
    } as unknown as ProtocolRequestRecord),
    /unknown request type: constructor/,
  );
});

test("get-context with no session returns [] without touching the transcript", async (t) => {
  const f = fixture(t, { withSession: false });
  assert.deepEqual(
    await f.handle({ type: "get-context", payload: "full", id: "g1" }),
    { refs: [], entries: [] },
  );
});

test("interrupt returns the SDK queue-survival receipt and emits its event", async (t) => {
  const stillQueued = [uuid(), uuid()];
  const f = fixture(t, {
    claudeQuery: {
      interrupt: async () => ({ still_queued: stillQueued }),
    },
  });
  assert.deepEqual(await f.handle({ type: "interrupt", id: "i1" }), {
    still_queued: stillQueued,
  });
  assert.deepEqual(
    f.emitted.map((event) => event.kind),
    ["interruptSent"],
  );
});

test("two in-flight mutations do not interleave: apply and persist run as a chain", async (t) => {
  const order: string[] = [];
  const gates: Array<() => void> = [];
  const claudeQuery: Partial<Query> = {
    setModel: (model?: string) => {
      order.push(`apply:${model}`);
      return new Promise((resolve) => gates.push(() => resolve(undefined)));
    },
  };
  const f = fixture(t, { claudeQuery });
  const first = f.handle({ type: "set-model", model: "a", id: "m1" });
  const second = f.handle({ type: "set-model", model: "b", id: "m2" });
  // Flush microtasks so both handlers reach the chain, then check that only
  // the first apply has started; the second waits on the chain.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["apply:a"]);
  gates.shift()!();
  await first;
  assert.deepEqual(order, ["apply:a", "apply:b"]);
  gates.shift()!();
  await second;
  assert.deepEqual(
    f.persisted.map((options) => options.model),
    ["a", "b"],
  );
});

test("a failed mutation rejects its requester without poisoning the chain", async (t) => {
  let calls = 0;
  const claudeQuery: Partial<Query> = {
    setModel: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(undefined);
    },
  };
  const f = fixture(t, { claudeQuery });
  await assert.rejects(f.handle({ type: "set-model", model: "a", id: "m1" }));
  await f.handle({ type: "set-model", model: "b", id: "m2" });
  assert.deepEqual(
    f.persisted.map((options) => options.model),
    ["b"],
  );
});

test("apply-flag-settings effortLevel null emits the resolved post-clear level", async (t) => {
  const claudeQuery: Partial<Query> = {
    applyFlagSettings: async () => undefined,
  };
  // The spawn --effort flag wins the post-clear resolution.
  const f = fixture(t, { claudeQuery, persistedOptions: { effort: "max" } });
  await f.handle({
    type: "apply-flag-settings",
    settings: { effortLevel: null },
    id: "f1",
  });
  const applied = f.emitted.find((event) => event.kind === "controlApplied");
  assert.ok(applied !== undefined && applied.kind === "controlApplied");
  assert.ok(applied.request.type === "apply-flag-settings");
  assert.equal(applied.request.settings.effortLevel, "max");
});

test("apply-flag-settings rejects an unknown effortLevel; no controlApplied is emitted", async (t) => {
  let applied = 0;
  const claudeQuery: Partial<Query> = {
    applyFlagSettings: async () => {
      applied += 1;
    },
  };
  const f = fixture(t, { claudeQuery });
  await assert.rejects(
    f.handle({
      type: "apply-flag-settings",
      settings: { effortLevel: "superduper" },
      id: "f1",
    } as unknown as ProtocolRequestRecord),
    /invalid effortLevel "superduper"; valid: low, medium, high, xhigh, max/,
  );
  assert.equal(applied, 0);
  assert.equal(f.emitted.length, 0);
  assert.equal(f.persisted.length, 0);
  // "max" is outside the SDK's Settings type but valid on the wire.
  await f.handle({
    type: "apply-flag-settings",
    settings: { effortLevel: "max" },
    id: "f2",
  });
  assert.equal(applied, 1);
  assert.deepEqual(
    f.emitted.map((event) => event.kind),
    ["controlApplied"],
  );
});

test("apply-flag-settings effortLevel null stays null when no tier specifies one", async (t) => {
  const claudeQuery: Partial<Query> = {
    applyFlagSettings: async () => undefined,
  };
  // No --effort flag; the fixture's isolated CLAUDE_CONFIG_DIR has no
  // settings, so the cascade yields nothing.
  const f = fixture(t, { claudeQuery });
  await f.handle({
    type: "apply-flag-settings",
    settings: { effortLevel: null },
    id: "f1",
  });
  const applied = f.emitted.find((event) => event.kind === "controlApplied");
  assert.ok(applied !== undefined && applied.kind === "controlApplied");
  assert.ok(applied.request.type === "apply-flag-settings");
  assert.equal(applied.request.settings.effortLevel, null);
});

// --- get-entries -----------------------------------------------------------

/** Meter of the session log's reads from now until the test ends: whole-file
 *  reads (readFileSync of the log) and bytes read through fds opened on it.
 *  The mocks replace the `fs` object's methods; syncBuiltinESMExports makes
 *  the named imports file.ts/entry-stream.ts hold follow. */
function meterLogReads(
  t: TestContext,
  logPath: string,
): () => { wholeFileReads: number; bytes: number } {
  const openSync = t.mock.method(fs, "openSync");
  const readSync = t.mock.method(fs, "readSync");
  const readFileSync = t.mock.method(fs, "readFileSync");
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => {
    const logFds = new Set(
      openSync.mock.calls
        .filter((call) => call.arguments[0] === logPath)
        .map((call) => call.result),
    );
    return {
      wholeFileReads: readFileSync.mock.calls.filter(
        (call) => call.arguments[0] === logPath,
      ).length,
      bytes: readSync.mock.calls
        .filter((call) => logFds.has(call.arguments[0]))
        .reduce((total, call) => total + (call.result ?? 0), 0),
    };
  };
}

const lineBytes = (entry: SessionEntry): number =>
  Buffer.byteLength(`${JSON.stringify(entry)}\n`);

// Criterion 1: the startup scan is the follower's one read of the file;
// afterwards requests read the log only at the recorded byte ranges of the
// entries they serve, never the whole file, and a set-context's own append
// reaches the tracker through the follower's incremental read.
test("after the startup scan, requests read only the byte ranges they serve", async (t) => {
  const f = fixture(t);
  const reads = meterLogReads(t, f.file);
  const { u1, a1, u2, a2 } = linearSession(f);
  const historyBytes = [u1, a1, u2, a2].reduce(
    (total, entry) => total + lineBytes(entry),
    0,
  );
  let expectedBytes = historyBytes;
  assert.deepEqual(reads(), { wholeFileReads: 0, bytes: expectedBytes });
  // Identities are served from the index; only "full" payloads and
  // explicit uuid fetches read, and only the ranges they serve.
  await f.handle({ type: "get-entries", payload: "uuids", id: "e0" });
  await f.handle({ type: "get-context", payload: "uuids", id: "g0" });
  assert.deepEqual(reads(), { wholeFileReads: 0, bytes: expectedBytes });
  await f.handle({ type: "get-entries", payload: "full", id: "e1" });
  expectedBytes += historyBytes;
  assert.deepEqual(reads(), { wholeFileReads: 0, bytes: expectedBytes });
  await f.handle({
    type: "get-entries",
    payload: "full",
    since: u2.uuid,
    id: "e2",
  });
  expectedBytes += lineBytes(a2);
  assert.deepEqual(reads(), { wholeFileReads: 0, bytes: expectedBytes });
  await f.handle({ type: "get-entries", uuids: [u1.uuid], id: "e3" });
  expectedBytes += lineBytes(u1);
  assert.deepEqual(reads(), { wholeFileReads: 0, bytes: expectedBytes });
  await f.handle({
    type: "get-context",
    payload: "full",
    at: { uuid: a1.uuid },
    id: "g1",
  });
  expectedBytes += lineBytes(u1) + lineBytes(a1);
  assert.deepEqual(reads(), { wholeFileReads: 0, bytes: expectedBytes });
  await f.handle({ type: "set-context", uuids: [u2.uuid, a2.uuid], id: "c1" });
  // Validation normalizes against every entry (one read per entry), then the
  // follower reads the appended boundary line.
  expectedBytes += historyBytes + (statSync(f.file).size - historyBytes);
  assert.deepEqual(reads(), { wholeFileReads: 0, bytes: expectedBytes });
});

test("get-entries returns every entry verbatim plus the chain-tip leaf", async (t) => {
  const f = fixture(t);
  const { u1, a2 } = linearSession(f);
  const snapshot = (await f.handle({
    type: "get-entries",
    payload: "full",
    id: "e1",
  })) as GetEntriesResponse;
  assert.equal(snapshot.entries!.length, 4);
  assert.deepEqual(snapshot.entries![0], u1);
  assert.deepEqual(snapshot.leaf, { uuid: a2.uuid });
});

test("get-entries --since returns the canonical entries after the cursor; an unknown cursor errors", async (t) => {
  const f = fixture(t);
  const { a1, u2, a2 } = linearSession(f);
  const snapshot = (await f.handle({
    type: "get-entries",
    payload: "full",
    since: a1.uuid,
    id: "e1",
  })) as GetEntriesResponse;
  assert.deepEqual(snapshot.entries, [u2, a2]);
  assert.deepEqual(snapshot.leaf, { uuid: a2.uuid });
  await assert.rejects(
    f.handle({ type: "get-entries", payload: "full", since: uuid(), id: "e2" }),
    /unknown entry uuid/,
  );
});

test("get-entries returns an empty snapshot without a session", async (t) => {
  const f = fixture(t, { withSession: false });
  const snapshot = (await f.handle({
    type: "get-entries",
    payload: "full",
    id: "e1",
  })) as GetEntriesResponse;
  assert.deepEqual(snapshot, { uuids: [], entries: [], leaf: null });
});

// --- set-context validation ------------------------------------------------

test("set-context rejects while busy, before any teardown", async (t) => {
  const f = fixture(t);
  linearSession(f);
  f.events.deliverUserMessage(userMessage());
  await assert.rejects(
    f.handle({ type: "set-context", uuids: [uuid()], id: "c1" }),
    /requires an idle assistant/,
  );
  assert.equal(f.teardowns, 0);
});

test("set-context rejects delivered-but-unconfirmed prompts as busy", async (t) => {
  const f = fixture(t);
  linearSession(f);
  const appendOnly: SDKUserMessage = { ...userMessage(), shouldQuery: false };
  f.events.deliverUserMessage(appendOnly);
  assert.equal(f.events.agentState.activity, "idle");
  await assert.rejects(
    f.handle({ type: "set-context", uuids: [uuid()], id: "c1" }),
    /requires an idle assistant/,
  );
});

test("set-context rejects unknown and duplicate uuid lists", async (t) => {
  const f = fixture(t);
  const { u1 } = linearSession(f);
  const stranger = uuid();
  await assert.rejects(
    f.handle({ type: "set-context", uuids: [u1.uuid, stranger], id: "c1" }),
    new RegExp(stranger),
  );
  await assert.rejects(
    f.handle({ type: "set-context", uuids: [u1.uuid, u1.uuid], id: "c2" }),
    /duplicate/,
  );
  assert.equal(f.teardowns, 0);
  assert.equal(f.restarts.length, 0);
});

test("set-context errors without a session", async (t) => {
  const f = fixture(t, { withSession: false });
  await assert.rejects(
    f.handle({ type: "set-context", uuids: [uuid()], id: "c1" }),
    /no session yet/,
  );
});

// --- set-context boundary mode -----------------------------------------------

test("boundary mode appends boundary+summary, restarts, broadcasts", async (t) => {
  const f = fixture(t);
  const { u2, a2 } = linearSession(f);
  const result = (await f.handle({
    type: "set-context",
    uuids: [u2.uuid, a2.uuid],
    summaryText: "earlier we discussed X",
    id: "c1",
  })) as { boundaryUuid: UUID; summaryUuid: UUID };

  assert.equal(f.teardowns, 1);
  assert.deepEqual(f.restarts, [f.sessionId]);

  const entries = readSessionEntries(f.file);
  assert.equal(entries.length, 6);
  const boundary = entries[4]!;
  const summary = entries[5]!;
  assert.equal(boundary.subtype, "compact_boundary");
  assert.equal(boundary.uuid, result.boundaryUuid);
  assert.equal(boundary.logicalParentUuid, a2.uuid);
  assert.equal(summary.uuid, result.summaryUuid);
  const metadata = boundary.compactMetadata as {
    preservedMessages: { anchorUuid: UUID; uuids: UUID[] };
  };
  // Default anchor "summary": up_to shape.
  assert.equal(metadata.preservedMessages.anchorUuid, result.summaryUuid);

  assert.deepEqual(
    f.emitted.map((event) => event.kind),
    ["sessionAppended", "contextChanged"],
  );
  // The effective context (what get-context returns): summary first, then
  // the preserved uuids.
  assert.deepEqual(await contextUuids(f), [
    result.summaryUuid,
    u2.uuid,
    a2.uuid,
  ]);
});

test("boundary mode without summary uses the boundary's own uuid as anchor", async (t) => {
  const f = fixture(t);
  const { u2, a2 } = linearSession(f);
  const result = (await f.handle({
    type: "set-context",
    uuids: [u2.uuid, a2.uuid],
    id: "c1",
  })) as { boundaryUuid: UUID; summaryUuid?: UUID };
  assert.equal(result.summaryUuid, undefined);
  const entries = readSessionEntries(f.file);
  assert.equal(entries.length, 5);
  const metadata = entries[4]!.compactMetadata as {
    preservedMessages: { anchorUuid: UUID };
  };
  assert.equal(metadata.preservedMessages.anchorUuid, result.boundaryUuid);
  assert.deepEqual(await contextUuids(f), [u2.uuid, a2.uuid]);
});

test("boundary mode completes a split tool pair and reports what it added", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid, "run it");
  const call: SessionEntry & { uuid: UUID } = {
    uuid: uuid(),
    parentUuid: u1.uuid,
    type: "assistant",
    sessionId: sid,
    message: {
      role: "assistant",
      id: "msg_pair",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
    },
  };
  const result: SessionEntry & { uuid: UUID } = {
    uuid: uuid(),
    parentUuid: call.uuid,
    type: "user",
    sessionId: sid,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
    },
  };
  f.writeEntries([u1, call, result]);
  // The requested uuids split the pair; normalization completes it from the
  // file, so verification sees effective == normalized and succeeds.
  const setResult = (await f.handle({
    type: "set-context",
    uuids: [u1.uuid, call.uuid],
    id: "c1",
  })) as { boundaryUuid: UUID; added?: UUID[] };
  assert.deepEqual(setResult.added, [result.uuid]);
  const entries = readSessionEntries(f.file);
  const metadata = entries.at(-1)!.compactMetadata as {
    preservedMessages: { uuids: UUID[] };
  };
  assert.deepEqual(metadata.preservedMessages.uuids, [
    u1.uuid,
    call.uuid,
    result.uuid,
  ]);
  assert.deepEqual(await contextUuids(f), [u1.uuid, call.uuid, result.uuid]);
});

// --- set-context rewind mode ---------------------------------------------------

test("rewind on the active chain appends a no-summary boundary listing the context at the target", async (t) => {
  const f = fixture(t);
  const { u1, a1 } = linearSession(f);
  const result = (await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  })) as { boundaryUuid: UUID; summaryUuid?: UUID };
  assert.equal(result.summaryUuid, undefined);
  assert.equal(f.teardowns, 1);
  assert.deepEqual(f.restarts, [f.sessionId]);
  const entries = readSessionEntries(f.file);
  assert.equal(entries.length, 5);
  const boundary = entries[4]!;
  assert.equal(boundary.uuid, result.boundaryUuid);
  // The list reproduces the context at a1, so a1 is the branch point.
  assert.equal(boundary.logicalParentUuid, a1.uuid);
  const metadata = boundary.compactMetadata as {
    preservedMessages: { anchorUuid: UUID; uuids: UUID[] };
  };
  assert.deepEqual(metadata.preservedMessages.uuids, [u1.uuid, a1.uuid]);
  assert.equal(metadata.preservedMessages.anchorUuid, result.boundaryUuid);
  assert.deepEqual(
    f.emitted.map((event) => event.kind),
    ["sessionAppended", "contextChanged"],
  );
  assert.deepEqual(await contextUuids(f), [u1.uuid, a1.uuid]);
  const snapshot = (await f.handle({
    type: "get-entries",
    payload: "full",
    id: "t1",
  })) as GetEntriesResponse;
  assert.deepEqual(snapshot.leaf, {
    uuid: a1.uuid,
    viaBoundary: result.boundaryUuid,
  });
});

test("rewind with appended uuids lists the context at the target followed by the append", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2a = userEntry(a1.uuid, sid, "abandoned");
  const a2a = assistantEntry(u2a.uuid, sid);
  const u2b = userEntry(a1.uuid, sid, "active");
  const a2b = assistantEntry(u2b.uuid, sid);
  f.writeEntries([u1, a1, u2a, a2a, u2b, a2b]);
  const result = (await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    append: [u2a.uuid, a2a.uuid],
    id: "c1",
  })) as { boundaryUuid: UUID };
  const boundary = readSessionEntries(f.file).at(-1)!;
  assert.equal(boundary.uuid, result.boundaryUuid);
  const metadata = boundary.compactMetadata as {
    preservedMessages: { uuids: UUID[] };
  };
  assert.deepEqual(metadata.preservedMessages.uuids, [
    u1.uuid,
    a1.uuid,
    u2a.uuid,
    a2a.uuid,
  ]);
  // The whole list is a context-tree path ending at a2a.
  assert.equal(boundary.logicalParentUuid, a2a.uuid);
  assert.deepEqual(await contextUuids(f), [
    u1.uuid,
    a1.uuid,
    u2a.uuid,
    a2a.uuid,
  ]);
});

// The context at an assistant includes the turn_duration rows the loader
// keeps; a rewind lists them verbatim (unlike a hand-written list, which
// normalization would have to complete).
test("rewind lists the system:turn_duration entries in the target's context", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const duration: SessionEntry & { uuid: UUID } = {
    uuid: uuid(),
    parentUuid: a1.uuid,
    type: "system",
    subtype: "turn_duration",
    sessionId: sid,
    durationMs: 1234,
  };
  const u2 = userEntry(duration.uuid, sid);
  const a2 = assistantEntry(u2.uuid, sid);
  f.writeEntries([u1, a1, duration, u2, a2]);
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a2.uuid },
    id: "c1",
  });
  const boundary = readSessionEntries(f.file).at(-1)!;
  const metadata = boundary.compactMetadata as {
    preservedMessages: { uuids: UUID[] };
  };
  assert.deepEqual(metadata.preservedMessages.uuids, [
    u1.uuid,
    a1.uuid,
    duration.uuid,
    u2.uuid,
    a2.uuid,
  ]);
  assert.equal(boundary.logicalParentUuid, a2.uuid);
});

test("rewind to an abandoned branch appends a no-summary boundary", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2a = userEntry(a1.uuid, sid, "abandoned");
  const a2a = assistantEntry(u2a.uuid, sid);
  const u2b = userEntry(a1.uuid, sid, "active");
  const a2b = assistantEntry(u2b.uuid, sid);
  f.writeEntries([u1, a1, u2a, a2a, u2b, a2b]);

  const result = (await f.handle({
    type: "set-context",
    rewindTo: { uuid: a2a.uuid },
    id: "c1",
  })) as { boundaryUuid: UUID; summaryUuid?: UUID };
  assert.equal(result.summaryUuid, undefined);
  assert.deepEqual(f.restarts, [sid]);
  const entries = readSessionEntries(f.file);
  assert.equal(entries.length, 7);
  const metadata = entries[6]!.compactMetadata as {
    preservedMessages: { anchorUuid: UUID; uuids: UUID[] };
  };
  assert.deepEqual(metadata.preservedMessages.uuids, [
    u1.uuid,
    a1.uuid,
    u2a.uuid,
    a2a.uuid,
  ]);
  assert.equal(metadata.preservedMessages.anchorUuid, result.boundaryUuid);
  // After the boundary append, the leaf is the tracker's tip — a relinked
  // node, since the chain ends inside the boundary's relink (no post
  // entries).
  const snapshot = (await f.handle({
    type: "get-entries",
    payload: "full",
    id: "t1",
  })) as GetEntriesResponse;
  assert.deepEqual(snapshot.leaf, {
    uuid: a2a.uuid,
    viaBoundary: result.boundaryUuid,
  });
});

// logicalParentUuid is structural: the deepest context-tree occurrence the
// preserved list reproduces, independent of which boundary is current.
test("boundaries written after a rewind take structural logicalParentUuids", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2a = userEntry(a1.uuid, sid, "abandoned");
  const a2a = assistantEntry(u2a.uuid, sid);
  const u2b = userEntry(a1.uuid, sid, "active");
  const a2b = assistantEntry(u2b.uuid, sid);
  f.writeEntries([u1, a1, u2a, a2a, u2b, a2b]);
  const lastBoundary = () => readSessionEntries(f.file).at(-1)!;
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  assert.equal(lastBoundary().logicalParentUuid, a1.uuid);
  // An explicit list equal to the rewound context: still a1.
  await f.handle({ type: "set-context", uuids: [u1.uuid, a1.uuid], id: "c2" });
  assert.equal(lastBoundary().logicalParentUuid, a1.uuid);
  // The abandoned branch's raw chain, unrelated to the current boundary.
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a2a.uuid },
    id: "c3",
  });
  assert.equal(lastBoundary().logicalParentUuid, a2a.uuid);
  // A list no context-tree path reproduces starts a new root.
  await f.handle({ type: "set-context", uuids: [a2b.uuid], id: "c4" });
  assert.equal(lastBoundary().logicalParentUuid, null);
});

// --- get-context ---------------------------------------------------------------

// The context is served from the tracker's context tree, so a branch-switch
// rewind (whose boundary the SDK's own getSessionMessages misreads —
// FINDINGS.md P9 a/b) is served correctly.
test("get-context after a branch-switch rewind lists the rewound branch", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2a = userEntry(a1.uuid, sid, "abandoned");
  const a2a = assistantEntry(u2a.uuid, sid);
  const u2b = userEntry(a1.uuid, sid, "active");
  const a2b = assistantEntry(u2b.uuid, sid);
  f.writeEntries([u1, a1, u2a, a2a, u2b, a2b]);
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a2a.uuid },
    id: "c1",
  });
  assert.deepEqual(await contextUuids(f), [
    u1.uuid,
    a1.uuid,
    u2a.uuid,
    a2a.uuid,
  ]);
});

test("get-context follows the next transcript write past a boundary", async (t) => {
  const f = fixture(t);
  const { u2, a2 } = linearSession(f);
  await f.handle({ type: "set-context", uuids: [u2.uuid, a2.uuid], id: "c1" });
  const u3 = userEntry(a2.uuid, f.sessionId, "post-boundary turn");
  f.appendEntries([u3]);
  assert.deepEqual(await contextUuids(f), [u2.uuid, a2.uuid, u3.uuid]);
});

// Restart independence: a daemon that starts on a file already holding a
// boundary serves the same context as the daemon that wrote it.
test("get-context after a restart honors a boundary preserving an older prefix", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2 = userEntry(a1.uuid, sid);
  const a2 = assistantEntry(u2.uuid, sid);
  f.writeEntries([
    u1,
    a1,
    u2,
    a2,
    boundaryEntry({ sessionId: sid, uuids: [u1.uuid, a1.uuid], anchor: "own" }),
  ]);
  assert.deepEqual(await contextUuids(f), [u1.uuid, a1.uuid]);
});

test("get-context after a restart includes turns written after the boundary", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  const u2 = userEntry(a1.uuid, sid, "post-boundary turn");
  f.writeEntries([u1, a1, boundary, u2]);
  assert.deepEqual(await contextUuids(f), [u1.uuid, a1.uuid, u2.uuid]);
});

test("get-context default equals the context at the get-entries leaf", async (t) => {
  const f = fixture(t);
  const { u1, a1 } = linearSession(f);
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  const snapshot = (await f.handle({
    type: "get-entries",
    payload: "full",
    id: "t1",
  })) as GetEntriesResponse;
  assert.notEqual(snapshot.leaf, null);
  assert.deepEqual(await contextUuids(f), [u1.uuid, a1.uuid]);
  assert.deepEqual(await contextUuids(f, snapshot.leaf!), [u1.uuid, a1.uuid]);
});

test("get-context --at serves a raw occurrence and a relinked one", async (t) => {
  const f = fixture(t);
  const { u1, a1, u2, a2 } = linearSession(f);
  const boundary = boundaryEntry({
    sessionId: f.sessionId,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  f.appendEntries([boundary]);
  assert.deepEqual(await contextUuids(f, { uuid: a2.uuid }), [
    u1.uuid,
    a1.uuid,
    u2.uuid,
    a2.uuid,
  ]);
  assert.deepEqual(
    await contextUuids(f, { uuid: a1.uuid, viaBoundary: boundary.uuid }),
    [u1.uuid, a1.uuid],
  );
});

test("get-context --at rejects an occurrence absent from the context tree", async (t) => {
  const f = fixture(t);
  const { a1 } = linearSession(f);
  await assert.rejects(
    f.handle({
      type: "get-context",
      payload: "full",
      at: { uuid: a1.uuid, viaBoundary: uuid() },
      id: "g1",
    }),
    /not a context-tree occurrence/,
  );
  await assert.rejects(
    f.handle({
      type: "get-context",
      payload: "full",
      at: { uuid: uuid() },
      id: "g2",
    }),
    /not a context-tree occurrence/,
  );
});

// Every entry on the context path is returned verbatim, including the
// kinds the stream fold ignores (isMeta prompts, system entries).
test("get-context returns isMeta and system entries verbatim", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const duration: SessionEntry & { uuid: UUID } = {
    uuid: uuid(),
    parentUuid: a1.uuid,
    type: "system",
    subtype: "turn_duration",
    sessionId: sid,
    durationMs: 1234,
  };
  const meta = { ...userEntry(duration.uuid, sid, "<meta>"), isMeta: true };
  f.writeEntries([u1, a1, duration, meta]);
  const slice = (await f.handle({
    type: "get-context",
    payload: "full",
    id: "g1",
  })) as GetContextResponse;
  assert.deepEqual(slice.entries, [u1, a1, duration, meta]);
});

// Re-persisted copies (a legal file shape; see cli-history-repersistence
// FINDINGS) are first-wins duplicates for the tree.
test("rewind in a file with re-persisted copies lists the first occurrences' context", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2 = userEntry(a1.uuid, sid);
  const a2 = assistantEntry(u2.uuid, sid);
  f.writeEntries([u1, a1, u2, a2, u1, a1]);
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  const metadata = readSessionEntries(f.file).at(-1)!.compactMetadata as {
    preservedMessages: { uuids: UUID[] };
  };
  assert.deepEqual(metadata.preservedMessages.uuids, [u1.uuid, a1.uuid]);
  assert.deepEqual(f.restarts, [f.sessionId]);
});

test("rewind to a member of a boundary's preserved uuids resurrects the summarized region", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const u2 = userEntry(a1.uuid, sid);
  const a2 = assistantEntry(u2.uuid, sid);
  const summaryUuid = uuid();
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u2.uuid, a2.uuid],
    anchor: summaryUuid,
    logicalParentUuid: a1.uuid,
  });
  const summary = summaryEntry(boundary.uuid, sid, summaryUuid);
  f.writeEntries([u1, a1, u2, a2, boundary, summary]);

  // Bare a2 names its raw occurrence, whose context is u1..a2 — not the
  // boundary's [summary, u2, a2] view (that is a2@boundary).
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a2.uuid },
    id: "c1",
  });
  const entries = readSessionEntries(f.file);
  assert.equal(entries.length, 7);
  const metadata = entries[6]!.compactMetadata as {
    preservedMessages: { uuids: UUID[] };
  };
  assert.deepEqual(metadata.preservedMessages.uuids, [
    u1.uuid,
    a1.uuid,
    u2.uuid,
    a2.uuid,
  ]);
});

test("rewind accepts any context-tree occurrence; an absent one is rejected before teardown", async (t) => {
  const f = fixture(t);
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const thinking = assistantEntry(u1.uuid, sid, "msg_shared");
  const text = assistantEntry(thinking.uuid, sid, "msg_shared");
  f.writeEntries([u1, thinking, text]);

  await assert.rejects(
    f.handle({ type: "set-context", rewindTo: { uuid: uuid() }, id: "c1" }),
    /not a context-tree occurrence/,
  );
  assert.equal(f.teardowns, 0);
  const listOf = (): UUID[] =>
    (
      readSessionEntries(f.file).at(-1)!.compactMetadata as {
        preservedMessages: { uuids: UUID[] };
      }
    ).preservedMessages.uuids;
  // A user target: the context ends in that user entry.
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: u1.uuid },
    id: "c2",
  });
  assert.deepEqual(listOf(), [u1.uuid]);
  // A mid-message sibling: the list is cut there like an explicit list.
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: thinking.uuid },
    id: "c3",
  });
  assert.deepEqual(listOf(), [u1.uuid, thinking.uuid]);
});

// --- gate and restart-failure behavior -----------------------------------------

test("while a context change is in flight, Query-bound requests error and reads wait", async (t) => {
  let releaseTeardown!: () => void;
  const teardownGate = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  const f = fixture(t, { teardownQuery: () => teardownGate });
  const { a1 } = linearSession(f);
  const setContext = f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.teardowns, 1);

  await assert.rejects(
    f.handle({ type: "interrupt", id: "i1" }),
    /context change in progress/,
  );
  await assert.rejects(
    f.handle({ type: "set-context", rewindTo: { uuid: a1.uuid }, id: "c2" }),
    /context change in progress/,
  );
  let entriesResolved = false;
  const read = f
    .handle({ type: "get-entries", payload: "full", id: "e1" })
    .then((entries) => {
      entriesResolved = true;
      return entries;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entriesResolved, false); // reads wait for the gate

  releaseTeardown();
  await setContext;
  assert.equal(((await read) as GetEntriesResponse).entries!.length, 5);
});

test("set-context drains in-flight Query operations before teardown", async (t) => {
  let resolveInterrupt!: () => void;
  const claudeQuery: Partial<Query> = {
    interrupt: () =>
      new Promise((resolve) => {
        resolveInterrupt = () => resolve(undefined);
      }),
  };
  const f = fixture(t, { claudeQuery });
  const { a1 } = linearSession(f);
  const interrupt = f.handle({ type: "interrupt", id: "i1" });
  await new Promise((resolve) => setImmediate(resolve));
  const setContext = f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.teardowns, 0); // still draining the interrupt
  resolveInterrupt();
  await interrupt;
  await setContext;
  assert.equal(f.teardowns, 1);
});

test("restart failure leaves the daemon query-unavailable until a set-context succeeds", async (t) => {
  let failRestart = true;
  const f = fixture(t, {
    restartQuery: () =>
      failRestart
        ? Promise.reject(new Error("spawn failed"))
        : Promise.resolve(),
  });
  const { u2, a2, a1 } = linearSession(f);
  await assert.rejects(
    f.handle({
      type: "set-context",
      uuids: [u2.uuid, a2.uuid],
      id: "c1",
    }),
    /query restart failed/,
  );
  // The boundary is durable, and watchers were told even though the restart
  // failed.
  assert.equal(readSessionEntries(f.file).length, 5);
  assert.deepEqual(
    f.emitted.map((event) => event.kind),
    ["sessionAppended", "contextChanged"],
  );
  // Query-bound requests error; file reads keep working.
  await assert.rejects(
    f.handle({ type: "interrupt", id: "i1" }),
    /query restart failed; retry set-context/,
  );
  await assert.rejects(
    f.handle({ type: "prompt", content: "hi", id: "q1" }),
    /query restart failed; retry set-context/,
  );
  assert.equal(
    (
      (await f.handle({
        type: "get-entries",
        payload: "full",
        id: "e1",
      })) as GetEntriesResponse
    ).entries!.length,
    5,
  );
  // A subsequent set-context reconstructs the Query.
  failRestart = false;
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c2",
  });
  await f.handle({ type: "prompt", content: "hi", id: "q2" });
  assert.equal(f.pushed.length, 1);
});

test("a later boundary listing the full chain restores the rewound-away tail", async (t) => {
  const f = fixture(t);
  const { u1, a1, u2, a2 } = linearSession(f);
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  await f.handle({
    type: "set-context",
    uuids: [u1.uuid, a1.uuid, u2.uuid, a2.uuid],
    id: "c2",
  });
  assert.deepEqual(await contextUuids(f), [u1.uuid, a1.uuid, u2.uuid, a2.uuid]);
});

// The contextChanged.leaf invariant: the event carries exactly the leaf a
// post-change get-entries reports (the empty and viaBoundary paths are
// pinned in their own tests below).
test("contextChanged.leaf equals the post-change get-entries leaf (explicit list and rewind)", async (t) => {
  const lastContextChanged = (f: Fixture) =>
    f.emitted.findLast(
      (event): event is Extract<AgentEvent, { kind: "contextChanged" }> =>
        event.kind === "contextChanged",
    )!;

  const appendFixture = fixture(t);
  const { u2, a2 } = linearSession(appendFixture);
  await appendFixture.handle({
    type: "set-context",
    uuids: [u2.uuid, a2.uuid],
    id: "c1",
  });
  const appendSnapshot = (await appendFixture.handle({
    type: "get-entries",
    payload: "full",
    id: "g1",
  })) as GetEntriesResponse;
  const appendEvent = lastContextChanged(appendFixture);
  assert.notEqual(appendEvent.leaf, null);
  assert.notEqual(appendEvent.leaf!.viaBoundary, undefined);
  assert.deepEqual(appendEvent.leaf, appendSnapshot.leaf);

  const rewindFixture = fixture(t);
  const { a1 } = linearSession(rewindFixture);
  const rewindResult = (await rewindFixture.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  })) as { boundaryUuid: UUID };
  const rewindSnapshot = (await rewindFixture.handle({
    type: "get-entries",
    payload: "full",
    id: "g1",
  })) as GetEntriesResponse;
  const rewindEvent = lastContextChanged(rewindFixture);
  assert.deepEqual(rewindEvent.leaf, {
    uuid: a1.uuid,
    viaBoundary: rewindResult.boundaryUuid,
  });
  assert.deepEqual(rewindEvent.leaf, rewindSnapshot.leaf);
});

// --- occurrence-aware rewind (rewindTo.viaBoundary) --------------------------

test("viaBoundary rewind to a preserved member lists that occurrence's context", async (t) => {
  const f = fixture(t);
  const { u1, a1 } = linearSession(f);
  const boundary = boundaryEntry({
    sessionId: f.sessionId,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  f.appendEntries([boundary]);

  const result = (await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid, viaBoundary: boundary.uuid },
    id: "c1",
  })) as { boundaryUuid: UUID };
  assert.deepEqual(f.restarts, [f.sessionId]);
  const appended = readSessionEntries(f.file).at(-1)!;
  assert.equal(appended.uuid, result.boundaryUuid);
  assert.deepEqual(
    (appended.compactMetadata as { preservedMessages: { uuids: string[] } })
      .preservedMessages.uuids,
    [u1.uuid, a1.uuid],
  );
  // The branch point is the bare uuid even though the list was taken from
  // the relinked occurrence.
  assert.equal(appended.logicalParentUuid, a1.uuid);
  const event = f.emitted.findLast(
    (candidate): candidate is Extract<AgentEvent, { kind: "contextChanged" }> =>
      candidate.kind === "contextChanged",
  )!;
  assert.deepEqual(event.leaf, { uuid: a1.uuid, viaBoundary: appended.uuid });
  const snapshot = (await f.handle({
    type: "get-entries",
    payload: "full",
    id: "g1",
  })) as GetEntriesResponse;
  assert.deepEqual(snapshot.leaf, event.leaf);
});

test("viaBoundary rewind into a superseded boundary's chain appends a prefix boundary", async (t) => {
  const f = fixture(t);
  const { u1, a1, u2, a2 } = linearSession(f);
  const first = boundaryEntry({
    sessionId: f.sessionId,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  const second = boundaryEntry({
    sessionId: f.sessionId,
    uuids: [u2.uuid, a2.uuid],
    anchor: "own",
  });
  // Stacked boundaries: the second wins entirely, abandoning the first's
  // chain (P3 m5; see file comment) — a pick inside the first cannot
  // resume, so it appends.
  f.appendEntries([first, second]);

  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid, viaBoundary: first.uuid },
    id: "c1",
  });
  const entries = readSessionEntries(f.file);
  const appended = entries.at(-1)!;
  assert.equal(appended.subtype, "compact_boundary");
  assert.deepEqual(
    (appended.compactMetadata as { preservedMessages: { uuids: string[] } })
      .preservedMessages.uuids,
    [u1.uuid, a1.uuid],
  );
  const event = f.emitted.findLast(
    (candidate): candidate is Extract<AgentEvent, { kind: "contextChanged" }> =>
      candidate.kind === "contextChanged",
  )!;
  assert.deepEqual(event.leaf, { uuid: a1.uuid, viaBoundary: appended.uuid });
  const snapshot = (await f.handle({
    type: "get-entries",
    payload: "full",
    id: "g1",
  })) as GetEntriesResponse;
  assert.deepEqual(snapshot.leaf, event.leaf);
});

test("viaBoundary rewind ignores post-block turns before the next boundary", async (t) => {
  const f = fixture(t);
  const { u1, a1 } = linearSession(f);
  const first = boundaryEntry({
    sessionId: f.sessionId,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  // Turns on the first boundary's installed chain, before the second
  // boundary supersedes it: the truncate-at-next-boundary file slice keeps
  // them, the cut at the target discards them.
  const p1 = userEntry(a1.uuid, f.sessionId, "post-block turn");
  const p2 = assistantEntry(p1.uuid, f.sessionId);
  const second = boundaryEntry({
    sessionId: f.sessionId,
    uuids: [p1.uuid, p2.uuid],
    anchor: "own",
  });
  f.appendEntries([first, p1, p2, second]);

  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid, viaBoundary: first.uuid },
    id: "c1",
  });
  const appended = readSessionEntries(f.file).at(-1)!;
  assert.equal(appended.subtype, "compact_boundary");
  assert.deepEqual(
    (appended.compactMetadata as { preservedMessages: { uuids: string[] } })
      .preservedMessages.uuids,
    [u1.uuid, a1.uuid],
  );
});

test("viaBoundary rewind rejects an occurrence absent from the context tree", async (t) => {
  const f = fixture(t);
  const { u1, a1, u2, a2 } = linearSession(f);
  const boundary = boundaryEntry({
    sessionId: f.sessionId,
    uuids: [u2.uuid, a2.uuid],
    anchor: "own",
  });
  f.appendEntries([boundary]);
  await assert.rejects(
    f.handle({
      type: "set-context",
      rewindTo: { uuid: a2.uuid, viaBoundary: u1.uuid },
      id: "c1",
    }),
    /not a context-tree occurrence/,
  );
  await assert.rejects(
    f.handle({
      type: "set-context",
      // a1 is in the file but not in this boundary's preserved list.
      rewindTo: { uuid: a1.uuid, viaBoundary: boundary.uuid },
      id: "c2",
    }),
    /not a context-tree occurrence/,
  );
  assert.equal(f.teardowns, 0);
});

// --- empty context (uuids: []) ----------------------------------------------

test("empty-uuids set-context appends a keep-nothing boundary; contextChanged carries leaf null", async (t) => {
  const f = fixture(t);
  linearSession(f);
  await f.handle({ type: "set-context", uuids: [], id: "c1" });
  const appended = readSessionEntries(f.file).at(-1)!;
  assert.equal(appended.subtype, "compact_boundary");
  assert.deepEqual(
    (appended.compactMetadata as { preservedMessages: { uuids: string[] } })
      .preservedMessages.uuids,
    [],
  );
  const event = f.emitted.findLast(
    (candidate): candidate is Extract<AgentEvent, { kind: "contextChanged" }> =>
      candidate.kind === "contextChanged",
  )!;
  assert.equal(event.leaf, null);
  const snapshot = (await f.handle({
    type: "get-entries",
    payload: "full",
    id: "g1",
  })) as GetEntriesResponse;
  assert.equal(snapshot.leaf, null);
  // A null leaf has no context.
  assert.deepEqual(await contextUuids(f), []);
});
