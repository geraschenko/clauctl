// SDK expectation: the classification table in docs/specs/session-tracker.md
// — which uuids the query stream and the session file share — plus the two
// facts the stream merge leans on: shared uuids arrive in the same relative
// order on both sides, and the CLI persists a host-stamped
// `SDKUserMessage.uuid` as the file's `user` entry uuid (except for a message
// steered into a running turn, which only surfaces as
// `attachment.source_uuid`). Evidence: docs/derisk/stream-classification/,
// docs/derisk/uuid-stamping/. LIVE: one haiku session, ~8 calls.

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type SDKMessage,
  type SDKUserMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type SessionEntry,
  SessionEntryParser,
  sessionFilePath,
} from "../../src/core/session/file.ts";
import { UUID_PATTERN } from "../../src/core/uuid.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const HOOK = { hooks: [{ type: "command", command: "echo hook-ran" }] };
const SETTINGS = {
  hooks: { PostToolUse: [{ matcher: "Bash", ...HOOK }], Stop: [HOOK] },
};

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

function classOf(item: SDKMessage | SessionEntry): string {
  return `${item.type}/${"subtype" in item ? item.subtype : "-"}`;
}

function hasToolUse(message: SDKMessage): boolean {
  return (
    message.type === "assistant" &&
    message.message.content.some((block) => block.type === "tool_use")
  );
}

interface Capture {
  events: SDKMessage[];
  entries: SessionEntry[];
  stamped: { idle: UUID; steered: UUID; final: UUID };
}

/** One session: a stamped Bash turn with a second stamped message steered
 *  into it, `/cost` (local command), `/compact`, a stamped closing turn. */
async function runSession(): Promise<Capture> {
  assertVersions();
  const configDir = makeConfigDir("stream-classification", SETTINGS);
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const stamped = {
    idle: randomUUID(),
    steered: randomUUID(),
    final: randomUUID(),
  };
  const channel = inputChannel();
  const q = query({
    prompt: channel.input,
    options: {
      env: baseEnv(configDir),
      cwd,
      model: HAIKU,
      allowedTools: ["Bash"],
      permissionMode: "auto",
      includePartialMessages: true,
    },
  });
  // Each step runs when the previous turn's `result` arrives; the steered
  // message goes in as soon as the first turn's tool call is on the stream.
  const steps: (() => void)[] = [
    () => channel.push(userMessage("/cost", randomUUID())),
    () => channel.push(userMessage("/compact", randomUUID())),
    () =>
      channel.push(
        userMessage("Reply with exactly the word pong.", stamped.final),
      ),
    () => channel.end(),
  ];
  const events: SDKMessage[] = [];
  let sessionId: UUID | undefined;
  let steeredSent = false;
  channel.push(
    userMessage(
      "Run `sleep 3; echo probe-one` as a Bash tool call, then reply with the single word DONE.",
      stamped.idle,
    ),
  );
  try {
    for await (const message of q) {
      events.push(message);
      if (message.type === "system" && message.subtype === "init") {
        assert.match(message.session_id, UUID_PATTERN);
        sessionId = message.session_id as UUID;
      }
      if (!steeredSent && hasToolUse(message)) {
        steeredSent = true;
        channel.push(userMessage("Also say the word QUEUED.", stamped.steered));
      }
      if (message.type === "result") steps.shift()?.();
    }
  } finally {
    q.close();
  }
  assert.ok(sessionId, "no system/init");
  const filePath = sessionFilePath(configDir, cwd, sessionId);
  const entries = new SessionEntryParser(filePath).push(readFileSync(filePath));
  rmSync(cwd, { recursive: true, force: true });
  // Diagnostics for a failing run: what the query stream said, next to the file.
  writeFileSync(
    join(configDir, "query-events.jsonl"),
    events.map((message) => JSON.stringify(message)).join("\n") + "\n",
  );
  copyFileSync(filePath, join(configDir, "session.jsonl"));
  return { events, entries, stamped };
}

const capture = runSession();

