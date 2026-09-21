// SDK expectation: `Options.sessionId` makes the CLI use the caller's id
// for a fresh session (sdk.d.ts: "Must be a valid UUID. Cannot be used
// with `continue` or `resume` unless `forkSession` is also set"), so the
// daemon knows its query session id before the first turn and can route
// query-side events to it from spawn. The session file does not exist
// while the process idles before its first prompt: it appears with the
// first turn (docs/claude-agent-sdk.md, "The session id is chosen by the
// caller"). LIVE: one haiku session, ~1 call.

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
import { sessionFilePath } from "../../src/core/session/file.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";

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

interface Capture {
  seededSessionId: UUID;
  initSessionId: UUID | undefined;
  /** The session file's existence once the CLI answered a control request
   *  (up, no prompt yet), at its first `system/init`, and at its `result`. */
  fileExists: { beforePrompt: boolean; atInit: boolean; atResult: boolean };
  slashCommands: readonly string[];
}

async function runSession(): Promise<Capture> {
  assertVersions();
  const configDir = makeConfigDir("session-id-option");
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const seededSessionId = randomUUID();
  const filePath = sessionFilePath(configDir, cwd, seededSessionId);
  const channel = inputChannel();
  const q = query({
    prompt: channel.input,
    options: {
      env: baseEnv(configDir),
      cwd,
      model: HAIKU,
      sessionId: seededSessionId,
      permissionMode: "dontAsk",
    },
  });
  // A control round trip proves the CLI is up without sending a prompt.
  await q.supportedCommands();
  const fileExists = {
    beforePrompt: existsSync(filePath),
    atInit: false,
    atResult: false,
  };
  let initSessionId: UUID | undefined;
  let slashCommands: readonly string[] = [];
  const events: SDKMessage[] = [];
  channel.push({
    type: "user",
    uuid: randomUUID(),
    message: { role: "user", content: "Reply with the single word PONG." },
    parent_tool_use_id: null,
  });
  try {
    for await (const message of q) {
      events.push(message);
      if (message.type === "system" && message.subtype === "init") {
        initSessionId = message.session_id as UUID;
        slashCommands = message.slash_commands;
        fileExists.atInit = existsSync(filePath);
      }
      if (message.type === "result") {
        fileExists.atResult = existsSync(filePath);
        channel.end();
      }
    }
  } finally {
    q.close();
  }
  rmSync(cwd, { recursive: true, force: true });
  writeFileSync(
    join(configDir, "query-events.jsonl"),
    events.map((message) => JSON.stringify(message)).join("\n") + "\n",
  );
  return { seededSessionId, initSessionId, fileExists, slashCommands };
}

const capture = runSession();

test("the CLI announces the seeded session id on system/init", async () => {
  const { seededSessionId, initSessionId } = await capture;
  assert.equal(initSessionId, seededSessionId);
});

test("the session file appears with the first turn, not at spawn", async () => {
  const { fileExists } = await capture;
  console.log(`file existence: ${JSON.stringify(fileExists)}`);
  assert.equal(fileExists.beforePrompt, false);
  assert.equal(fileExists.atResult, true);
});

// The list is not a command predicate: `/cost` is a command the CLI runs,
// yet "cost" is absent here (steer-slash-command.test.ts pins the `^/`
// string test instead).
test("system/init advertises built-in commands by name without the slash", async () => {
  const { slashCommands } = await capture;
  console.log(`slash_commands: ${slashCommands.join(" ")}`);
  assert.ok(slashCommands.includes("compact"));
  assert.ok(slashCommands.every((name) => !name.startsWith("/")));
});
