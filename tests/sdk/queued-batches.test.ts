// SDK expectation: how the CLI records several stamped prompts queued at
// once — the coalescing rule queue-model.ts is built on. Steers (default
// priority absorbed at a tool result) are never merged: one queued_command
// attachment per member. Appends (shouldQuery: false) are never merged: one
// user entry each, whether idle or queued. Within a same-priority bucket,
// a maximal run of consecutive querying members merges into one `\n`-joined
// user entry whose uuid is the run's LAST member; an append splits runs.
// A run with a block-form member merges to one block array instead
// (strings lifted to text blocks, no separator). Evidence:
// docs/derisk/queued-batches/. LIVE: one haiku session, ~10 calls.

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
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources";
import {
  readSessionEntries,
  type SessionEntry,
  sessionFilePath,
} from "../../src/core/session/file.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const SLEEP_TURN =
  "Run `sleep 4` as a Bash tool call, then reply with the single word DONE.";
const TEXT_TURN =
  "Write the numbers 1 through 60 in words, separated by commas, nothing else.";

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

type Placement = Pick<SDKUserMessage, "priority" | "shouldQuery">;

function userMessage(
  content: SDKUserMessage["message"]["content"],
  uuid: UUID,
  placement: Placement = {},
): SDKUserMessage {
  return {
    type: "user",
    uuid,
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...placement,
  };
}

/** 1x1 red PNG, the shape `clauctl prompt --image` sends. */
const IMAGE: ImageBlockParam = {
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  },
};

const LATER: Placement = { priority: "later" };
const APPEND: Placement = { shouldQuery: false };

function hasToolUse(message: SDKMessage): boolean {
  return (
    message.type === "assistant" &&
    message.message.content.some((block) => block.type === "tool_use")
  );
}

/** Emitted per stamped submission (docs/derisk/uuid-stamping/) but not
 *  declared in sdk.d.ts 0.3.258. */
interface CommandLifecycleMessage {
  type: "command_lifecycle";
  command_uuid: UUID;
  state: "queued" | "started" | "completed" | "cancelled";
}

function isCommandLifecycle(
  frame: SDKMessage | CommandLifecycleMessage,
): frame is CommandLifecycleMessage {
  return frame.type === "command_lifecycle";
}

function isLifecycleCompleted(
  message: SDKMessage | CommandLifecycleMessage,
  uuid: UUID,
): boolean {
  return (
    isCommandLifecycle(message) &&
    message.command_uuid === uuid &&
    message.state === "completed"
  );
}

interface Stamped {
  steer: [UUID, UUID, UUID];
  /** Default priority, queued during a text-only turn. */
  defaultRun: [UUID, UUID, UUID];
  /** Idle appends back to back, then a turn. */
  idleAppend: [UUID, UUID, UUID];
  /** `later`: querying (image + text), querying, append, querying. */
  mixed: [UUID, UUID, UUID, UUID];
}

interface Capture {
  entries: SessionEntry[];
  stamped: Stamped;
}

/** One session, four batches. Each batch is pushed at the moment that
 *  decides its placement (tool call on the stream, first stream_event,
 *  idle) and the next step starts when the batch's last member completes. */
