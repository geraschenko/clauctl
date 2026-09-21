// SDK expectation: how the CLI treats slash commands pushed while a turn
// runs (docs/claude-agent-sdk.md, "Slash commands are turns of their own").
// A prompt that IS a `/command` (built-in or custom) is never steered and
// never merged: it waits in the queue and runs as its own turn after the
// running turn's result, expanded into the `<command-name>` form (a
// built-in may expand to its alias: `/cost` → `/usage`). A plain-text
// prompt that merely mentions a `/command` is steered like any other: its
// queued_command attachment carries the text verbatim, unexpanded — so
// the TUI renders an attachment as plain prompt text (transcript.ts,
// entryUserViews). LIVE: one haiku session, ~5 calls.

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
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
  queuedCommandPrompt,
  queuedCommandSourceUuid,
  readSessionEntries,
  type SessionEntry,
  sessionFilePath,
} from "../../src/core/session/file.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const SLEEP_TURN =
  "Run `sleep 4` as a Bash tool call, then reply with the single word DONE.";
const COMMAND = "/cost";

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

/** Emitted per stamped submission (docs/derisk/uuid-stamping/) but not
 *  declared in sdk.d.ts 0.3.258. */
interface CommandLifecycleMessage {
  type: "command_lifecycle";
  command_uuid: UUID;
  state: "queued" | "started" | "completed" | "cancelled";
}

function isLifecycleCompleted(
  message: SDKMessage | CommandLifecycleMessage,
  uuid: UUID,
): boolean {
  return (
    message.type === "command_lifecycle" &&
    message.command_uuid === uuid &&
    message.state === "completed"
  );
}

interface Capture {
  entries: SessionEntry[];
  steer: UUID;
  turn: UUID;
  customSteer: UUID;
  embeddedSteer: UUID;
  customTurn: UUID;
}

/** A sleep turn; at its tool call, a built-in command, a custom command
 *  and a text mentioning a command are pushed (the steer window); once the
 *  sleep turn's result arrives, both commands again as turns. */
async function runSession(): Promise<Capture> {
  assertVersions();
  const configDir = makeConfigDir("steer-slash-command");
  mkdirSync(join(configDir, "commands"));
  writeFileSync(
    join(configDir, "commands", "hello.md"),
    "Reply with the single word HELLO_EXPANDED.\n",
  );
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const steer = randomUUID();
  const turn = randomUUID();
  const customSteer = randomUUID();
  const embeddedSteer = randomUUID();
  const customTurn = randomUUID();
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
  const steps: {
    trigger: (message: SDKMessage) => boolean;
    run: () => void;
  }[] = [
    {
      trigger: hasToolUse,
      run: () => {
        channel.push(userMessage(COMMAND, steer));
        channel.push(userMessage("/hello", customSteer));
        channel.push(userMessage("Also run /cost please.", embeddedSteer));
      },
    },
    {
      trigger: (message) => message.type === "result",
      run: () => {
        channel.push(userMessage(COMMAND, turn));
        channel.push(userMessage("/hello", customTurn));
      },
    },
    {
      trigger: (message) => isLifecycleCompleted(message, customTurn),
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
  writeFileSync(
    join(configDir, "query-events.jsonl"),
    events.map((message) => JSON.stringify(message)).join("\n") + "\n",
  );
  copyFileSync(filePath, join(configDir, "session.jsonl"));
  return { entries, steer, turn, customSteer, embeddedSteer, customTurn };
}

const capture = runSession();

function userEntryText(
  entries: SessionEntry[],
  uuid: UUID,
): string | undefined {
  const entry = entries.find(
    (candidate) => candidate.uuid === uuid && candidate.type === "user",
  );
  const content = (entry?.message as { content?: unknown } | undefined)
    ?.content;
  return typeof content === "string" ? content : undefined;
}

function userEntryIndex(entries: SessionEntry[], uuid: UUID): number {
  return entries.findIndex(
    (candidate) => candidate.uuid === uuid && candidate.type === "user",
  );
}

function queuedCommandSources(entries: SessionEntry[]): UUID[] {
  return entries.flatMap((entry) => {
    const source = queuedCommandSourceUuid(entry);
    return source === undefined ? [] : [source];
  });
}

test("a text mentioning a /command is steered verbatim: one attachment, unexpanded, no user entry", async () => {
  const { entries, embeddedSteer } = await capture;
  assert.deepEqual(queuedCommandSources(entries), [embeddedSteer]);
  const attachment = entries.find(
    (entry) => queuedCommandSourceUuid(entry) === embeddedSteer,
  );
  assert.equal(queuedCommandPrompt(attachment!), "Also run /cost please.");
  assert.equal(userEntryText(entries, embeddedSteer), undefined);
});

test("a /command pushed in the steer window is not steered: it runs as its own expanded turn after the result", async () => {
  const { entries, steer, customSteer, embeddedSteer } = await capture;
  const attachmentAt = entries.findIndex(
    (entry) => queuedCommandSourceUuid(entry) === embeddedSteer,
  );
  for (const [uuid, expanded] of [
    [steer, /<command-name>\/usage<\/command-name>/u],
    [customSteer, /<command-name>\/hello<\/command-name>/u],
  ] as const) {
    const text = userEntryText(entries, uuid);
    assert.ok(text !== undefined, `no user entry for ${uuid}`);
    assert.match(text, expanded);
    assert.ok(userEntryIndex(entries, uuid) > attachmentAt, "ran mid-turn");
  }
});

test("queued /commands are not merged: each keeps its own entry, and each turn expands", async () => {
  const { entries, steer, customSteer, turn, customTurn } = await capture;
  // A merged run would leave only its last member's uuid in the file.
  for (const uuid of [steer, customSteer, turn, customTurn]) {
    assert.notEqual(userEntryIndex(entries, uuid), -1, uuid);
  }
  assert.match(
    userEntryText(entries, turn)!,
    /<command-name>\/usage<\/command-name>/u,
  );
  assert.match(
    userEntryText(entries, customTurn)!,
    /<command-name>\/hello<\/command-name>/u,
  );
});
