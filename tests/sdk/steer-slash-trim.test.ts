// SDK expectation: the CLI tests for a slash command after trimming
// leading whitespace. A `shouldQuery: false` prompt pushed while a Bash
// ask is parked is steered at the tool's result handoff unless it is a
// command: ` /tmp/…` (leading space) is a command and never reaches the
// model's request; `\u200b/tmp/…` (zero-width space, which trim keeps) is
// steered. This is the trim queue-model.ts's isSlashCommand mirrors. The
// session file shows the command was delivered before the handoff, not late:
// its `enqueue` queue-operation precedes the tool_result entry. FREE:
// answering shim.

import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { sessionFilePath } from "../../src/core/session/file.ts";
import { startAnsweringShim, toolUseStream } from "./answering-shim.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const MARKER = "zebra";
/** A CLI that never ends the session would hang the test. */
const TIMEOUT_MS = 60_000;

interface PushedTextRun {
  /** The /v1/messages request bodies, serialized. */
  requests: string[];
  /** The session file's lines, parsed; queue-operation lines included. */
  fileLines: Record<string, unknown>[];
}

/** One session in which `text` is pushed (shouldQuery false) during the
 *  Bash ask, before the allow. */
async function runWithPushedText(
  caseName: string,
  text: string,
): Promise<PushedTextRun> {
  assertVersions();
  const shim = await startAnsweringShim((body) => {
    const messages = JSON.stringify((body as { messages?: unknown }).messages);
    if (messages.includes("tool_result")) return undefined;
    return toolUseStream(
      (body as { model?: string }).model ?? "unknown",
      "toolu_trim",
      "Bash",
      { command: "touch needs-permission", description: "touch" },
    );
  });
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const configDir = makeConfigDir(caseName, undefined, "never-expiring");
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: "touch a file" },
      parent_tool_use_id: null,
    };
    while (!ended || pending.length > 0) {
      const next = pending.shift();
      if (next !== undefined) yield next;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  const session = query({
    prompt: input(),
    options: {
      cwd,
      env: baseEnv(configDir, {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}`,
      }),
      canUseTool: async () => {
        pending.push({
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
          shouldQuery: false,
        });
        wake?.();
        return { behavior: "allow" };
      },
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    session.close();
  }, TIMEOUT_MS);
  let sessionId: UUID | undefined;
  try {
    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId ??= message.session_id as UUID;
      }
      if (message.type === "result") {
        // The pushed text is queued by now; ending the input lets the CLI
        // run whatever it still holds, then exit on its own.
        ended = true;
        wake?.();
      }
    }
  } finally {
    clearTimeout(timer);
    shim.close();
  }
  assert.equal(timedOut, false, "the session did not end on its own");
  assert.ok(sessionId, "no system/init");
  const requests = shim.requests
    .filter(
      (request) =>
        request.path.startsWith("/v1/messages") &&
        !request.path.includes("count_tokens"),
    )
    .map((request) => JSON.stringify(request.body));
  const fileLines = readFileSync(
    sessionFilePath(configDir, cwd, sessionId),
    "utf8",
  )
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { requests, fileLines };
}

/** File positions of the text's `enqueue`, the Bash tool_result entry, and
 *  a steer (`queued_command` attachment) of the text; -1 when absent. */
function filePositions(
  fileLines: Record<string, unknown>[],
  text: string,
): { enqueuedAt: number; toolResultAt: number; steeredAt: number } {
  return {
    enqueuedAt: fileLines.findIndex(
      (line) =>
        line.type === "queue-operation" &&
        line.operation === "enqueue" &&
        line.content === text,
    ),
    toolResultAt: fileLines.findIndex(
      (line) =>
        line.type === "user" &&
        JSON.stringify(line.message).includes('"tool_use_id":"toolu_trim"'),
    ),
    steeredAt: fileLines.findIndex(
      (line) =>
        line.type === "attachment" &&
        JSON.stringify(line.attachment).includes('"type":"queued_command"') &&
        JSON.stringify(line.attachment).includes(MARKER),
    ),
  };
}

test("a leading space still makes a command: delivered before the handoff, the text reaches no request", async () => {
  const text = ` /tmp/${MARKER} is the destination`;
  const { requests, fileLines } = await runWithPushedText(
    "slash-trim-space",
    text,
  );
  const { enqueuedAt, toolResultAt, steeredAt } = filePositions(
    fileLines,
    text,
  );
  assert.ok(toolResultAt >= 0, "no tool_result entry");
  assert.ok(
    enqueuedAt >= 0 && enqueuedAt < toolResultAt,
    "not enqueued before the tool's result",
  );
  assert.equal(steeredAt, -1, "steered");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((body) => !body.includes(MARKER)));
});

test("a leading zero-width space is not trimmed: the text is steered after the tool_result", async () => {
  const text = `\u200b/tmp/${MARKER} is the destination`;
  const { requests, fileLines } = await runWithPushedText(
    "slash-trim-zwsp",
    text,
  );
  assert.ok(filePositions(fileLines, text).steeredAt >= 0, "not steered");
  assert.equal(requests.length, 2);
  const second = requests[1] ?? "";
  assert.ok(second.includes(MARKER));
  const resultAt = second.indexOf('"tool_use_id":"toolu_trim"');
  assert.ok(resultAt >= 0, "no tool_result");
  assert.ok(resultAt < second.indexOf(MARKER));
});
