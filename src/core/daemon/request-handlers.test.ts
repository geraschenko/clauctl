/**
 * Probe ids in comments (e.g. P9 c) cite the experiments in
 * docs/derisk/compact-boundary-injection/FINDINGS.md that established each
 * behavior.
 */

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getSessionMessages,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { INITIAL_AGENT_STATE } from "../agent-state.ts";
import type { SessionTree } from "../tree.ts";
import type { PersistedOptions } from "../options.ts";
import {
  readSessionEntries,
  sessionFilePath,
  type SessionEntry,
} from "../session-file.ts";
import type { SdkEvent, SdkRequestRecord } from "../sdk-socket.ts";
import { EventHub } from "./event-hub.ts";
import {
  createRequestHandler,
  type RequestHandlerDeps,
} from "./request-handlers.ts";
import { RESPONSE_SENT, type SdkConnection } from "./sdk-server.ts";
import type { TurnQueue } from "./turn-queue.ts";

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
    request: SdkRequestRecord,
    connection?: SdkConnection,
  ) => Promise<unknown>;
  events: EventHub;
  pushed: SDKUserMessage[];
  persisted: PersistedOptions[];
  emitted: SdkEvent[];
  teardowns: number;
  restarts: Array<{ resume: string; at: UUID | undefined }>;
  sessionId: UUID;
  file: string;
  writeEntries: (entries: SessionEntry[]) => void;
}

interface FixtureOptions {
  claudeQuery?: Partial<Query>;
  /** Initial persisted options (default {}). */
  persistedOptions?: PersistedOptions;
  withSession?: boolean;
  teardownQuery?: () => Promise<void>;
  restartQuery?: () => Promise<void>;
  /** Written to the session file BEFORE the handler is created, so startup
   *  reconstruction sees them. */
  initialEntries?: (sessionId: UUID) => SessionEntry[];
}

