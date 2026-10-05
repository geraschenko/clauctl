// SDK stream facts that `isInputNeeded` and the unresolved-tool-use fold
// rely on (docs/specs/permission-cli.md, "SDK tests"). Each case drives one
// session (haiku unless noted) through the SDK, records every message and
// permission ask in arrival order, and asserts an ordering. The case
// numbers match the spec's list.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type PermissionResult,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "sonnet";
const VICTIM_DIR = "/tmp/clauctl-sdktest-input-needed-victim";
const CASE_TIMEOUT_MS = 150_000;

type Observation =
  | { kind: "message"; message: SDKMessage }
  | { kind: "ask"; toolName: string; toolUseId: string; agentId?: string }
  | { kind: "answered"; toolUseId: string };

interface Controls {
  push(prompt: string): void;
  interrupt(): void;
  stopTask(taskId: string): void;
  close(): void;
}

interface Case {
  prompt: string;
  /** Defaults to haiku. */
  model?: string;
  /** Answers an ask; asks it doesn't hold resolve as soon as it returns. */
  answer(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult>;
  /** Sees each message after it is recorded; ends the case via `close`. */
  onMessage(
    message: SDKMessage,
    controls: Controls,
    observed: readonly Observation[],
  ): void;
}

const userMessage = (content: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
  session_id: "",
});

