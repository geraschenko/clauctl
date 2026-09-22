// SDK expectation: how the CLI treats slash commands pushed while a turn
// runs (docs/claude-agent-sdk.md, "Slash commands are turns of their own").
// A prompt whose string content, or any text block of whose block-form
// content, starts with `/` is a command — built-in, custom, or unknown
// alike — and is never steered and never merged: it waits in the queue
// and runs as its own turn after the running turn's result, expanded into
// the `<command-name>` form in place (a built-in may expand to its alias:
// `/cost` → `/usage`; other blocks of a block-form prompt stay; an unknown
// one is forwarded to the model as plain text). A text that merely
// mentions a `/command` is an ordinary prompt, steered verbatim as a
// queued_command attachment (unexpanded — so the TUI renders an
// attachment as plain prompt text, transcript.ts entryUserViews). This is
// the predicate the queue model mirrors (queue-model.ts, isSlashCommand);
// a `later` command and a command between two texts in one bucket pin
// its placement. LIVE: one haiku session, ~12 calls.

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
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
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
 *  declared in sdk.d.ts 0.3.280 (only mentioned in interrupt prose). */
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
  sleepTurn: UUID;
  /** Pushed in the sleep turn's steer window. */
  steer: UUID;
  customSteer: UUID;
  embeddedSteer: UUID;
  unknownSteer: UUID;
  blockSteer: UUID;
  /** `[image, text "/cost"]` — clauctl's `--image` prompt shape. */
  imageBlockSteer: UUID;
  /** `[text "hello", text "/cost"]` — the command not in the first block. */
  textTextBlockSteer: UUID;
  laterSteer: UUID;
  /** Pushed at the sleep turn's result. */
  turn: UUID;
  customTurn: UUID;
  textTurn: UUID;
  /** Pushed into a text-only turn: text, command, text. */
  split: [UUID, UUID, UUID];
}

interface Capture {
  entries: SessionEntry[];
  stamped: Stamped;
  /** The query stream in order. */
  events: SDKMessage[];
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
    sleepTurn: randomUUID(),
    steer: randomUUID(),
    customSteer: randomUUID(),
    embeddedSteer: randomUUID(),
    unknownSteer: randomUUID(),
    blockSteer: randomUUID(),
    imageBlockSteer: randomUUID(),
    textTextBlockSteer: randomUUID(),
    laterSteer: randomUUID(),
    turn: randomUUID(),
    customTurn: randomUUID(),
    textTurn: randomUUID(),
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
          userMessage(
            [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: ONE_PIXEL_PNG,
                },
              },
              { type: "text", text: COMMAND },
            ],
            stamped.imageBlockSteer,
          ),
        );
        channel.push(
          userMessage(
            [
              { type: "text", text: "hello" },
              { type: "text", text: COMMAND },
            ],
            stamped.textTextBlockSteer,
          ),
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
          stamped.imageBlockSteer,
          stamped.textTextBlockSteer,
          stamped.laterSteer,
          stamped.turn,
          stamped.customTurn,
        ]),
      run: () => channel.push(userMessage(TEXT_TURN, stamped.textTurn)),
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
  channel.push(userMessage(SLEEP_TURN, stamped.sleepTurn));
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
  return { entries, stamped, events, lifecycles };
}

const capture = runSession();

/** Each result frame's consumed prompt uuids, in stream order. */
function resultUuidLists(events: SDKMessage[]): (string[] | undefined)[] {
  return events.flatMap((message) =>
    message.type === "result" ? [message.user_message_uuids] : [],
  );
}

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

/** The entry's content as block types, text blocks replaced by their
 *  text — undefined for string content. */
function userEntryBlocks(
  entries: SessionEntry[],
  uuid: UUID,
): string[] | undefined {
  const content = userEntryContent(entries, uuid);
  return Array.isArray(content)
    ? (content as { type: string; text?: string }[]).map((block) =>
        block.type === "text" ? (block.text ?? "") : `<${block.type}>`,
      )
    : undefined;
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
    [stamped.embeddedSteer],
  );
  const attachment = entries.find(
    (entry) => queuedCommandSourceUuid(entry) === stamped.embeddedSteer,
  );
  assert.equal(queuedCommandPrompt(attachment!), "Also run /cost please.");
  assert.equal(userEntryText(entries, stamped.embeddedSteer), undefined);
});

test("a /command in a text block is a command whatever precedes it: its own turn, expanded in place, other blocks kept", async () => {
  const { entries, stamped } = await capture;
  const expanded = /^<command-name>\/usage<\/command-name>/u;
  for (const uuid of [
    stamped.blockSteer,
    stamped.imageBlockSteer,
    stamped.textTextBlockSteer,
  ]) {
    assert.equal(queuedCommandPrompts(entries).has(uuid), false, uuid);
  }
  const blocksOf = (uuid: UUID): string[] => {
    const blocks = userEntryBlocks(entries, uuid);
    assert.ok(blocks !== undefined, `no block-form user entry for ${uuid}`);
    return blocks;
  };
  // A lone text block is written as string content.
  assert.match(userEntryText(entries, stamped.blockSteer) ?? "", expanded);
  const [image, afterImage] = blocksOf(stamped.imageBlockSteer);
  assert.equal(image, "<image>");
  assert.match(afterImage ?? "", expanded);
  const [hello, afterText] = blocksOf(stamped.textTextBlockSteer);
  assert.equal(hello, "hello");
  assert.match(afterText ?? "", expanded);
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

test("an unknown /name is a command too: not steered, its own run, forwarded to the model as plain text", async () => {
  const { entries, stamped, lifecycles } = await capture;
  assert.deepEqual(lifecycles.get(stamped.unknownSteer), [
    "queued",
    "started",
    "completed",
  ]);
  assert.equal(queuedCommandPrompts(entries).has(stamped.unknownSteer), false);
  assert.equal(userEntryText(entries, stamped.unknownSteer), "/nonexistent");
  assert.equal(
    localCommandOutputs(entries).some((output) =>
      output.includes("Unknown command"),
    ),
    false,
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

test("results list the folded-in steer with its turn and every command as a turn of its own", async () => {
  const { events, stamped } = await capture;
  assert.deepEqual(resultUuidLists(events), [
    [stamped.sleepTurn, stamped.embeddedSteer],
    [stamped.steer],
    [stamped.customSteer],
    [stamped.unknownSteer],
    [stamped.blockSteer],
    [stamped.imageBlockSteer],
    [stamped.textTextBlockSteer],
    [stamped.turn],
    [stamped.customTurn],
    [stamped.laterSteer],
    [stamped.textTurn],
    ...stamped.split.map((uuid) => [uuid]),
  ]);
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