test("shared classes: query assistant/user/compact_boundary uuids are in the file", async () => {
  const { events, entries } = await capture;
  const fileUuids = new Set(entries.map((entry) => entry.uuid));
  const shared = events.filter(
    (message) =>
      message.type === "assistant" ||
      message.type === "user" ||
      (message.type === "system" && message.subtype === "compact_boundary"),
  );
  assert.ok(shared.some((message) => message.type === "assistant"));
  assert.ok(shared.some((message) => message.type === "user"));
  assert.ok(shared.some((message) => message.type === "system"));
  for (const message of shared) {
    assert.ok(message.uuid, `${classOf(message)} without uuid`);
    assert.ok(
      fileUuids.has(message.uuid),
      `${classOf(message)} ${message.uuid} not in file`,
    );
  }
});

test("query-only classes never share a uuid with the file", async () => {
  const { events, entries } = await capture;
  const fileUuids = new Set(entries.map((entry) => entry.uuid));
  const queryOnly = events.filter(
    (message) =>
      message.type === "result" ||
      message.type === "stream_event" ||
      (message.type === "system" && message.subtype !== "compact_boundary"),
  );
  assert.ok(queryOnly.some((message) => message.type === "result"));
  assert.ok(queryOnly.some((message) => message.type === "stream_event"));
  for (const message of queryOnly) {
    assert.ok(
      message.uuid === undefined || !fileUuids.has(message.uuid),
      `${classOf(message)} ${message.uuid} unexpectedly in file`,
    );
  }
});

test("local command output: query assistant shares its uuid with the file's system/local_command", async () => {
  const { events, entries } = await capture;
  const localCommands = entries.filter(
    (entry) => entry.type === "system" && entry.subtype === "local_command",
  );
  assert.equal(localCommands.length, 1, "/cost should log one local_command");
  const twin = events.find((message) => message.uuid === localCommands[0].uuid);
  assert.equal(twin?.type, "assistant");
});

test("hooks run but never reach the query stream", async () => {
  const { events, entries } = await capture;
  assert.ok(
    entries.some((entry) => entry.subtype === "stop_hook_summary"),
    "Stop hook did not run",
  );
  for (const message of events) {
    assert.ok(
      !/hook/.test(classOf(message)),
      `${classOf(message)} on query stream`,
    );
  }
});

test("stamped SDKUserMessage.uuid becomes the file's user entry uuid; a steered message only surfaces as attachment.source_uuid", async () => {
  const { events, entries, stamped } = await capture;
  const userEntry = (uuid: UUID): SessionEntry | undefined =>
    entries.find((entry) => entry.uuid === uuid && entry.type === "user");
  assert.ok(userEntry(stamped.idle));
  assert.ok(userEntry(stamped.final));
  assert.equal(userEntry(stamped.steered), undefined);
  assert.ok(
    entries.some((entry) => {
      const attachment = entry.attachment as
        { type?: string; source_uuid?: string } | undefined;
      return (
        attachment?.type === "queued_command" &&
        attachment.source_uuid === stamped.steered
      );
    }),
    "steered message not recorded as queued_command attachment",
  );
  for (const uuid of Object.values(stamped)) {
    assert.ok(
      !events.some((message) => message.uuid === uuid),
      "query stream echoed a stamped uuid",
    );
  }
});

// The query stream can repeat a shared uuid (observed: the /cost output
// re-emitted after /compact when it was the compaction's preserved tail), so
// the daemon dedups query uuids first-wins before merging; the invariant it
// relies on is the order of first occurrences.
test("shared uuids appear in the same relative order on both streams", async () => {
  const { events, entries } = await capture;
  const queryUuids = new Set(events.map((message) => message.uuid));
  const fileUuids = new Set(entries.map((entry) => entry.uuid));
  const sharedOnQuery = [
    ...new Set(
      events
        .map((message) => message.uuid)
        .filter((uuid) => uuid !== undefined && fileUuids.has(uuid)),
    ),
  ];
  const sharedOnFile = entries
    .map((entry) => entry.uuid)
    .filter((uuid) => uuid !== undefined && queryUuids.has(uuid));
  assert.ok(sharedOnQuery.length >= 10);
  assert.deepEqual(sharedOnQuery, sharedOnFile);
});
