// SDK expectation: how the CLI treats slash commands pushed while a turn
// runs (docs/claude-agent-sdk.md, "Slash commands are turns of their own").
// A prompt whose STRING content starts with `/` is a command — built-in,
// custom, or unknown alike — and is never steered and never merged: it
// waits in the queue and runs as its own turn after the running turn's
// result, expanded into the `<command-name>` form (a built-in may expand
// to its alias: `/cost` → `/usage`; an unknown one writes only
// `local_command` system entries, no user entry). Everything else is an
// ordinary prompt: a text that merely mentions a `/command`, and a
// `/command` in block-form content, are steered verbatim as a
// queued_command attachment (unexpanded — so the TUI renders an
// attachment as plain prompt text, transcript.ts entryUserViews). This is
// the predicate the queue model mirrors (queue-model.ts, isSlashCommand);
// a `later` command and a command between two texts in one bucket pin
// its placement. LIVE: one haiku session, ~10 calls.

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
const TEXT_TURN =
  "Write the numbers 1 through 60 in words, separated by commas, nothing else.";
const COMMAND = "/cost";
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

function userMessage(
  content: SDKUserMessage["message"]["content"],
  uuid: UUID,
  placement: Pick<SDKUserMessage, "priority"> = {},
): SDKUserMessage {
  return {
    type: "user",
    uuid,
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...placement,
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

function isCommandLifecycle(
  frame: SDKMessage | CommandLifecycleMessage,
): frame is CommandLifecycleMessage {
  return frame.type === "command_lifecycle";
}

interface Stamped {
  /** Pushed in the sleep turn's steer window. */
  steer: UUID;
  customSteer: UUID;
  embeddedSteer: UUID;
  unknownSteer: UUID;
  blockSteer: UUID;
  laterSteer: UUID;
  /** Pushed at the sleep turn's result. */
  turn: UUID;
  customTurn: UUID;
  /** Pushed into a text-only turn: text, command, text. */
  split: [UUID, UUID, UUID];
}

interface Capture {
  entries: SessionEntry[];
  stamped: Stamped;
  /** Lifecycle states per uuid, in stream order. */
  lifecycles: Map<UUID, CommandLifecycleMessage["state"][]>;
}

/** A sleep turn; at its tool call, a built-in command, a custom command,
 *  a text mentioning a command, an unknown command, a block-form command
 *  and a `later` command are pushed (the steer window); once the sleep
 *  turn's result arrives, both commands again as turns. Then a text-only
 *  turn, into which text, `/cost`, text are pushed as one bucket. */
async function runSession(): Promise<Capture> {
  assertVersions();
  const configDir = makeConfigDir("steer-slash-command");
  mkdirSync(join(configDir, "commands"));
  writeFileSync(
    join(configDir, "commands", "hello.md"),
    "Reply with the single word HELLO_EXPANDED.\n",
  );
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const stamped: Stamped = {
    steer: randomUUID(),
    customSteer: randomUUID(),
    embeddedSteer: randomUUID(),
    unknownSteer: randomUUID(),
    blockSteer: randomUUID(),
    laterSteer: randomUUID(),
    turn: randomUUID(),
    customTurn: randomUUID(),
    split: [randomUUID(), randomUUID(), randomUUID()],
  };
  const lifecycles = new Map<UUID, CommandLifecycleMessage["state"][]>();
  /** True once every uuid has a terminal lifecycle state. */
  const allClosed = (uuids: UUID[]): boolean =>
    uuids.every((uuid) => {
      const last = lifecycles.get(uuid)?.at(-1);
      return last === "completed" || last === "cancelled";
    });
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
        channel.push(userMessage(COMMAND, stamped.steer));
        channel.push(userMessage("/hello", stamped.customSteer));
        channel.push(
          userMessage("Also run /cost please.", stamped.embeddedSteer),
        );
        channel.push(userMessage("/nonexistent", stamped.unknownSteer));
        channel.push(
          userMessage([{ type: "text", text: COMMAND }], stamped.blockSteer),
        );
        channel.push(
          userMessage(COMMAND, stamped.laterSteer, { priority: "later" }),
        );
      },
    },
    {
      trigger: (message) => message.type === "result",
      run: () => {
        channel.push(userMessage(COMMAND, stamped.turn));
        channel.push(userMessage("/hello", stamped.customTurn));
      },
    },
    {
      trigger: () =>
        allClosed([
          stamped.steer,
          stamped.customSteer,
          stamped.unknownSteer,
          stamped.blockSteer,
          stamped.laterSteer,
          stamped.turn,
          stamped.customTurn,
        ]),
      run: () => channel.push(userMessage(TEXT_TURN, randomUUID())),
    },
    {
      trigger: (message) => message.type === "stream_event",
      run: () => {
        channel.push(userMessage("Reply ALPHA.", stamped.split[0]));
        channel.push(userMessage(COMMAND, stamped.split[1]));
        channel.push(userMessage("Reply BETA.", stamped.split[2]));
      },
    },
    {
      trigger: () => allClosed([stamped.split[1], stamped.split[2]]),
      run: () => channel.end(),
    },
  ];
  const events: SDKMessage[] = [];
  let sessionId: UUID | undefined;
  let inactivity = setTimeout(() => channel.end(), INACTIVITY_MS);
  channel.push(userMessage(SLEEP_TURN, randomUUID()));
  try {
    for await (const message of q) {
      clearTimeout(inactivity);
      inactivity = setTimeout(() => channel.end(), INACTIVITY_MS);
      events.push(message);
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id as UUID;
      }
      // A cast, not an annotation: assignment narrows to SDKMessage, which
      // excludes the frame.
      const frame = message as SDKMessage | CommandLifecycleMessage;
      if (isCommandLifecycle(frame)) {
        const states = lifecycles.get(frame.command_uuid) ?? [];
        states.push(frame.state);
        lifecycles.set(frame.command_uuid, states);
      }
      if (steps[0]?.trigger(message)) steps.shift()?.run();
    }
  } finally {
    clearTimeout(inactivity);
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
  return { entries, stamped, lifecycles };
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

/** Every queued_command attachment's prompt by source uuid, block-form
 *  prompts included (`queuedCommandSourceUuid` reads string prompts only). */
function queuedCommandPrompts(entries: SessionEntry[]): Map<UUID, unknown> {
  const prompts = new Map<UUID, unknown>();
  for (const entry of entries) {
    const attachment = entry.attachment as
      { type?: unknown; prompt?: unknown; source_uuid?: unknown } | undefined;
    if (
      entry.type === "attachment" &&
      attachment?.type === "queued_command" &&
      typeof attachment.source_uuid === "string"
    ) {
      prompts.set(attachment.source_uuid as UUID, attachment.prompt);
    }
  }
  return prompts;
}

function localCommandOutputs(entries: SessionEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.type === "system" &&
    entry.subtype === "local_command" &&
    typeof entry.content === "string"
      ? [entry.content]
      : [],
  );
}

