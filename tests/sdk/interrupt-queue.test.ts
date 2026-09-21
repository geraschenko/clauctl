// SDK expectation: what the CLI's queue does across an interrupt, the
// fact the daemon's queue model and user-message-tracking.md rely on.
// (a) A plain `Query.interrupt()` aborts the running turn only: a prompt
// queued behind it survives (the receipt lists it as `still_queued`) and
// runs as its own turn right after the aborted turn's `result`. (b) A `now`
// prompt is an interrupt (docs/claude-agent-sdk.md, "Queued prompts
// coalesce by run"); a default-priority prompt queued before it in the
// tool-call window survives it the same way. (c) A `/command` sent with
// `now` also interrupts and runs expanded. In each case the aborted turn's
// user entry stays in the file with no assistant reply. Diagnostics:
// lifecycle states per uuid and the receipts land in the scratch dir.
// LIVE: one haiku session, ~7 calls.

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKUserMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  queuedCommandSourceUuid,
  readSessionEntries,
  type SessionEntry,
  sessionFilePath,
} from "../../src/core/session/file.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const SLEEP_TURN =
  "Run `sleep 4` as a Bash tool call, then reply with the single word DONE.";
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
  content: string,
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
  /** (a): a sleep turn, a `later` prompt pushed at its tool call, then
   *  `interrupt()`; a default prompt pushed at the aborted result. */
  sleepA: UUID;
  later: UUID;
  afterA: UUID;
  /** (b): a sleep turn; at its tool call a default prompt, then a `now`
   *  prompt. */
  sleepB: UUID;
  before: UUID;
  now: UUID;
  /** (c): a sleep turn; at its tool call `/cost` with `now`. */
  sleepC: UUID;
  commandNow: UUID;
}

interface Capture {
  entries: SessionEntry[];
  stamped: Stamped;
  /** Lifecycle states per uuid, in stream order. */
  lifecycles: Map<UUID, CommandLifecycleMessage["state"][]>;
  receipts: (SDKControlInterruptResponse | undefined)[];
  /** `result` subtypes in stream order. */
  results: string[];
}

async function runSession(): Promise<Capture> {
  assertVersions();
  const configDir = makeConfigDir("interrupt-queue");
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const stamped: Stamped = {
    sleepA: randomUUID(),
    later: randomUUID(),
    afterA: randomUUID(),
    sleepB: randomUUID(),
    before: randomUUID(),
    now: randomUUID(),
    sleepC: randomUUID(),
    commandNow: randomUUID(),
  };
  const lifecycles = new Map<UUID, CommandLifecycleMessage["state"][]>();
  const receipts: (SDKControlInterruptResponse | undefined)[] = [];
  const results: string[] = [];
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
  /** True once every uuid has a terminal lifecycle state. */
  const allClosed = (uuids: UUID[]): boolean =>
    uuids.every((uuid) => {
      const last = lifecycles.get(uuid)?.at(-1);
      return last === "completed" || last === "cancelled";
    });
  const steps: {
    trigger: (message: SDKMessage) => boolean;
    run: () => void;
  }[] = [
    {
      trigger: hasToolUse,
      run: () =>
        channel.push(
          userMessage("Reply LAMBDA.", stamped.later, { priority: "later" }),
        ),
    },
    {
      // Interrupting in the push's own tick races the CLI's enqueue.
      trigger: () => lifecycles.get(stamped.later)?.includes("queued") ?? false,
      run: () => {
        void q.interrupt().then((receipt) => receipts.push(receipt));
      },
    },
    {
      trigger: (message) => message.type === "result",
      run: () => channel.push(userMessage("Reply MU.", stamped.afterA)),
    },
    {
      trigger: () => allClosed([stamped.later, stamped.afterA]),
      run: () => channel.push(userMessage(SLEEP_TURN, stamped.sleepB)),
    },
    {
      trigger: hasToolUse,
      run: () => {
        channel.push(userMessage("Reply NU.", stamped.before));
        channel.push(
          userMessage("Reply OMICRON.", stamped.now, { priority: "now" }),
        );
      },
    },
    {
      trigger: () => allClosed([stamped.before, stamped.now]),
      run: () => channel.push(userMessage(SLEEP_TURN, stamped.sleepC)),
    },
    {
      trigger: hasToolUse,
      run: () =>
        channel.push(
          userMessage("/cost", stamped.commandNow, { priority: "now" }),
        ),
    },
    {
      trigger: () => allClosed([stamped.commandNow]),
      run: () => channel.end(),
    },
  ];
  const events: SDKMessage[] = [];
  let sessionId: UUID | undefined;
  let inactivity = setTimeout(() => channel.end(), INACTIVITY_MS);
  channel.push(userMessage(SLEEP_TURN, stamped.sleepA));
  try {
    for await (const message of q) {
      clearTimeout(inactivity);
      inactivity = setTimeout(() => channel.end(), INACTIVITY_MS);
      events.push(message);
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id as UUID;
      }
      if (message.type === "result") {
        results.push(message.subtype);
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
  writeFileSync(
    join(configDir, "receipts.json"),
    JSON.stringify({ stamped, receipts, results }, null, 2),
  );
  copyFileSync(filePath, join(configDir, "session.jsonl"));
  return { entries, stamped, lifecycles, receipts, results };
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

test("a plain interrupt leaves queued prompts to run after the aborted result", async () => {
  const { entries, stamped, lifecycles, receipts } = await capture;
  console.log(
    `receipts: ${JSON.stringify(receipts)}; lifecycles: ${JSON.stringify([...lifecycles])}`,
  );
  assert.deepEqual(receipts[0]?.still_queued, [stamped.later]);
  assert.deepEqual(lifecycles.get(stamped.later)?.at(-1), "completed");
  assert.equal(userEntryText(entries, stamped.later), "Reply LAMBDA.");
  assert.ok(
    userEntryIndex(entries, stamped.sleepA) <
      userEntryIndex(entries, stamped.later) &&
      userEntryIndex(entries, stamped.later) <
        userEntryIndex(entries, stamped.afterA),
    "file order: sleep, surviving later prompt, prompt pushed at the result",
  );
});

test("a `now` prompt interrupts; a default prompt queued before it survives and runs after", async () => {
  const { entries, stamped, lifecycles } = await capture;
  assert.deepEqual(lifecycles.get(stamped.before)?.at(-1), "completed");
  assert.equal(userEntryText(entries, stamped.now), "Reply OMICRON.");
  assert.equal(userEntryText(entries, stamped.before), "Reply NU.");
  assert.equal(
    entries.some((entry) => queuedCommandSourceUuid(entry) === stamped.before),
    false,
    "the surviving prompt was steered",
  );
  assert.ok(
    userEntryIndex(entries, stamped.sleepB) <
      userEntryIndex(entries, stamped.now) &&
      userEntryIndex(entries, stamped.now) <
        userEntryIndex(entries, stamped.before),
    "file order: sleep, now, surviving default",
  );
});

test("a /command with `now` interrupts and runs expanded", async () => {
  const { entries, stamped, results } = await capture;
  console.log(`results: ${results.join(" ")}`);
  assert.match(
    userEntryText(entries, stamped.commandNow) ?? "",
    /<command-name>\/usage<\/command-name>/u,
  );
});