const allow = async (
  _toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> => ({ behavior: "allow", updatedInput: input });

const deny: PermissionResult = {
  behavior: "deny",
  message: "sdk test: denied",
};

async function observe(caseName: string, spec: Case): Promise<Observation[]> {
  assertVersions();
  mkdirSync(VICTIM_DIR, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  writeFileSync(join(cwd, "notes.txt"), "hello from notes\n");
  const observed: Observation[] = [];
  const pushed: string[] = [];
  let wake = (): void => {};
  let closed = false;
  const controls: Controls = {
    push: (prompt) => {
      pushed.push(prompt);
      wake();
    },
    interrupt: () => void q.interrupt(),
    stopTask: (taskId) => void q.stopTask(taskId),
    close: () => {
      closed = true;
      wake();
    },
  };
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(spec.prompt.replaceAll("$CWD", cwd));
    while (!closed) {
      const next = pushed.shift();
      if (next !== undefined) {
        yield userMessage(next);
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const hardStop = setTimeout(controls.close, CASE_TIMEOUT_MS);
  const q = query({
    prompt: prompt(),
    options: {
      env: baseEnv(makeConfigDir(`input-needed-${caseName}`)),
      cwd,
      model: spec.model ?? HAIKU,
      maxTurns: 6,
      canUseTool: async (toolName, input, options) => {
        observed.push({
          kind: "ask",
          toolName,
          toolUseId: options.toolUseID,
          ...(options.agentID !== undefined && { agentId: options.agentID }),
        });
        const result = await spec.answer(toolName, input);
        observed.push({ kind: "answered", toolUseId: options.toolUseID });
        return result;
      },
    },
  });
  try {
    for await (const message of q) {
      observed.push({ kind: "message", message });
      spec.onMessage(message, controls, observed);
    }
  } catch (error) {
    // An interrupted session closed mid-turn ends with an error result,
    // surfaced by erroring the stream after every message is delivered.
    if ((error as { errorClass?: string }).errorClass !== "error_result") {
      throw error;
    }
  } finally {
    clearTimeout(hardStop);
    q.close();
    rmSync(cwd, { recursive: true, force: true });
  }
  return observed;
}

interface ToolUse {
  id: string;
  name: string;
  parent: string | null;
}

const messages = (observed: readonly Observation[]): SDKMessage[] =>
  observed.flatMap((o) => (o.kind === "message" ? [o.message] : []));

const toolUses = (observed: readonly Observation[]): ToolUse[] =>
  messages(observed).flatMap((m) =>
    m.type === "assistant"
      ? m.message.content.flatMap((block) =>
          block.type === "tool_use"
            ? [{ id: block.id, name: block.name, parent: m.parent_tool_use_id }]
            : [],
        )
      : [],
  );

const hasToolResult = (message: SDKMessage, toolUseId: string): boolean =>
  message.type === "user" &&
  Array.isArray(message.message.content) &&
  message.message.content.some(
    (block) => block.type === "tool_result" && block.tool_use_id === toolUseId,
  );

/** Index of the first observation matching `match`; -1 if none. */
const indexOf = (
  observed: readonly Observation[],
  match: (o: Observation) => boolean,
): number => observed.findIndex(match);

const isMessage =
  (match: (m: SDKMessage) => boolean) =>
  (o: Observation): boolean =>
    o.kind === "message" && match(o.message);

const isTopLevelResult = (m: SDKMessage): boolean => m.type === "result";

const taskStarts = (observed: readonly Observation[]) =>
  messages(observed).flatMap((m) =>
    m.type === "system" && m.subtype === "task_started" ? [m] : [],
  );

/** Index of each task's first terminal status (`task_updated` or
 *  `task_notification`). */
const taskEnds = (observed: readonly Observation[]): Map<string, number> => {
  const ends = new Map<string, number>();
  observed.forEach((o, index) => {
    if (o.kind !== "message" || o.message.type !== "system") return;
    const m = o.message;
    const ended =
      (m.subtype === "task_updated" &&
        (m.patch.status === "completed" ||
          m.patch.status === "failed" ||
          m.patch.status === "killed")) ||
      m.subtype === "task_notification";
    if (ended && !ends.has(m.task_id)) ends.set(m.task_id, index);
  });
  return ends;
};

const timeline = (observed: readonly Observation[]): string =>
  observed
    .map((o) =>
      o.kind === "message"
        ? "subtype" in o.message
          ? `${o.message.type}/${o.message.subtype}`
          : o.message.type
        : `${o.kind}:${o.toolUseId}`,
    )
    .join(" ");

test("1. a foreground subagent's task_started is not backgrounded and names the Agent call; its ask carries agentID", async () => {
  const observed = await observe("fg-subagent", {
    prompt: `Use the Agent tool (foreground, do NOT set run_in_background) to launch a subagent whose only job is to run \`rm -rf ${VICTIM_DIR}\` with the Bash tool. Wait for it, then reply "done".`,
    answer: async (toolName, input) =>
      toolName === "Bash" ? deny : allow(toolName, input),
    onMessage: (message, controls) => {
      if (isTopLevelResult(message)) controls.close();
    },
  });
  const agentCall = toolUses(observed).find(
    (use) => use.name === "Agent" && use.parent === null,
  );
  assert.ok(agentCall, timeline(observed));
  const started = taskStarts(observed).find(
    (m) => m.tool_use_id === agentCall.id,
  );
  assert.ok(
    started,
    `no task_started for the Agent call: ${timeline(observed)}`,
  );
  assert.equal(started.is_backgrounded, false);
  const ask = observed.find((o) => o.kind === "ask" && o.toolName === "Bash");
  assert.ok(ask?.kind === "ask", timeline(observed));
  assert.equal(ask.agentId, started.task_id);
});

test("2. a sibling issued after an asking tool gets its tool_result only after the ask resolves", async () => {
  let releaseBash = (): void => {};
  const readIssued = new Promise<void>((resolve) => {
    releaseBash = resolve;
  });
  const observed = await observe("sibling-after-ask", {
    prompt: `In a single message, call these two tools in parallel, in this order: first Bash with \`rm -rf ${VICTIM_DIR}\`, then Read on $CWD/notes.txt. Then reply "done".`,
    answer: async (toolName, input) => {
      if (toolName !== "Bash") return allow(toolName, input);
      await readIssued;
      return deny;
    },
    onMessage: (message, controls, observed) => {
      // Hold the ask until the Read has been issued, so its result could
      // arrive while the ask pends if the CLI allowed it.
      const issued = toolUses(observed).map((use) => use.name);
      if (issued.includes("Bash") && issued.includes("Read")) releaseBash();
      if (isTopLevelResult(message)) controls.close();
    },
  });
  const uses = toolUses(observed);
  const bash = uses.find((use) => use.name === "Bash");
  const read = uses.find((use) => use.name === "Read");
  assert.ok(bash && read, timeline(observed));
  assert.ok(
    uses.indexOf(bash) < uses.indexOf(read),
    `precondition: haiku issued Read before Bash; rerun (${timeline(observed)})`,
  );
  const answered = indexOf(
    observed,
    (o) => o.kind === "answered" && o.toolUseId === bash.id,
  );
  const readResult = indexOf(
    observed,
    isMessage((m) => hasToolResult(m, read.id)),
  );
  assert.ok(answered !== -1 && readResult !== -1, timeline(observed));
  assert.ok(answered < readResult, timeline(observed));
});

test("3. a background subagent outlives the top-level result; a notification turn (init … result) follows", async () => {
  const observed = await observe("bg-outlives-result", {
    prompt: `Use the Agent tool with run_in_background set to true to launch a subagent whose only job is to write a 300-word story about a lighthouse, using no tools. Do not wait for it; reply "launched" immediately and end your turn.`,
    answer: allow,
    onMessage: (_message, controls, observed) => {
      const notified = indexOf(
        observed,
        isMessage(
          (m) => m.type === "system" && m.subtype === "task_notification",
        ),
      );
      const lastResult = observed.findLastIndex(isMessage(isTopLevelResult));
      if (notified !== -1 && lastResult > notified) controls.close();
    },
  });
  const firstResult = indexOf(observed, isMessage(isTopLevelResult));
  const notified = indexOf(
    observed,
    isMessage((m) => m.type === "system" && m.subtype === "task_notification"),
  );
  assert.ok(firstResult !== -1 && notified > firstResult, timeline(observed));
  const after = observed.slice(notified);
  const init = indexOf(
    after,
    isMessage((m) => m.type === "system" && m.subtype === "init"),
  );
  const result = indexOf(after, isMessage(isTopLevelResult));
  assert.ok(init !== -1 && result > init, timeline(observed));
});

test("4. SendMessage to a finished subagent re-emits task_started with the same task_id; the resumed subagent's frames name the first Agent call", async () => {
  let pushed = false;
  const observed = await observe("sendmessage-resume", {
    prompt: `Use the Agent tool (foreground, do NOT set run_in_background) to launch a subagent whose only job is to reply with the word "ready", using no tools. Wait for it, then reply "done".`,
    answer: allow,
    onMessage: (message, controls) => {
      if (!isTopLevelResult(message)) return;
      if (!pushed) {
        pushed = true;
        controls.push(
          `Use the SendMessage tool to send the subagent you launched the message "use the Read tool to read notes.txt, then reply with its contents". Then reply "sent".`,
        );
      } else {
        controls.close();
      }
    },
  });
  const [first, second] = taskStarts(observed);
  assert.ok(first && second, timeline(observed));
  assert.equal(second.task_id, first.task_id);
  const sendMessage = toolUses(observed).find(
    (use) => use.name === "SendMessage",
  );
  assert.equal(second.tool_use_id, sendMessage?.id);
  const read = toolUses(observed).find((use) => use.name === "Read");
  assert.ok(read, timeline(observed));
  assert.equal(read.parent, first.tool_use_id);
  // SendMessage resolves at once: the main agent does not wait on the
  // resumed subagent.
  const sendMessageResult = indexOf(
    observed,
    isMessage((m) => hasToolResult(m, sendMessage!.id)),
  );
  const readResult = indexOf(
    observed,
    isMessage((m) => hasToolResult(m, read.id)),
  );
  assert.ok(
    sendMessageResult !== -1 && sendMessageResult < readResult,
    timeline(observed),
  );
});

test("7. a subagent can launch its own subagent: the nested Agent call is the outer subagent's tool use and the nested task's tool_use_id", async () => {
  const observed = await observe("nested-subagent", {
    prompt: `Use the Agent tool (foreground) to launch a subagent with these exact instructions: "Use the Agent tool to launch your own subagent whose only job is to reply with the word nested, using no tools." Wait for it, then reply with what it said.`,
    answer: allow,
    onMessage: (message, controls) => {
      if (isTopLevelResult(message)) controls.close();
    },
  });
  const [outer, nested] = toolUses(observed).filter(
    (use) => use.name === "Agent",
  );
  assert.ok(outer && nested, timeline(observed));
  assert.equal(outer.parent, null);
  assert.equal(nested.parent, outer.id);
  assert.deepEqual(
    // haiku sometimes nests further; the first two levels are the fact.
    taskStarts(observed)
      .slice(0, 2)
      .map((m) => m.tool_use_id),
    [outer.id, nested.id],
  );
});

test("8a. a background nested subagent outlives its parent task, which ends first", async () => {
  const observed = await observe("nested-background", {
    prompt: `Use the Agent tool (foreground) to launch a subagent with these exact instructions: "Use the Agent tool with run_in_background set to true to launch a subagent whose only job is to run \`sleep 20\` with the Bash tool and then reply done. Do not wait for it: reply launched immediately." Then reply "ok".`,
    // Haiku frequently does not follow the instructions.
    model: SONNET,
    answer: allow,
    onMessage: (_message, controls, observed) => {
      const [, nested] = taskStarts(observed);
      if (nested && taskEnds(observed).has(nested.task_id)) controls.close();
    },
  });
  const [outer, nested] = taskStarts(observed);
  assert.ok(outer && nested, timeline(observed));
  const ends = taskEnds(observed);
  const outerEnd = ends.get(outer.task_id);
  const nestedEnd = ends.get(nested.task_id);
  // Only a prompt-following run tests the fact: the outer subagent ran in
  // the foreground (the main turn outlives it) and the nested one ran Bash.
  const mainResult = indexOf(observed, isMessage(isTopLevelResult));
  const nestedRanBash = toolUses(observed).some(
    (use) => use.name === "Bash" && use.parent === nested.tool_use_id,
  );
  assert.ok(
    outerEnd !== undefined && outerEnd < mainResult && nestedRanBash,
    `model did not follow the prompt: ${timeline(observed)}`,
  );
  assert.ok(
    outerEnd !== undefined && nestedEnd !== undefined && outerEnd < nestedEnd,
    timeline(observed),
  );
});

test("8b. stopping a task ends its nested task", async () => {
  let stopped = false;
  const observed = await observe("nested-stop", {
    prompt: `Use the Agent tool (foreground) to launch a subagent with these exact instructions: "Use the Agent tool (foreground) to launch a subagent whose only job is to run \`sleep 30\` with the Bash tool." Then reply "ok".`,
    answer: allow,
    onMessage: (message, controls, observed) => {
      const [outer, nested] = taskStarts(observed);
      if (!stopped && outer && nested) {
        stopped = true;
        controls.stopTask(outer.task_id);
      }
      if (isTopLevelResult(message)) controls.close();
    },
  });
  const [outer, nested] = taskStarts(observed);
  assert.ok(outer && nested, timeline(observed));
  const ends = taskEnds(observed);
  assert.ok(ends.has(outer.task_id), timeline(observed));
  assert.ok(ends.has(nested.task_id), timeline(observed));
});

/** Every tool use the session issued has a tool_result. */
function assertAllResolved(observed: readonly Observation[]): void {
  for (const use of toolUses(observed)) {
    assert.ok(
      messages(observed).some((m) => hasToolResult(m, use.id)),
      `${use.name} ${use.id} unresolved: ${timeline(observed)}`,
    );
  }
}

test("5a. an interrupt while a tool runs yields its tool_result", async () => {
  let interrupted = false;
  const observed = await observe("interrupt-running", {
    prompt: `Run \`sleep 60\` with the Bash tool (foreground, do NOT set run_in_background), then reply "done".`,
    answer: allow,
    onMessage: (message, controls) => {
      if (!interrupted && message.type === "tool_progress") {
        interrupted = true;
        controls.interrupt();
      }
      if (interrupted && isTopLevelResult(message)) controls.close();
    },
  });
  assert.ok(interrupted, `no tool_progress: ${timeline(observed)}`);
  assertAllResolved(observed);
});

test("5b. an interrupt while an ask pends yields its tool_result", async () => {
  let interrupted = false;
  const observed = await observe("interrupt-asking", {
    prompt: `Run \`rm -rf ${VICTIM_DIR}\` with the Bash tool, then reply "done".`,
    // Never answered by the host: the interrupt must settle it.
    answer: () => new Promise(() => {}),
    onMessage: (message, controls, observed) => {
      if (!interrupted && observed.some((o) => o.kind === "ask")) {
        interrupted = true;
        controls.interrupt();
      }
      if (interrupted && isTopLevelResult(message)) controls.close();
    },
  });
  assert.ok(interrupted, timeline(observed));
  assertAllResolved(observed);
});

test("6. a background Bash yields task_started and its tool_result before the task ends", async () => {
  const observed = await observe("bg-bash", {
    prompt: `Run \`sleep 5\` with the Bash tool with run_in_background set to true. Do not wait for it; reply "started" immediately and end your turn.`,
    answer: allow,
    onMessage: (message, controls) => {
      if (
        message.type === "system" &&
        message.subtype === "task_notification"
      ) {
        controls.close();
      }
    },
  });
  const bash = toolUses(observed).find((use) => use.name === "Bash");
  assert.ok(bash, timeline(observed));
  const started = indexOf(
    observed,
    isMessage(
      (m) =>
        m.type === "system" &&
        m.subtype === "task_started" &&
        m.tool_use_id === bash.id,
    ),
  );
  const result = indexOf(
    observed,
    isMessage((m) => hasToolResult(m, bash.id)),
  );
  const notified = indexOf(
    observed,
    isMessage((m) => m.type === "system" && m.subtype === "task_notification"),
  );
  assert.ok(started !== -1, timeline(observed));
  assert.ok(
    result !== -1 && notified !== -1 && result < notified,
    timeline(observed),
  );
});