function fixture(options: FixtureOptions = {}): Fixture {
  const pushed: SDKUserMessage[] = [];
  const persisted: PersistedOptions[] = [];
  let persistedOptions: PersistedOptions = options.persistedOptions ?? {};
  const sessionId = uuid();
  const cwd = "/work/fixture";
  const configDir = mkdtempSync(join(tmpdir(), "clauctl-rh-"));
  // getSessionMessages resolves the transcript through CLAUDE_CONFIG_DIR at
  // call time; tests in one file run sequentially, so this does not race.
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const file = sessionFilePath(configDir, cwd, sessionId);
  mkdirSync(join(configDir, "projects", "-work-fixture"), { recursive: true });
  const events = new EventHub({
    seed: {
      ...INITIAL_AGENT_STATE,
      cwd,
      ...(options.withSession !== false && { sessionId }),
    },
    deliver: (message) => pushed.push(message),
  });
  const emitted: SdkEvent[] = [];
  events.subscribe((line) => {
    emitted.push((JSON.parse(line) as { event: SdkEvent }).event);
  });
  const f: Fixture = {
    handle: (request, connection = { write: () => {}, onClose: () => {} }) =>
      handler(request, connection),
    events,
    pushed,
    persisted,
    emitted,
    teardowns: 0,
    restarts: [],
    sessionId,
    file,
    writeEntries: (entries) => {
      writeFileSync(
        file,
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      );
    },
  };
  const deps: RequestHandlerDeps = {
    getQuery: () => (options.claudeQuery ?? {}) as Query,
    events,
    // The compact path only pushes; a recording stub suffices.
    getTurnQueue: () =>
      ({
        push: (message: SDKUserMessage) => pushed.push(message),
      }) as unknown as TurnQueue,
    cwd,
    log: (message) => {
      throw new Error(`unexpected daemon-log diagnostic: ${message}`);
    },
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
    restartQuery: async (resume, at) => {
      f.restarts.push({ resume, at });
      await options.restartQuery?.();
    },
  };
  if (options.initialEntries !== undefined) {
    const entries = options.initialEntries(sessionId);
    f.writeEntries(entries);
    // Mirrors daemon.ts: the startup read feeds the handler as a dep.
    deps.startupEntries = entries;
  }
  const handler = createRequestHandler(deps);
  return f;
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

test("query delivers through the hub; the events are the response", async () => {
  const f = fixture();
  const result = await f.handle({ type: "query", content: "hi", id: "r1" });
  assert.equal(result, undefined);
  assert.equal(f.pushed.length, 1);
  assert.deepEqual(f.pushed[0]!.origin, { kind: "human" });
  assert.equal(f.events.agentState.activity, "pending");
});

test("/compact while idle pushes directly and emits compactSent", async () => {
  const f = fixture();
  await f.handle({ type: "query", content: "/compact", id: "r1" });
  assert.equal(f.pushed.length, 1);
  assert.deepEqual(f.pushed[0]!.origin, { kind: "human" });
  assert.deepEqual(
    f.emitted.map((event) => event.kind),
    ["compactSent"], // no queued/dequeued pair
  );
  assert.equal(f.events.agentState.activity, "compacting");
});

test("/compact is rejected when not idle", async () => {
  const f = fixture();
  f.events.deliverUserMessage(userMessage());
  assert.equal(f.events.agentState.activity, "pending");
  await assert.rejects(
    f.handle({ type: "query", content: "/compact", id: "r2" }),
    /requires an idle assistant/,
  );
});

test("subscribe writes its own response carrying events.agentState", async () => {
  const f = fixture();
  f.events.deliverUserMessage(userMessage());
  const written: string[] = [];
  const connection: SdkConnection = {
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
});

// runRead's switch has no default, so without the explicit rejection an
// unknown type would fall through to `ok: true` — an old CLI's archive would
// take a false "wait-idle" acknowledgement as "idle" and SIGTERM a busy agent.
test("an unknown request type (e.g. legacy wait-idle) is rejected, not acknowledged", async () => {
  const f = fixture();
  await assert.rejects(
    f.handle({ type: "wait-idle", id: "w1" } as unknown as SdkRequestRecord),
    /unknown request type: wait-idle/,
  );
  // Inherited property names must not classify as known request types (the
  // type tables are consulted with hasOwn, not `in`).
  await assert.rejects(
    f.handle({ type: "constructor", id: "w2" } as unknown as SdkRequestRecord),
    /unknown request type: constructor/,
  );
});

test("get-messages with no session returns [] without touching the transcript", async () => {
  const f = fixture({ withSession: false });
  assert.deepEqual(await f.handle({ type: "get-messages", id: "g1" }), []);
});

test("interrupt returns the SDK queue-survival receipt and emits its event", async () => {
  const stillQueued = [uuid(), uuid()];
  const f = fixture({
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

test("two in-flight mutations do not interleave: apply and persist run as a chain", async () => {
  const order: string[] = [];
  const gates: Array<() => void> = [];
  const claudeQuery: Partial<Query> = {
    setModel: (model?: string) => {
      order.push(`apply:${model}`);
      return new Promise((resolve) => gates.push(() => resolve(undefined)));
    },
  };
  const f = fixture({ claudeQuery });
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

test("a failed mutation rejects its requester without poisoning the chain", async () => {
  let calls = 0;
  const claudeQuery: Partial<Query> = {
    setModel: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(undefined);
    },
  };
  const f = fixture({ claudeQuery });
  await assert.rejects(f.handle({ type: "set-model", model: "a", id: "m1" }));
  await f.handle({ type: "set-model", model: "b", id: "m2" });
  assert.deepEqual(
    f.persisted.map((options) => options.model),
    ["b"],
  );
});

test("apply-flag-settings effortLevel null emits the resolved post-clear level", async () => {
  const claudeQuery: Partial<Query> = {
    applyFlagSettings: async () => undefined,
  };
  // The spawn --effort flag wins the post-clear resolution.
  const f = fixture({ claudeQuery, persistedOptions: { effort: "max" } });
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

test("apply-flag-settings effortLevel null stays null when no tier specifies one", async () => {
  const claudeQuery: Partial<Query> = {
    applyFlagSettings: async () => undefined,
  };
  // No --effort flag; the fixture's isolated CLAUDE_CONFIG_DIR has no
  // settings, so the cascade yields nothing.
  const f = fixture({ claudeQuery });
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

// --- get-entries / get-tree ----------------------------------------------------

test("get-entries returns every entry verbatim; get-tree builds the forest plus the leaf", async () => {
  const f = fixture();
  const { u1, a1, a2 } = linearSession(f);
  const entries = (await f.handle({
    type: "get-entries",
    id: "e1",
  })) as SessionEntry[];
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], u1);
  const tree = (await f.handle({ type: "get-tree", id: "t1" })) as SessionTree;
  assert.equal(tree.tree.length, 1);
  assert.deepEqual(tree.tree[0]!.entry, u1);
  assert.deepEqual(tree.tree[0]!.children[0]!.entry, a1);
  assert.deepEqual(tree.leaf, { uuid: a2.uuid });
});

// Criterion 2: the leaf follows the same override the get-messages answer
// uses — a no-write rewind moves it to the rewind target until the next
// transcript write.
test("get-tree leaf reflects a no-write rewind's filterTail override", async () => {
  const f = fixture();
  const { a1 } = linearSession(f);
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  const tree = (await f.handle({ type: "get-tree", id: "t1" })) as SessionTree;
  assert.deepEqual(tree.leaf, { uuid: a1.uuid });
});

test("get-entries and get-tree return empty results without a session", async () => {
  const f = fixture({ withSession: false });
  const entries = (await f.handle({
    type: "get-entries",
    id: "e1",
  })) as SessionEntry[];
  assert.deepEqual(entries, []);
  const tree = (await f.handle({ type: "get-tree", id: "t1" })) as SessionTree;
  assert.deepEqual(tree, { tree: [], leaf: null });
});

// --- set-context validation ------------------------------------------------

test("set-context rejects while busy, before any teardown", async () => {
  const f = fixture();
  linearSession(f);
  f.events.deliverUserMessage(userMessage());
  await assert.rejects(
    f.handle({ type: "set-context", uuids: [uuid()], id: "c1" }),
    /requires an idle assistant/,
  );
  assert.equal(f.teardowns, 0);
});

test("set-context rejects delivered-but-unconfirmed prompts as busy", async () => {
  const f = fixture();
  linearSession(f);
  const appendOnly: SDKUserMessage = { ...userMessage(), shouldQuery: false };
  f.events.deliverUserMessage(appendOnly);
  assert.equal(f.events.agentState.activity, "idle");
  await assert.rejects(
    f.handle({ type: "set-context", uuids: [uuid()], id: "c1" }),
    /requires an idle assistant/,
  );
});

test("set-context rejects unknown and duplicate uuid lists", async () => {
  const f = fixture();
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
  await assert.rejects(
    f.handle(
      { type: "set-context", uuids: [u1.uuid], anchor: "summary", id: "c4" },
      undefined,
    ),
    /nothing to anchor on/,
  );
  assert.equal(f.teardowns, 0);
  assert.equal(f.restarts.length, 0);
});

test("set-context errors without a session", async () => {
  const f = fixture({ withSession: false });
  await assert.rejects(
    f.handle({ type: "set-context", uuids: [uuid()], id: "c1" }),
    /no session yet/,
  );
});

// --- set-context boundary mode -----------------------------------------------

test("boundary mode appends boundary+summary, restarts, verifies, broadcasts", async () => {
  const f = fixture();
  const { u2, a2 } = linearSession(f);
  const result = (await f.handle({
    type: "set-context",
    uuids: [u2.uuid, a2.uuid],
    summaryText: "earlier we discussed X",
    id: "c1",
  })) as { boundaryUuid: UUID; summaryUuid: UUID };

  assert.equal(f.teardowns, 1);
  assert.deepEqual(f.restarts, [{ resume: f.sessionId, at: undefined }]);

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
    ["contextChanged"],
  );
  // The effective context (also what get-messages now returns): summary
  // first, then the preserved uuids.
  const messages = (await f.handle({
    type: "get-messages",
    id: "g1",
  })) as Array<{
    uuid: string;
  }>;
  assert.deepEqual(
    messages.map((message) => message.uuid),
    [result.summaryUuid, u2.uuid, a2.uuid],
  );
});

test("boundary mode without summary uses the boundary's own uuid as anchor", async () => {
  const f = fixture();
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
  const messages = (await f.handle({
    type: "get-messages",
    id: "g1",
  })) as Array<{
    uuid: string;
  }>;
  assert.deepEqual(
    messages.map((message) => message.uuid),
    [u2.uuid, a2.uuid],
  );
});

// --- set-context rewind mode ---------------------------------------------------

test("rewind on the active chain uses resumeSessionAt and mutates nothing", async () => {
  const f = fixture();
  const { u1, a1, u2, a2 } = linearSession(f);
  const result = await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  assert.deepEqual(result, {});
  assert.equal(f.teardowns, 1);
  assert.deepEqual(f.restarts, [{ resume: f.sessionId, at: a1.uuid }]);
  assert.equal(readSessionEntries(f.file).length, 4); // no file mutation
  assert.deepEqual(
    f.emitted.map((event) => event.kind),
    ["contextChanged"],
  );
  // get-messages filters the superseded tail until the next turn replaces it.
  const messages = (await f.handle({
    type: "get-messages",
    id: "g1",
  })) as Array<{
    uuid: string;
  }>;
  assert.deepEqual(
    messages.map((message) => message.uuid),
    [u1.uuid, a1.uuid],
  );
  void u2;
  void a2;
});

test("rewind to an abandoned branch appends a no-summary boundary", async () => {
  const f = fixture();
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
  assert.deepEqual(f.restarts, [{ resume: sid, at: undefined }]);
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
  // After the boundary append, the leaf is the new effective tip straight
  // from the re-read file (no override involvement) — a relinked node, since
  // the chain ends inside the boundary's relink (no post entries).
  const tree = (await f.handle({ type: "get-tree", id: "t1" })) as SessionTree;
  assert.deepEqual(tree.leaf, {
    uuid: a2a.uuid,
    viaBoundary: result.boundaryUuid,
  });
});

// A no-write rewind's context truth lives only in its filterTail override —
// a boundary appended while that override is fresh must anchor its
// logicalParentUuid at the rewound leaf, not the file's un-rewound chain
// tip, or the logical-history path re-introduces the dropped tail.
test("boundary appended after a no-write rewind anchors at the rewound leaf", async () => {
  const f = fixture();
  const { u1, a1, a2 } = linearSession(f);
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  await f.handle({ type: "set-context", uuids: [u1.uuid, a1.uuid], id: "c2" });
  const boundary = readSessionEntries(f.file).at(-1)!;
  assert.equal(boundary.subtype, "compact_boundary");
  assert.equal(boundary.logicalParentUuid, a1.uuid);
  assert.notEqual(boundary.logicalParentUuid, a2.uuid);
});

test("abandoned-branch rewind after a no-write rewind anchors at the rewound leaf", async () => {
  const f = fixture();
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
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a2a.uuid },
    id: "c2",
  });
  const boundary = readSessionEntries(f.file).at(-1)!;
  assert.equal(boundary.subtype, "compact_boundary");
  assert.equal(boundary.logicalParentUuid, a1.uuid);
});

// Pins a characterized SDK divergence (see the verification comment in
// set-context.ts): getSessionMessages reports the WRONG chain for a boundary
// whose preserved-uuids tip predates another dangling leaf in file order,
// even though the CLI loader honors the boundary (FINDINGS.md P9 a/b,
// wire-verified).
// get-messages papers over it with the synthesize override (asserted here
// too). If an SDK upgrade fixes this, the raw assertion fails and the
// override becomes unnecessary.
test("KNOWN DIVERGENCE: raw getSessionMessages ignores a branch-switch boundary; get-messages synthesizes the loader chain", async () => {
  const f = fixture();
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

  const raw = await getSessionMessages(sid, { dir: "/work/fixture" });
  assert.deepEqual(
    raw.map((message) => message.uuid),
    // Wrong: the tip u2b/a2b predates nothing, so W6 picks it over the
    // preserved-uuids tip a2a.
    [u1.uuid, a1.uuid, u2b.uuid, a2b.uuid],
  );
  const messages = (await f.handle({
    type: "get-messages",
    id: "g1",
  })) as Array<{
    uuid: string;
  }>;
  assert.deepEqual(
    messages.map((message) => message.uuid),
    // The loader (and the next turn's context) uses [u1, a1, u2a, a2a].
    [u1.uuid, a1.uuid, u2a.uuid, a2a.uuid],
  );
});

test("the synthesis window closes when the next transcript write lands", async () => {
  const f = fixture();
  const { u2, a2 } = linearSession(f);
  await f.handle({ type: "set-context", uuids: [u2.uuid, a2.uuid], id: "c1" });
  const u3 = userEntry(a2.uuid, f.sessionId, "post-boundary turn");
  f.writeEntries([...readSessionEntries(f.file), u3]);
  f.events.observeSdkMessage({
    type: "user",
    uuid: u3.uuid,
    session_id: f.sessionId,
    message: { role: "user", content: "post-boundary turn" },
    parent_tool_use_id: null,
  } as SDKMessage);
  const messages = (await f.handle({
    type: "get-messages",
    id: "g1",
  })) as Array<{
    uuid: string;
  }>;
  // Passthrough again (a stale synthesize chain would omit u3), and
  // getSessionMessages now agrees with the loader.
  assert.deepEqual(
    messages.map((message) => message.uuid),
    [u2.uuid, a2.uuid, u3.uuid],
  );
});

test("startup inside the synthesis window reconstructs the synthesize override", async () => {
  let entries!: ReturnType<typeof linearSession>;
  const f = fixture({
    initialEntries: (sid) => {
      const u1 = userEntry(null, sid);
      const a1 = assistantEntry(u1.uuid, sid);
      const u2 = userEntry(a1.uuid, sid);
      const a2 = assistantEntry(u2.uuid, sid);
      entries = { u1, a1, u2, a2 };
      return [
        u1,
        a1,
        u2,
        a2,
        boundaryEntry({
          sessionId: sid,
          uuids: [u1.uuid, a1.uuid],
          anchor: "own",
        }),
      ];
    },
  });
  const messages = (await f.handle({
    type: "get-messages",
    id: "g1",
  })) as Array<{
    uuid: string;
  }>;
  // The loader honors the preserved uuids [u1, a1]; raw getSessionMessages would
  // report [u1, a1, u2, a2] (a2 is the latest dangling leaf).
  assert.deepEqual(
    messages.map((message) => message.uuid),
    [entries.u1.uuid, entries.a1.uuid],
  );
});

// On a boundary preserving the file's tail the raw SDK picks the RIGHT chain
// even inside the window, so its output is the ground truth for the
// synthesized shape
// (message payloads, session_id, parent_tool_use_id, timestamp — compared on
// the wire, i.e. after JSON serialization).
test("synthesized get-messages matches raw getSessionMessages field-for-field", async () => {
  const f = fixture();
  const sid = f.sessionId;
  const stamp = { timestamp: "2026-07-15T00:00:00.000Z" };
  const u1 = { ...userEntry(null, sid), ...stamp };
  const a1 = { ...assistantEntry(u1.uuid, sid), ...stamp };
  const u2 = { ...userEntry(a1.uuid, sid), ...stamp };
  const a2 = { ...assistantEntry(u2.uuid, sid), ...stamp };
  f.writeEntries([u1, a1, u2, a2]);
  await f.handle({
    type: "set-context",
    uuids: [u2.uuid, a2.uuid],
    summaryText: "the summary",
    id: "c1",
  });
  const synthesized = await f.handle({ type: "get-messages", id: "g1" });
  const raw = await getSessionMessages(sid, { dir: "/work/fixture" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(synthesized)),
    JSON.parse(JSON.stringify(raw)),
  );
});

test("startup after the window closed passes get-messages through", async () => {
  let chain!: UUID[];
  const f = fixture({
    initialEntries: (sid) => {
      const u1 = userEntry(null, sid);
      const a1 = assistantEntry(u1.uuid, sid);
      const boundary = boundaryEntry({
        sessionId: sid,
        uuids: [u1.uuid, a1.uuid],
        anchor: "own",
      });
      const u2 = userEntry(a1.uuid, sid, "post-boundary turn");
      chain = [u1.uuid, a1.uuid, u2.uuid];
      return [u1, a1, boundary, u2];
    },
  });
  const messages = (await f.handle({
    type: "get-messages",
    id: "g1",
  })) as Array<{
    uuid: string;
  }>;
  assert.deepEqual(
    messages.map((message) => message.uuid),
    chain,
  );
});

test("rewind to a member of a boundary's preserved uuids resurrects the summarized region", async () => {
  const f = fixture();
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

  // a2 predates the boundary, so its first-appeared context is the raw chain
  // u1..a2 — not the boundary's [summary, u2, a2] view. resumeSessionAt would
  // keep the boundary (P9 c; see file comment), so this must go the
  // no-summary-boundary route.
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

test("rewind validates the target: present, assistant, final API-message entry", async () => {
  const f = fixture();
  const sid = f.sessionId;
  const u1 = userEntry(null, sid);
  const thinking = assistantEntry(u1.uuid, sid, "msg_shared");
  const text = assistantEntry(thinking.uuid, sid, "msg_shared");
  f.writeEntries([u1, thinking, text]);

  await assert.rejects(
    f.handle({ type: "set-context", rewindTo: { uuid: uuid() }, id: "c1" }),
    /not in the session file/,
  );
  await assert.rejects(
    f.handle({ type: "set-context", rewindTo: { uuid: u1.uuid }, id: "c2" }),
    /must be an assistant entry/,
  );
  await assert.rejects(
    f.handle({
      type: "set-context",
      rewindTo: { uuid: thinking.uuid },
      id: "c3",
    }),
    /FINAL transcript entry/,
  );
  assert.equal(f.teardowns, 0);
  // The final sibling is a valid target.
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: text.uuid },
    id: "c4",
  });
  assert.deepEqual(f.restarts, [{ resume: sid, at: text.uuid }]);
});

// --- gate and restart-failure behavior -----------------------------------------

test("while a context change is in flight, Query-bound requests error and reads wait", async () => {
  let releaseTeardown!: () => void;
  const teardownGate = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  const f = fixture({ teardownQuery: () => teardownGate });
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
  const read = f.handle({ type: "get-entries", id: "e1" }).then((entries) => {
    entriesResolved = true;
    return entries;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entriesResolved, false); // reads wait for the gate

  releaseTeardown();
  await setContext;
  assert.equal(((await read) as SessionEntry[]).length, 4);
});

test("set-context drains in-flight Query operations before teardown", async () => {
  let resolveInterrupt!: () => void;
  const claudeQuery: Partial<Query> = {
    interrupt: () =>
      new Promise((resolve) => {
        resolveInterrupt = () => resolve(undefined);
      }),
  };
  const f = fixture({ claudeQuery });
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

test("restart failure leaves the daemon query-unavailable until a set-context succeeds", async () => {
  let failRestart = true;
  const f = fixture({
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
    ["contextChanged"],
  );
  // Query-bound requests error; file reads keep working.
  await assert.rejects(
    f.handle({ type: "interrupt", id: "i1" }),
    /query restart failed; retry set-context/,
  );
  await assert.rejects(
    f.handle({ type: "query", content: "hi", id: "q1" }),
    /query restart failed; retry set-context/,
  );
  assert.equal(
    ((await f.handle({ type: "get-entries", id: "e1" })) as SessionEntry[])
      .length,
    5,
  );
  // A subsequent set-context reconstructs the Query.
  failRestart = false;
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c2",
  });
  await f.handle({ type: "query", content: "hi", id: "q2" });
  assert.equal(f.pushed.length, 1);
});

test("a later durable boundary clears the superseded-tail filter", async () => {
  const f = fixture();
  const { u1, a1, u2, a2 } = linearSession(f);
  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  // Now a boundary listing the full chain: the file carries the truth again.
  await f.handle({
    type: "set-context",
    uuids: [u1.uuid, a1.uuid, u2.uuid, a2.uuid],
    id: "c2",
  });
  const messages = (await f.handle({
    type: "get-messages",
    id: "g1",
  })) as Array<{
    uuid: string;
  }>;
  assert.deepEqual(
    messages.map((message) => message.uuid),
    [u1.uuid, a1.uuid, u2.uuid, a2.uuid],
  );
});

// The contextChanged.leaf invariant: the event carries exactly the leaf a
// post-change get-tree reports (the empty and viaBoundary paths are pinned
// in their own tests below).
test("contextChanged.leaf equals the post-change get-tree leaf (append and no-write rewind)", async () => {
  const lastContextChanged = (f: Fixture) =>
    f.emitted.findLast(
      (event): event is Extract<SdkEvent, { kind: "contextChanged" }> =>
        event.kind === "contextChanged",
    )!;

  const appendFixture = fixture();
  const { u2, a2 } = linearSession(appendFixture);
  await appendFixture.handle({
    type: "set-context",
    uuids: [u2.uuid, a2.uuid],
    id: "c1",
  });
  const appendTree = (await appendFixture.handle({
    type: "get-tree",
    id: "g1",
  })) as SessionTree;
  const appendEvent = lastContextChanged(appendFixture);
  assert.notEqual(appendEvent.leaf, null);
  assert.notEqual(appendEvent.leaf!.viaBoundary, undefined);
  assert.deepEqual(appendEvent.leaf, appendTree.leaf);

  const rewindFixture = fixture();
  const { a1 } = linearSession(rewindFixture);
  await rewindFixture.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid },
    id: "c1",
  });
  const rewindTree = (await rewindFixture.handle({
    type: "get-tree",
    id: "g1",
  })) as SessionTree;
  const rewindEvent = lastContextChanged(rewindFixture);
  assert.deepEqual(rewindEvent.leaf, { uuid: a1.uuid });
  assert.deepEqual(rewindEvent.leaf, rewindTree.leaf);
});

// --- occurrence-aware rewind (rewindTo.viaBoundary) --------------------------

test("viaBoundary rewind to a prefix of the active chain takes the no-write path", async () => {
  const f = fixture();
  const { u1, a1 } = linearSession(f);
  const boundary = boundaryEntry({
    sessionId: f.sessionId,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  const entries = [...readSessionEntries(f.file), boundary];
  f.writeEntries(entries);

  await f.handle({
    type: "set-context",
    rewindTo: { uuid: a1.uuid, viaBoundary: boundary.uuid },
    id: "c1",
  });
  // No file mutation; resumeSessionAt into the preserved member (P9 c).
  assert.equal(readSessionEntries(f.file).length, entries.length);
  assert.deepEqual(f.restarts, [{ resume: f.sessionId, at: a1.uuid }]);
  const event = f.emitted.findLast(
    (candidate): candidate is Extract<SdkEvent, { kind: "contextChanged" }> =>
      candidate.kind === "contextChanged",
  )!;
  assert.deepEqual(event.leaf, { uuid: a1.uuid, viaBoundary: boundary.uuid });
  const tree = (await f.handle({ type: "get-tree", id: "g1" })) as SessionTree;
  assert.deepEqual(tree.leaf, event.leaf);
});

test("viaBoundary rewind into a superseded boundary's chain appends a prefix boundary", async () => {
  const f = fixture();
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
  // chain (P3 m5) — a pick inside the first cannot resume, so it appends.
  f.writeEntries([u1, a1, u2, a2, first, second]);

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
    (candidate): candidate is Extract<SdkEvent, { kind: "contextChanged" }> =>
      candidate.kind === "contextChanged",
  )!;
  assert.deepEqual(event.leaf, { uuid: a1.uuid, viaBoundary: appended.uuid });
  const tree = (await f.handle({ type: "get-tree", id: "g1" })) as SessionTree;
  assert.deepEqual(tree.leaf, event.leaf);
});

test("viaBoundary rewind validates the boundary and the chain membership", async () => {
  const f = fixture();
  const { u1, a1, u2, a2 } = linearSession(f);
  const boundary = boundaryEntry({
    sessionId: f.sessionId,
    uuids: [u2.uuid, a2.uuid],
    anchor: "own",
  });
  f.writeEntries([u1, a1, u2, a2, boundary]);
  await assert.rejects(
    f.handle({
      type: "set-context",
      rewindTo: { uuid: a2.uuid, viaBoundary: u1.uuid },
      id: "c1",
    }),
    /does not name a compact_boundary entry/,
  );
  await assert.rejects(
    f.handle({
      type: "set-context",
      // a1 is in the file but not on the chain this boundary installed.
      rewindTo: { uuid: a1.uuid, viaBoundary: boundary.uuid },
      id: "c2",
    }),
    /not on the context chain installed by boundary/,
  );
  assert.equal(f.teardowns, 0);
});

// --- empty context (uuids: []) ----------------------------------------------

test("empty-uuids set-context appends a keep-nothing boundary; contextChanged carries leaf null", async () => {
  const f = fixture();
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
    (candidate): candidate is Extract<SdkEvent, { kind: "contextChanged" }> =>
      candidate.kind === "contextChanged",
  )!;
  assert.equal(event.leaf, null);
  const tree = (await f.handle({ type: "get-tree", id: "g1" })) as SessionTree;
  assert.equal(tree.leaf, null);
  // The synthesize override serves the (empty) chain.
  assert.deepEqual(await f.handle({ type: "get-messages", id: "g2" }), []);
});
