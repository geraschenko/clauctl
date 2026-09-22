// SDK expectation: how a session rollover (`/clear`) looks on the query
// stream and in the files, for the daemon's session bookkeeping and the
// fold's attribution of dequeued prompts (docs/specs/query-pending-list.md).
// Facts pinned: `conversation_reset.new_conversation_id` is NOT the new
// transcript id (only the following `system/init` is authoritative — if
// this starts failing, the init workaround in daemon.ts/agent-state can go);
// every turn opens with a `system/init` right after its lifecycle
// `started` (the reset turn: `conversation_reset`, then the init), before
// its `result`; the reset command's own entry and a prompt queued behind it
// land in the NEW file. Evidence:
// docs/derisk/clear-vs-session-experiment/ (exp4). LIVE: haiku, ~3 calls.

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type SDKMessage,
  type SDKUserMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  readSessionEntries,
  type SessionEntry,
  sessionFilePath,
} from "../../src/core/session/file.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";

/** Manually driven streaming input: `push` hands the CLI one message. */
function inputChannel(): {
  input: AsyncIterable<SDKUserMessage>;
  push: (message: SDKUserMessage) => void;
  end: () => void;
} {
  const pending: SDKUserMessage[] = [];
  let waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  let ended = false;
  const deliver = (result: IteratorResult<SDKUserMessage>): void => {
    const resolve = waiting;
    waiting = null;
    resolve?.(result);
  };
  return {
    input: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            const queued = pending.shift();
            if (queued !== undefined) {
              return Promise.resolve({ value: queued, done: false });
            }
            if (ended) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => {
              waiting = resolve;
            });
          },
        };
      },
    },
    push: (message) => {
      if (waiting) deliver({ value: message, done: false });
      else pending.push(message);
    },
    end: () => {
      ended = true;
      deliver({ value: undefined, done: true });
    },
  };
}

