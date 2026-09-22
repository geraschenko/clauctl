// SDK expectation: when a steer is pushed during an API response with
// several parallel tool calls, the CLI absorbs it only after the LAST of
// that response's tool results, and files its queued_command attachment
// after that result and before the next response's first assistant entry
// (docs/claude-agent-sdk.md, "Queued prompts coalesce by run"). The queue
// model mirrors this by firing the steer dequeue at the first top-level
// assistant frame whose `message.id` differs from the running response's
// (queue-model.ts, observeSdkMessage); the second test replays the
// captured stream through it. LIVE: one haiku session, ~3 calls.

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type SDKMessage,
  type SDKUserMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  acceptUserMessage,
  INITIAL_QUEUE_MODEL_STATE,
  observeSdkMessage,
} from "../../src/core/daemon/queue-model.ts";
import {
  queuedCommandSourceUuid,
  readSessionEntries,
  type SessionEntry,
  sessionFilePath,
} from "../../src/core/session/file.ts";
import { isToolResultEntry } from "../../src/core/tree/loader.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const PARALLEL_TURN =
  "In a single response, issue three Bash tool calls in parallel: `sleep 3`, `sleep 4` and `sleep 5`. Do not run them one after another. When all three have returned, reply with the single word DONE.";
const STEER = "Also mention the word STEERED in your final reply.";
/** A CLI that never closes a lifecycle would hang the probe; a quiet
 *  stream this long ends the session so the assertions report instead. */
const INACTIVITY_MS = 60_000;

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

function userMessage(content: string, uuid: UUID): SDKUserMessage {
  return {
    type: "user",
    uuid,
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

function hasToolUse(message: SDKMessage): boolean {
  return (
    message.type === "assistant" &&
    message.message.content.some((block) => block.type === "tool_use")
  );
}

interface Capture {
  entries: SessionEntry[];
  /** The query stream in order. */
  events: SDKMessage[];
  /** Index in `events` of the frame at which the steer was pushed. */
  steerPushedAt: number;
  turn: UUID;
  steer: UUID;
}

/** One turn asking for three parallel sleeps; the steer is pushed at the
 *  first tool_use frame; the session ends at the turn's result. */
async function runSession(): Promise<Capture> {
  assertVersions();
  const configDir = makeConfigDir("steer-parallel-tools");
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const turn = randomUUID();
  const steer = randomUUID();
  const channel = inputChannel();
  const q = query({
    prompt: channel.input,
    options: {
      env: baseEnv(configDir),
      cwd,
      model: HAIKU,
      allowedTools: ["Bash(sleep:*)"],
      permissionMode: "dontAsk",
      includePartialMessages: true,
    },
  });
  const events: SDKMessage[] = [];
  let steerPushedAt = -1;
  let sessionId: UUID | undefined;
  let inactivity = setTimeout(() => channel.end(), INACTIVITY_MS);
  channel.push(userMessage(PARALLEL_TURN, turn));
  try {
    for await (const message of q) {
      clearTimeout(inactivity);
      inactivity = setTimeout(() => channel.end(), INACTIVITY_MS);
      events.push(message);
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id as UUID;
      }
      if (steerPushedAt === -1 && hasToolUse(message)) {
        steerPushedAt = events.length - 1;
        channel.push(userMessage(STEER, steer));
      }
      if (message.type === "result") channel.end();
    }
  } finally {
    clearTimeout(inactivity);
    q.close();
  }
  assert.ok(sessionId, "no system/init");
  assert.notEqual(steerPushedAt, -1, "no tool_use frame");
  const filePath = sessionFilePath(configDir, cwd, sessionId);
  const entries = readSessionEntries(filePath);
  rmSync(cwd, { recursive: true, force: true });
  writeFileSync(
    join(configDir, "query-events.jsonl"),
    events.map((message) => JSON.stringify(message)).join("\n") + "\n",
  );
  copyFileSync(filePath, join(configDir, "session.jsonl"));
  return { entries, events, steerPushedAt, turn, steer };
}

const capture = runSession();

function apiMessageId(entry: SessionEntry): string | undefined {
  return (entry.message as { id?: string } | undefined)?.id;
}

/** Entry indices of the response that issued the parallel calls: its
 *  assistant entries (one per block, sharing `message.id`) and the
 *  tool_result entries answering them. */
function parallelResponse(
  entries: SessionEntry[],
  events: SDKMessage[],
  steerPushedAt: number,
): { responseId: string; toolUseCount: number; lastResultIndex: number } {
  const frame = events[steerPushedAt]!;
  assert.equal(frame.type, "assistant");
  const responseId = frame.message.id;
  const toolUseIds = new Set(
    entries.flatMap((entry) =>
      entry.type === "assistant" && apiMessageId(entry) === responseId
        ? (
            entry.message as { content: { type: string; id?: string }[] }
          ).content
            .filter((block) => block.type === "tool_use")
            .map((block) => block.id!)
        : [],
    ),
  );
  assert.ok(
    toolUseIds.size >= 2,
    `the response issued ${toolUseIds.size} tool call(s); the probe needs parallel calls`,
  );
  let lastResultIndex = -1;
  entries.forEach((entry, index) => {
    if (!isToolResultEntry(entry)) return;
    const blocks = (entry.message as { content: { tool_use_id?: string }[] })
      .content;
    if (blocks.some((block) => toolUseIds.has(block.tool_use_id ?? ""))) {
      lastResultIndex = index;
    }
  });
  assert.notEqual(lastResultIndex, -1, "no tool_result entries");
  return { responseId, toolUseCount: toolUseIds.size, lastResultIndex };
}

test("the CLI files the steer's attachment after the last tool_result of the parallel response, before the next assistant entry", async () => {
  const { entries, events, steerPushedAt, steer } = await capture;
  const response = parallelResponse(entries, events, steerPushedAt);
  console.log(`parallel tool calls: ${response.toolUseCount}`);
  const attachmentIndex = entries.findIndex(
    (entry) => queuedCommandSourceUuid(entry) === steer,
  );
  assert.notEqual(attachmentIndex, -1, "steer was not filed as an attachment");
  assert.ok(
    attachmentIndex > response.lastResultIndex,
    `attachment at ${attachmentIndex}, last tool_result at ${response.lastResultIndex}`,
  );
  const nextAssistantIndex = entries.findIndex(
    (entry, index) =>
      index > response.lastResultIndex && entry.type === "assistant",
  );
  assert.notEqual(nextAssistantIndex, -1, "no response after the results");
  assert.ok(
    attachmentIndex < nextAssistantIndex,
    `attachment at ${attachmentIndex}, next assistant entry at ${nextAssistantIndex}`,
  );
});

test("the turn's result lists the prompt, then the folded-in steer", async () => {
  const { events, turn, steer } = await capture;
  const results = events.filter((message) => message.type === "result");
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]!.user_message_uuids, [turn, steer]);
});