async function runSession(): Promise<Capture> {
  assertVersions();
  const configDir = makeConfigDir("queued-batches");
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const stamped: Stamped = {
    steer: [randomUUID(), randomUUID(), randomUUID()],
    defaultRun: [randomUUID(), randomUUID(), randomUUID()],
    idleAppend: [randomUUID(), randomUUID(), randomUUID()],
    mixed: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
  };
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
  // Each step is (trigger, action); the action runs on the first message
  // matching the trigger, then the next step arms.
  const steps: {
    trigger: (message: SDKMessage) => boolean;
    run: () => void;
  }[] = [
    {
      trigger: hasToolUse,
      run: () => {
        channel.push(userMessage("Also say ONE.", stamped.steer[0]));
        channel.push(userMessage("Also say TWO.", stamped.steer[1]));
        channel.push(userMessage("Also say THREE.", stamped.steer[2]));
      },
    },
    {
      // The steers complete inside the running turn; wait for its result so
      // the text turn is the one the next batch is queued into.
      trigger: (message) => message.type === "result",
      run: () => channel.push(userMessage(TEXT_TURN, randomUUID())),
    },
    {
      trigger: (message) => message.type === "stream_event",
      run: () => {
        channel.push(userMessage("Reply ALPHA.", stamped.defaultRun[0]));
        channel.push(userMessage("Reply BETA.", stamped.defaultRun[1]));
        channel.push(userMessage("Reply GAMMA.", stamped.defaultRun[2]));
      },
    },
    {
      trigger: (message) =>
        isLifecycleCompleted(message, stamped.defaultRun[2]),
      run: () => {
        channel.push(
          userMessage("Note the word DELTA.", stamped.idleAppend[0], APPEND),
        );
        channel.push(
          userMessage("Note the word EPSILON.", stamped.idleAppend[1], APPEND),
        );
        channel.push(
          userMessage("Reply with the noted words.", stamped.idleAppend[2]),
        );
      },
    },
    {
      trigger: (message) =>
        isLifecycleCompleted(message, stamped.idleAppend[2]),
      run: () => channel.push(userMessage(SLEEP_TURN, randomUUID())),
    },
    {
      trigger: hasToolUse,
      run: () => {
        channel.push(
          userMessage(
            [IMAGE, { type: "text", text: "Reply RHO." }],
            stamped.mixed[0],
            LATER,
          ),
        );
        channel.push(userMessage("Reply SIGMA.", stamped.mixed[1], LATER));
        channel.push(
          userMessage("Note the word TAU.", stamped.mixed[2], {
            ...LATER,
            ...APPEND,
          }),
        );
        channel.push(userMessage("Reply UPSILON.", stamped.mixed[3], LATER));
      },
    },
    {
      trigger: (message) => isLifecycleCompleted(message, stamped.mixed[3]),
      run: () => channel.end(),
    },
  ];
  const events: SDKMessage[] = [];
  let sessionId: UUID | undefined;
  channel.push(userMessage(SLEEP_TURN, randomUUID()));
  try {
    for await (const message of q) {
      events.push(message);
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id as UUID;
      }
      if (steps[0]?.trigger(message)) steps.shift()?.run();
    }
  } finally {
    q.close();
  }
  assert.ok(sessionId, "no system/init");
  const filePath = sessionFilePath(configDir, cwd, sessionId);
  const entries = readSessionEntries(filePath);
  rmSync(cwd, { recursive: true, force: true });
  // Diagnostics for a failing run: what the query stream said, next to the file.
  writeFileSync(
    join(configDir, "query-events.jsonl"),
    events.map((message) => JSON.stringify(message)).join("\n") + "\n",
  );
  copyFileSync(filePath, join(configDir, "session.jsonl"));
  return { entries, stamped };
}

const capture = runSession();

function userEntryContent(entries: SessionEntry[], uuid: UUID): unknown {
  const entry = entries.find(
    (candidate) => candidate.uuid === uuid && candidate.type === "user",
  );
  return (entry?.message as { content?: unknown } | undefined)?.content;
}

function userEntryText(
  entries: SessionEntry[],
  uuid: UUID,
): string | undefined {
  const content = userEntryContent(entries, uuid);
  return typeof content === "string" ? content : undefined;
}

function queuedCommandSources(entries: SessionEntry[]): UUID[] {
  return entries.flatMap((entry) => {
    const attachment = entry.attachment as
      { type?: string; source_uuid?: UUID } | undefined;
    return attachment?.type === "queued_command" && attachment.source_uuid
      ? [attachment.source_uuid]
      : [];
  });
}

test("steers are never merged: one queued_command attachment per member, no user entry", async () => {
  const { entries, stamped } = await capture;
  assert.deepEqual(queuedCommandSources(entries), stamped.steer);
  for (const uuid of stamped.steer) {
    assert.equal(userEntryText(entries, uuid), undefined);
  }
});

test("a run of querying default-priority prompts merges into one entry under the last uuid", async () => {
  const { entries, stamped } = await capture;
  const [first, second, last] = stamped.defaultRun;
  assert.equal(userEntryText(entries, first), undefined);
  assert.equal(userEntryText(entries, second), undefined);
  assert.equal(
    userEntryText(entries, last),
    "Reply ALPHA.\nReply BETA.\nReply GAMMA.",
  );
});

test("appends are never merged: idle appends and the following turn are separate entries", async () => {
  const { entries, stamped } = await capture;
  const [firstAppend, secondAppend, turn] = stamped.idleAppend;
  assert.equal(userEntryText(entries, firstAppend), "Note the word DELTA.");
  assert.equal(userEntryText(entries, secondAppend), "Note the word EPSILON.");
  assert.equal(userEntryText(entries, turn), "Reply with the noted words.");
});

test("an append splits a bucket into runs, and a block-form member makes the run a block array: [Q, Q, A, Q] → [blocks] (last uuid), A, Q", async () => {
  const { entries, stamped } = await capture;
  const [firstQuery, secondQuery, append, lastQuery] = stamped.mixed;
  assert.equal(userEntryContent(entries, firstQuery), undefined);
  assert.deepEqual(userEntryContent(entries, secondQuery), [
    IMAGE,
    { type: "text", text: "Reply RHO." },
    { type: "text", text: "Reply SIGMA." },
  ]);
  assert.equal(userEntryText(entries, append), "Note the word TAU.");
  assert.equal(userEntryText(entries, lastQuery), "Reply UPSILON.");
});