function userMessage(text: string, uuid: UUID): SDKUserMessage {
  return {
    type: "user",
    uuid,
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

/** Emitted per stamped submission but not declared in sdk.d.ts 0.3.280 (only mentioned in interrupt prose). */
interface CommandLifecycleMessage {
  type: "command_lifecycle";
  command_uuid: UUID;
  state: "queued" | "started" | "completed" | "cancelled";
}

type StreamMessage = SDKMessage | CommandLifecycleMessage;

function isLifecycle(
  message: StreamMessage,
  uuid: UUID,
  state: CommandLifecycleMessage["state"],
): boolean {
  return (
    message.type === "command_lifecycle" &&
    message.command_uuid === uuid &&
    message.state === state
  );
}

interface Stamped {
  before: UUID;
  clear: UUID;
  /** Pushed right behind `/clear`, so it is queued when the reset runs. */
  behind: UUID;
  after: UUID;
}

interface Capture {
  events: StreamMessage[];
  stamped: Stamped;
  /** The init session ids in first-seen order. */
  sessionIds: UUID[];
  entriesOf: (sessionId: UUID) => SessionEntry[];
}

async function runSession(): Promise<Capture> {
  assertVersions();
  const configDir = makeConfigDir("clear-session");
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const stamped: Stamped = {
    before: randomUUID(),
    clear: randomUUID(),
    behind: randomUUID(),
    after: randomUUID(),
  };
  const channel = inputChannel();
  const q = query({
    prompt: channel.input,
    options: {
      env: baseEnv(configDir),
      cwd,
      model: HAIKU,
      permissionMode: "dontAsk",
      includePartialMessages: true,
    },
  });
  const steps: {
    trigger: (message: StreamMessage) => boolean;
    run: () => void;
  }[] = [
    {
      trigger: (message) => isLifecycle(message, stamped.before, "completed"),
      run: () => {
        channel.push(userMessage("/clear", stamped.clear));
        channel.push(userMessage("Reply BETA.", stamped.behind));
      },
    },
    {
      trigger: (message) => isLifecycle(message, stamped.behind, "completed"),
      run: () => channel.push(userMessage("Reply GAMMA.", stamped.after)),
    },
    {
      trigger: (message) => isLifecycle(message, stamped.after, "completed"),
      run: () => channel.end(),
    },
  ];
  const events: StreamMessage[] = [];
  const sessionIds: UUID[] = [];
  channel.push(userMessage("Reply ALPHA.", stamped.before));
  try {
    for await (const message of q) {
      events.push(message);
      if (message.type === "system" && message.subtype === "init") {
        const sessionId = message.session_id as UUID;
        if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId);
      }
      if (steps[0]?.trigger(message)) steps.shift()?.run();
    }
  } finally {
    q.close();
  }
  const entriesOf = (sessionId: UUID): SessionEntry[] => {
    const filePath = sessionFilePath(configDir, cwd, sessionId);
    return existsSync(filePath) ? readSessionEntries(filePath) : [];
  };
  const files = Object.fromEntries(
    sessionIds.map((sessionId) => [sessionId, entriesOf(sessionId)]),
  );
  rmSync(cwd, { recursive: true, force: true });
  writeFileSync(
    join(configDir, "query-events.jsonl"),
    events.map((message) => JSON.stringify(message)).join("\n") + "\n",
  );
  return {
    events,
    stamped,
    sessionIds,
    entriesOf: (sessionId) => files[sessionId] ?? [],
  };
}

const capture = runSession();

function userEntryUuids(entries: SessionEntry[]): UUID[] {
  return entries.flatMap((entry) =>
    entry.type === "user" && entry.uuid !== undefined ? [entry.uuid] : [],
  );
}

/** Messages after the lifecycle `started` of `uuid`, lifecycle frames
 *  and stream events dropped. */
function turnOpening(capture: Capture, uuid: UUID): StreamMessage[] {
  const startedAt = capture.events.findIndex((message) =>
    isLifecycle(message, uuid, "started"),
  );
  assert.notEqual(startedAt, -1, `no started frame for ${uuid}`);
  return capture.events
    .slice(startedAt + 1)
    .filter(
      (message) =>
        message.type !== "command_lifecycle" && message.type !== "stream_event",
    );
}

function isInitOf(message: StreamMessage, sessionId: UUID): boolean {
  return (
    message.type === "system" &&
    message.subtype === "init" &&
    message.session_id === sessionId
  );
}

test("/clear rolls the session id over in place: exactly two ids, announced by init", async () => {
  const { sessionIds } = await capture;
  assert.equal(sessionIds.length, 2);
});

test("conversation_reset.new_conversation_id is not the new transcript id", async () => {
  const { events, sessionIds } = await capture;
  const reset = events.find((message) => message.type === "conversation_reset");
  assert.ok(reset && reset.type === "conversation_reset");
  assert.notEqual(reset.new_conversation_id, sessionIds[1]);
  assert.notEqual(reset.new_conversation_id, sessionIds[0]);
});

test("every turn opens with its session's init right after `started`; the reset turn's init names the NEW session", async () => {
  const c = await capture;
  const [oldId, newId] = c.sessionIds as [UUID, UUID];
  assert.ok(isInitOf(turnOpening(c, c.stamped.before)[0]!, oldId));
  const [reset, init] = turnOpening(c, c.stamped.clear);
  assert.equal(reset?.type, "conversation_reset");
  assert.ok(isInitOf(init!, newId));
  assert.ok(isInitOf(turnOpening(c, c.stamped.behind)[0]!, newId));
  assert.ok(isInitOf(turnOpening(c, c.stamped.after)[0]!, newId));
});

test("the new init precedes the reset turn's result, which precedes the queued prompt's turn", async () => {
  const c = await capture;
  const opening = turnOpening(c, c.stamped.clear);
  const resultAt = opening.findIndex((message) => message.type === "result");
  const behindStartedAt = c.events.findIndex((message) =>
    isLifecycle(message, c.stamped.behind, "started"),
  );
  const resetResultAt = c.events.indexOf(opening[resultAt]!);
  assert.ok(resultAt > 0, "no result for the reset turn");
  assert.ok(resetResultAt < behindStartedAt);
});

test("the reset command's entry and the prompt queued behind it land in the new file", async () => {
  const { stamped, sessionIds, entriesOf } = await capture;
  const [oldId, newId] = sessionIds as [UUID, UUID];
  const oldUuids = userEntryUuids(entriesOf(oldId));
  const newUuids = userEntryUuids(entriesOf(newId));
  assert.ok(oldUuids.includes(stamped.before));
  assert.ok(!oldUuids.includes(stamped.clear));
  assert.ok(!oldUuids.includes(stamped.behind));
  assert.ok(newUuids.includes(stamped.clear));
  assert.ok(newUuids.includes(stamped.behind));
  assert.ok(newUuids.includes(stamped.after));
});