test("the queue model replays the capture with the steer dequeue at the next response's first assistant frame", async () => {
  const { events, steerPushedAt, steer } = await capture;
  let state = INITIAL_QUEUE_MODEL_STATE;
  let dequeuedAt = -1;
  events.forEach((message, index) => {
    if (index === steerPushedAt) {
      state = acceptUserMessage(
        state,
        userMessage(STEER, steer),
        false,
        randomUUID(),
      ).state;
    }
    const transition = observeSdkMessage(state, message);
    state = transition.state;
    if (
      transition.events.some(
        (event) =>
          event.kind === "userMessageDequeued" && event.uuids.includes(steer),
      )
    ) {
      assert.equal(dequeuedAt, -1, "steer dequeued twice");
      dequeuedAt = index;
    }
  });
  assert.notEqual(dequeuedAt, -1, "steer never dequeued");
  const trigger = events[dequeuedAt]!;
  assert.equal(trigger.type, "assistant");
  const responseId = (events[steerPushedAt] as { message: { id: string } })
    .message.id;
  assert.notEqual(
    trigger.message.id,
    responseId,
    "dequeued within the response",
  );
  const topLevelToolResults = events.filter(
    (message, index) =>
      index < dequeuedAt &&
      message.type === "user" &&
      message.parent_tool_use_id === null &&
      Array.isArray(message.message.content) &&
      message.message.content.some((block) => block.type === "tool_result"),
  );
  const responseFrames = events.filter(
    (message) =>
      message.type === "assistant" && message.message.id === responseId,
  );
  const toolUseCount = responseFrames.filter(hasToolUse).length;
  assert.equal(
    topLevelToolResults.length,
    toolUseCount,
    "dequeued before every tool_result of the response",
  );
  assert.deepEqual(state.queued, []);
});
