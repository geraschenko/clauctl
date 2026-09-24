// SDK expectation: the two `<synthetic>` assistant rows of the classification
// table (docs/stream-merging.md). (a) A resumed CLI closes a turn the file
// left open by an interrupt with an assistant entry — model `<synthetic>`,
// "No response requested." — that it persists with the next prompt and never
// emits to the SDK consumer: session-only. (b) An API-error synthetic
// (`isApiErrorMessage: true`) is emitted on the query stream with the uuid the
// file records: shared. `excludedFromQuery` must agree with both. LIVE: two
// short haiku sessions plus one failing query, ~4 calls.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type SDKMessage,
  type SDKUserMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { excludedFromQuery } from "../../src/core/agent-state/index.ts";
import {
  readSessionEntries,
  type SessionEntry,
  sessionFilePath,
} from "../../src/core/session/file.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
}

/** Streaming input that yields the given message and then stays open
 *  until `end`, so the CLI keeps the session alive for an interrupt. */
function openInput(first: SDKUserMessage): {
  input: AsyncIterable<SDKUserMessage>;
  end: () => void;
} {
  let end!: () => void;
  const closed = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    end,
    input: (async function* () {
      yield first;
      await closed;
    })(),
  };
}

function isSyntheticAssistant(entry: SessionEntry): boolean {
  return (
    entry.type === "assistant" &&
    (entry.message as { model?: unknown }).model === "<synthetic>"
  );
}

test("resume turn closer: session-only; API-error synthetic: shared", async () => {
  assertVersions();
  const configDir = makeConfigDir("synthetic-assistant");
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const sessionId = randomUUID();
  const options = {
    env: baseEnv(configDir),
    cwd,
    model: HAIKU,
    permissionMode: "auto" as const,
  };
  try {
    // Turn 1: interrupt mid-generation, so the file ends in
    // "[Request interrupted by user]" with no assistant reply.
    const first = openInput(
      userMessage("Count slowly from 1 to 200, one number per line."),
    );
    const q1 = query({
      prompt: first.input,
      options: { ...options, sessionId, includePartialMessages: true },
    });
    for await (const message of q1) {
      if (message.type === "stream_event") {
        await q1.interrupt();
        first.end();
      }
      if (message.type === "result") break;
    }
    q1.close();

    // Turn 2: resume and prompt. The CLI writes the closer with this prompt.
    const resumed: SDKMessage[] = [];
    const q2 = query({
      prompt: "Reply with exactly the word pong.",
      options: { ...options, resume: sessionId },
    });
    for await (const message of q2) resumed.push(message);
    q2.close();

    const entries = readSessionEntries(
      sessionFilePath(configDir, cwd, sessionId),
    );
    const closers = entries.filter(isSyntheticAssistant);
    assert.equal(closers.length, 1, "expected one resume turn closer");
    const closer = closers[0]!;
    assert.notEqual(closer.isApiErrorMessage, true);
    assert.ok(
      !resumed.some((message) => message.uuid === closer.uuid),
      "the query stream must not carry the closer",
    );
    assert.equal(excludedFromQuery(closer), true);

    // A query against a model that does not exist yields an API-error
    // synthetic on the stream, and the file records it under the same uuid.
    const failedSessionId = randomUUID();
    const failed: SDKMessage[] = [];
    const q3 = query({
      prompt: "hi",
      options: {
        ...options,
        model: "no-such-model",
        sessionId: failedSessionId,
      },
    });
    for await (const message of q3) failed.push(message);
    q3.close();
    const failedEntries = readSessionEntries(
      sessionFilePath(configDir, cwd, failedSessionId),
    );
    const apiErrors = failedEntries.filter(
      (entry) =>
        isSyntheticAssistant(entry) && entry.isApiErrorMessage === true,
    );
    assert.equal(apiErrors.length, 1, "expected one API-error synthetic");
    const apiError = apiErrors[0]!;
    assert.ok(
      failed.some((message) => message.uuid === apiError.uuid),
      "the query stream must carry the API-error synthetic",
    );
    assert.equal(excludedFromQuery(apiError), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