test("a text mentioning a /command is steered verbatim: one attachment, unexpanded, no user entry", async () => {
  const { entries, stamped, lifecycles } = await capture;
  console.log(`lifecycles: ${JSON.stringify([...lifecycles])}`);
  assert.deepEqual(
    [...queuedCommandPrompts(entries).keys()],
    [stamped.embeddedSteer, stamped.blockSteer],
  );
  const attachment = entries.find(
    (entry) => queuedCommandSourceUuid(entry) === stamped.embeddedSteer,
  );
  assert.equal(queuedCommandPrompt(attachment!), "Also run /cost please.");
  assert.equal(userEntryText(entries, stamped.embeddedSteer), undefined);
});

test("a /command in block-form content is not a command: steered as a block-form attachment", async () => {
  const { entries, stamped } = await capture;
  assert.deepEqual(queuedCommandPrompts(entries).get(stamped.blockSteer), [
    { type: "text", text: COMMAND },
  ]);
  assert.equal(userEntryIndex(entries, stamped.blockSteer), -1);
});

test("a /command pushed in the steer window is not steered: it runs as its own expanded turn after the result", async () => {
  const { entries, stamped } = await capture;
  const attachmentAt = entries.findIndex(
    (entry) => queuedCommandSourceUuid(entry) === stamped.embeddedSteer,
  );
  for (const [uuid, expanded] of [
    [stamped.steer, /<command-name>\/usage<\/command-name>/u],
    [stamped.customSteer, /<command-name>\/hello<\/command-name>/u],
  ] as const) {
    const text = userEntryText(entries, uuid);
    assert.ok(text !== undefined, `no user entry for ${uuid}`);
    assert.match(text, expanded);
    assert.ok(userEntryIndex(entries, uuid) > attachmentAt, "ran mid-turn");
  }
});

test("queued /commands are not merged: each keeps its own entry, and each turn expands", async () => {
  const { entries, stamped } = await capture;
  // A merged run would leave only its last member's uuid in the file.
  for (const uuid of [
    stamped.steer,
    stamped.customSteer,
    stamped.turn,
    stamped.customTurn,
  ]) {
    assert.notEqual(userEntryIndex(entries, uuid), -1, uuid);
  }
  assert.match(
    userEntryText(entries, stamped.turn)!,
    /<command-name>\/usage<\/command-name>/u,
  );
  assert.match(
    userEntryText(entries, stamped.customTurn)!,
    /<command-name>\/hello<\/command-name>/u,
  );
});

test("an unknown /name is a command too: not steered, its own run, local_command output only", async () => {
  const { entries, stamped, lifecycles } = await capture;
  assert.deepEqual(lifecycles.get(stamped.unknownSteer), [
    "queued",
    "started",
    "completed",
  ]);
  assert.equal(queuedCommandPrompts(entries).has(stamped.unknownSteer), false);
  assert.equal(userEntryIndex(entries, stamped.unknownSteer), -1);
  assert.ok(
    localCommandOutputs(entries).some((output) =>
      output.includes("Unknown command: /nonexistent"),
    ),
  );
});

test("a `later` command runs expanded after the default-priority turns pushed after it", async () => {
  const { entries, stamped } = await capture;
  assert.match(
    userEntryText(entries, stamped.laterSteer) ?? "",
    /<command-name>\/usage<\/command-name>/u,
  );
  assert.ok(
    userEntryIndex(entries, stamped.laterSteer) >
      Math.max(
        userEntryIndex(entries, stamped.turn),
        userEntryIndex(entries, stamped.customTurn),
      ),
  );
});

test("a /command between two texts in one bucket splits it into three runs", async () => {
  const { entries, stamped } = await capture;
  const [first, command, second] = stamped.split;
  assert.equal(userEntryText(entries, first), "Reply ALPHA.");
  assert.match(
    userEntryText(entries, command) ?? "",
    /<command-name>\/usage<\/command-name>/u,
  );
  assert.equal(userEntryText(entries, second), "Reply BETA.");
  assert.ok(
    userEntryIndex(entries, first) < userEntryIndex(entries, command) &&
      userEntryIndex(entries, command) < userEntryIndex(entries, second),
  );
});
