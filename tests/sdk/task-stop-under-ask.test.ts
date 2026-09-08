// SDK expectation the agent-state fold relies on: when a background
// subagent is stopped while its permission ask pends, the CLI aborts the
// ask's `signal` BEFORE it emits the task's terminal events (`task_updated`
// killed / `task_notification`). The permission broker cancels the ask on
// abort, so a removed task never leaves an ask behind
// (docs/specs/permission-prompt.md, "Stopping a task under a pending ask").
// Two stop paths: `interrupt()` with the main loop idle, and the main agent's
// own TaskStop. Observed first with SDK 0.3.280 / claude 2.1.280
// (docs/derisk/permission-prompt/FINDINGS.md).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Query,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const VICTIM_DIR = "/tmp/clauctl-sdktest-task-stop-victim";
const QUIET_AFTER_STOP_MS = 15_000;

type Observation =
  | { what: "ask"; agentId: string | undefined }
  | { what: "askAborted" }
  | { what: "taskKilled"; taskId: string }
  | { what: "taskNotification"; taskId: string };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const userMessage = (content: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
  session_id: "",
});

/**
 * Launch a background subagent whose Bash call must ask, hold the ask
 * unanswered, run `stop` once it pends and the main loop is idle (the
 * launching turn's `result` may land before or after the ask), and return
 * everything observed in arrival order.
 */
async function observeStop(
  caseName: string,
  stop: (q: Query, push: (prompt: string) => void) => void,
): Promise<Observation[]> {
  assertVersions();
  mkdirSync(VICTIM_DIR, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const observed: Observation[] = [];
  const askPending = deferred<void>();
  const mainIdle = deferred<void>();
  const inputClosed = deferred<void>();
  const pushed = deferred<string | undefined>();
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(
      `Use the Agent tool with run_in_background set to true to launch a subagent whose only job is to run \`rm -rf ${VICTIM_DIR}\` with the Bash tool. Do not wait for it; reply "launched" immediately and end your turn.`,
    );
    await Promise.all([askPending.promise, mainIdle.promise]);
    stop(q, pushed.resolve);
    const next = await Promise.race([pushed.promise, inputClosed.promise]);
    if (next !== undefined) yield userMessage(next);
    await inputClosed.promise;
  }
  const q = query({
    prompt: prompt(),
    options: {
      env: baseEnv(makeConfigDir(`task-stop-${caseName}`)),
      cwd,
      model: HAIKU,
      maxTurns: 4,
      canUseTool: (_toolName, _input, options) => {
        observed.push({ what: "ask", agentId: options.agentID });
        options.signal.addEventListener("abort", () => {
          observed.push({ what: "askAborted" });
          setTimeout(() => inputClosed.resolve(), QUIET_AFTER_STOP_MS);
        });
        askPending.resolve();
        // Never answered by the host: the stop must settle it.
        return new Promise(() => {});
      },
    },
  });
  try {
    for await (const message of q) {
      if (message.type === "result") mainIdle.resolve();
      if (message.type === "system" && message.subtype === "task_updated") {
        if (message.patch.status === "killed") {
          observed.push({ what: "taskKilled", taskId: message.task_id });
        }
      }
      if (
        message.type === "system" &&
        message.subtype === "task_notification"
      ) {
        observed.push({ what: "taskNotification", taskId: message.task_id });
      }
    }
  } catch (error) {
    // Closing input after an interrupt ends the session with an error
    // result and exit 1, which the SDK surfaces by erroring the stream
    // once every message has been delivered (the observations are
    // complete by then).
    if ((error as { errorClass?: string }).errorClass !== "error_result") {
      throw error;
    }
  } finally {
    q.close();
    rmSync(cwd, { recursive: true, force: true });
  }
  return observed;
}

function assertAbortPrecedesRemoval(observed: Observation[]): void {
  const kinds = observed.map((o) => o.what);
  const ask = observed.find((o) => o.what === "ask");
  assert.ok(
    ask?.what === "ask" && ask.agentId !== undefined,
    "the ask is a subagent's",
  );
  const aborted = kinds.indexOf("askAborted");
  const killed = kinds.indexOf("taskKilled");
  const notified = kinds.indexOf("taskNotification");
  assert.ok(aborted !== -1, `the ask was aborted: ${kinds.join(" ")}`);
  assert.ok(
    killed !== -1 && aborted < killed,
    `abort before task_updated killed: ${kinds.join(" ")}`,
  );
  assert.ok(
    notified !== -1 && aborted < notified,
    `abort before task_notification: ${kinds.join(" ")}`,
  );
}

test("interrupt() with the main loop idle aborts the task's ask before removing the task", async () => {
  const observed = await observeStop("interrupt", (q) => {
    void q.interrupt();
  });
  assertAbortPrecedesRemoval(observed);
});

test("TaskStop aborts the task's ask before removing the task", async () => {
  const observed = await observeStop("taskstop", (_q, push) =>
    push(
      'Stop the background subagent you launched (use the TaskStop tool on its task id), then reply "stopped".',
    ),
  );
  assertAbortPrecedesRemoval(observed);
});
