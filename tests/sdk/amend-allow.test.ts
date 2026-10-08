// SDK expectations behind allow feedback (docs/specs/permission-amend-allow.md),
// with PermissionBroker's feedbackHooks registered as the daemon registers
// them: the context a PostToolUse/PostToolUseFailure callback hook returns
// lands after the tool_result in the next request of the agent that ran the
// tool, subagents included — folded into the tool_result's content, or for a
// mid-conversation-system model in the trailing system message, as for any
// attachment after a tool_result (tests/sdk/api-context.test.ts); it starts
// no turn of its own; the main session
// file records it as a `hook_additional_context` attachment; `disableAllHooks`
// does not suppress callback hooks; callback hooks emit no stream hook
// events; an interrupt while the tool runs fires neither hook. FREE:
// answering shim.

import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync } from "node:fs";
import { watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type HookCallbackMatcher,
  type HookEvent,
  type McpServerConfig,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  PermissionBroker,
  permissionRequestOf,
} from "../../src/core/protocol-server/index.ts";
import {
  hookAdditionalContext,
  readSessionEntries,
  type SessionEntry,
  sessionFilePath,
} from "../../src/core/session/file.ts";
import { startAnsweringShim, toolUseStream } from "./answering-shim.ts";
import { assertVersions, baseEnv, makeConfigDir, REPO_DIR } from "./harness.ts";

const FEEDBACK = "zebra feedback";
const START_PROMPT = "start the test";
const SUBTASK_PROMPT = "SUBTASK: touch a file";
const HAIKU = "claude-haiku-4-5-20251001";
/** A model the CLI turns mid-conversation system on for (docs/specs/api-messages.md, vocabulary). */
const GATED_MODEL = "claude-fable-5-1";
const MAIN_TOOL_USE_ID = "toolu_main";
const SUB_TOOL_USE_ID = "toolu_sub";
/** A CLI that never ends the session would hang the test. */
const TIMEOUT_MS = 60_000;

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface Scenario {
  caseName: string;
  /** The main agent's reply to the start prompt. */
  mainCall: (cwd: string) => ToolCall;
  /** The subagent's reply to its prompt, when mainCall launches one. */
  subagentCall?: ToolCall;
  settings?: Record<string, unknown>;
  mcpServers?: Record<string, McpServerConfig>;
  /** Interrupt once the allowed command has touched `started`. */
  interruptWhenStarted?: boolean;
  /** Create the fifo `release` in cwd, and write it when the first request
   *  carrying a tool_result arrives. */
  releaseOnResult?: boolean;
  /** Default GATED_MODEL. */
  model?: string;
}

interface ApiRequest {
  messages: unknown[];
  /** `messages` serialized, for presence checks. */
  serialized: string;
  isSubagent: boolean;
}

interface FeedbackRun {
  requests: ApiRequest[];
  /** `<hook event> <tool_use_id>` per feedback hook call. */
  hookCalls: string[];
  hookEventFrames: number;
  entries: SessionEntry[];
}

/** `hooks` with every callback also recording its call into `calls`. */
function recordingHooks(
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
  calls: string[],
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const recorded: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const [event, matchers] of Object.entries(hooks) as [
    HookEvent,
    HookCallbackMatcher[],
  ][]) {
    recorded[event] = matchers.map((matcher) => ({
      ...matcher,
      hooks: matcher.hooks.map((hook) => (input, toolUseId, options) => {
        calls.push(
          `${input.hook_event_name} ${"tool_use_id" in input ? input.tool_use_id : "-"}`,
        );
        return hook(input, toolUseId, options);
      }),
    }));
  }
  return recorded;
}

/** One session: every ask is allowed with FEEDBACK through a PermissionBroker. */
async function runWithFeedback(scenario: Scenario): Promise<FeedbackRun> {
  assertVersions();
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  const releasePath = join(cwd, "release");
  if (scenario.releaseOnResult) execFileSync("mkfifo", [releasePath]);
  let releaseWrite: Promise<void> | undefined;
  const shim = await startAnsweringShim((body) => {
    const messages = JSON.stringify((body as { messages?: unknown }).messages);
    const model = (body as { model?: string }).model ?? "unknown";
    if (messages.includes("tool_result")) {
      // Once, and asynchronously: opening a fifo blocks until a reader
      // opens it, and only the command reads it.
      if (scenario.releaseOnResult) {
        releaseWrite ??= writeFile(releasePath, "go\n");
      }
      return undefined;
    }
    const call =
      scenario.subagentCall !== undefined && messages.includes(SUBTASK_PROMPT)
        ? scenario.subagentCall
        : messages.includes(START_PROMPT)
          ? scenario.mainCall(cwd)
          : undefined;
    if (call === undefined) return undefined;
    const toolUseId =
      call === scenario.subagentCall ? SUB_TOOL_USE_ID : MAIN_TOOL_USE_ID;
    return toolUseStream(model, toolUseId, call.name, call.input);
  });
  const configDir = makeConfigDir(
    `amend-allow-${scenario.caseName}`,
    scenario.settings,
    "never-expiring",
  );
  const permissionBroker = new PermissionBroker({ emit: () => {} });
  const hookCalls: string[] = [];
  const watcher = new AbortController();
  let interruptSent = false;
  let interruptTask: Promise<void> | undefined;
  let endInput!: () => void;
  const inputEnded = new Promise<void>((resolve) => (endInput = resolve));
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: START_PROMPT },
      parent_tool_use_id: null,
    };
    await inputEnded;
  }
  const session = query({
    prompt: input(),
    options: {
      cwd,
      env: baseEnv(configDir, {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}`,
      }),
      model: scenario.model ?? GATED_MODEL,
      includeHookEvents: true,
      ...(scenario.mcpServers !== undefined && {
        mcpServers: scenario.mcpServers,
      }),
      hooks: recordingHooks(permissionBroker.feedbackHooks, hookCalls),
      canUseTool: (toolName, toolInput, options) => {
        const decided = permissionBroker.request(
          permissionRequestOf(toolName, toolInput, options, Date.now()),
          options.signal,
        );
        if (scenario.interruptWhenStarted) {
          interruptTask ??= (async () => {
            try {
              for await (const change of watch(cwd, {
                signal: watcher.signal,
              })) {
                if (change.filename === "started") break;
              }
            } catch {
              return; // aborted at cleanup: the command never started
            }
            await session.interrupt();
            interruptSent = true;
          })();
        }
        permissionBroker.respond(
          options.toolUseID,
          { behavior: "allow" },
          FEEDBACK,
        );
        return decided;
      },
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    session.close();
  }, TIMEOUT_MS);
  let sessionId: UUID | undefined;
  let hookEventFrames = 0;
  try {
    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId ??= message.session_id as UUID;
      }
      if (message.type === "system" && message.subtype.startsWith("hook_")) {
        hookEventFrames += 1;
      }
      // The session ends on its own once its input does: a request the
      // feedback started would keep it going until the timeout.
      if (message.type === "result") endInput();
    }
  } catch (error) {
    // An interrupted turn's error result ends the stream with this throw.
    const isInterruptedResult =
      interruptSent &&
      error instanceof Error &&
      error.message.startsWith("Claude Code returned an error result");
    if (!isInterruptedResult) throw error;
  } finally {
    clearTimeout(timer);
    watcher.abort();
    shim.close();
  }
  await interruptTask;
  if (releaseWrite !== undefined) {
    // A command that never read the fifo leaves the write's open pending;
    // a reader of our own completes it.
    const reader = openSync(
      releasePath,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    await releaseWrite;
    closeSync(reader);
  }
  assert.equal(timedOut, false, "the session did not end on its own");
  if (scenario.interruptWhenStarted) {
    assert.ok(interruptSent, "the command never started");
  }
  assert.ok(sessionId, "no system/init");
  const requests = shim.requests
    .filter(
      (request) =>
        request.path.startsWith("/v1/messages") &&
        !request.path.includes("count_tokens"),
    )
    .map((request) => {
      const messages =
        (request.body as { messages?: unknown[] }).messages ?? [];
      return {
        messages,
        serialized: JSON.stringify(messages),
        // A later main request quotes the subtask prompt in its Agent call;
        // only a subagent's conversation starts with it.
        isSubagent: JSON.stringify(messages[0]).includes(SUBTASK_PROMPT),
      };
    });
  return {
    requests,
    hookCalls,
    hookEventFrames,
    entries: readSessionEntries(sessionFilePath(configDir, cwd, sessionId)),
  };
}

interface Block {
  role: unknown;
  type: unknown;
  toolUseId?: unknown;
  text?: unknown;
  serialized: string;
}

function contentBlocks(messages: unknown[]): Block[] {
  return messages.flatMap((message) => {
    const { role, content } = message as { role?: unknown; content?: unknown };
    const blocks = Array.isArray(content)
      ? content
      : [{ type: "text", text: content }];
    return blocks.map((block) => {
      const { type, tool_use_id, text } = block as {
        type?: unknown;
        tool_use_id?: unknown;
        text?: unknown;
      };
      return {
        role,
        type,
        toolUseId: tool_use_id,
        text,
        serialized: JSON.stringify(block),
      };
    });
  });
}

/** Where the request carries the feedback: folded into the tool_result's
 *  content, or (mid-conversation system) in a `role: "system"` text block
 *  after the tool_result and before the next assistant turn. */
type FeedbackPlacement = "in tool_result" | "system message";

function assertFeedbackFollowsResult(
  request: ApiRequest | undefined,
  toolUseId: string,
  placement: FeedbackPlacement = "system message",
): void {
  assert.ok(request, "no request after the tool ran");
  const blocks = contentBlocks(request.messages);
  const resultAt = blocks.findIndex(
    (block) => block.type === "tool_result" && block.toolUseId === toolUseId,
  );
  assert.ok(resultAt >= 0, `no tool_result for ${toolUseId}`);
  const inResult = blocks[resultAt]!.serialized.includes(FEEDBACK);
  if (placement === "in tool_result") {
    assert.ok(inResult, "the feedback is not inside the tool_result");
    return;
  }
  assert.ok(!inResult, "the feedback is inside the tool_result");
  const after = blocks.slice(resultAt + 1);
  const turnEnd = after.findIndex((block) => block.role === "assistant");
  assert.ok(
    after
      .slice(0, turnEnd === -1 ? undefined : turnEnd)
      .some(
        (block) =>
          block.role === "system" &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.includes(FEEDBACK),
      ),
    "no system text block with the feedback follows the tool_result",
  );
}

function mainRequests(run: FeedbackRun): ApiRequest[] {
  return run.requests.filter((request) => !request.isSubagent);
}

const bash =
  (command: string, extra: Record<string, unknown> = {}) =>
  (): ToolCall => ({
    name: "Bash",
    input: { command, description: "touch", ...extra },
  });

test("main agent, tool succeeds: PostToolUse context follows the tool_result, starts no turn, is recorded, emits no hook events", async () => {
  const run = await runWithFeedback({
    caseName: "main",
    mainCall: bash("touch needs-permission"),
  });
  assert.deepEqual(run.hookCalls, [`PostToolUse ${MAIN_TOOL_USE_ID}`]);
  assert.equal(run.requests.length, 2, "no request beyond the tool's result");
  assertFeedbackFollowsResult(run.requests[1], MAIN_TOOL_USE_ID);
  const recorded = run.entries.flatMap((entry) => {
    const hookContext = hookAdditionalContext(entry.attachment);
    return hookContext === undefined ? [] : [hookContext];
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.toolUseId, MAIN_TOOL_USE_ID);
  assert.ok(recorded[0]?.context.includes(FEEDBACK));
  assert.equal(run.hookEventFrames, 0);
});

test("main agent, Haiku: the context is folded into the tool_result", async () => {
  const run = await runWithFeedback({
    caseName: "main-haiku",
    mainCall: bash("touch needs-permission"),
    model: HAIKU,
  });
  assert.equal(run.requests.length, 2);
  assertFeedbackFollowsResult(
    run.requests[1],
    MAIN_TOOL_USE_ID,
    "in tool_result",
  );
});

test("main agent, tool fails: the context arrives through PostToolUseFailure", async () => {
  const run = await runWithFeedback({
    caseName: "fail",
    mainCall: bash("touch needs-permission && exit 3"),
  });
  assert.deepEqual(run.hookCalls, [`PostToolUseFailure ${MAIN_TOOL_USE_ID}`]);
  assert.equal(run.requests.length, 2);
  assertFeedbackFollowsResult(run.requests[1], MAIN_TOOL_USE_ID);
});

test("foreground subagent: the context reaches the subagent's request, no main-agent request", async () => {
  const run = await runWithFeedback({
    caseName: "subagent",
    mainCall: () => ({
      name: "Agent",
      input: {
        description: "test subagent",
        prompt: SUBTASK_PROMPT,
        subagent_type: "general-purpose",
        run_in_background: false,
      },
    }),
    subagentCall: {
      name: "Bash",
      input: { command: "touch needs-permission", description: "touch" },
    },
  });
  const subagentRequests = run.requests.filter((request) => request.isSubagent);
  assertFeedbackFollowsResult(subagentRequests[1], SUB_TOOL_USE_ID);
  assert.equal(mainRequests(run).length, 2, "both main requests checked");
  assert.ok(
    mainRequests(run).every(
      (request) => !request.serialized.includes(FEEDBACK),
    ),
  );
});

test("Write: the context follows the tool_result", async () => {
  const run = await runWithFeedback({
    caseName: "write",
    mainCall: (cwd) => ({
      name: "Write",
      input: { file_path: join(cwd, "w.txt"), content: "hi\n" },
    }),
  });
  assertFeedbackFollowsResult(run.requests[1], MAIN_TOOL_USE_ID);
});

test("MCP tool: the context follows the tool_result", async () => {
  const run = await runWithFeedback({
    caseName: "mcp",
    mainCall: () => ({ name: "mcp__probe__greet", input: { name: "Anton" } }),
    mcpServers: {
      probe: {
        command: process.execPath,
        args: [join(REPO_DIR, "scripts/tui-parity/mcp-greet-server.ts")],
      },
    },
  });
  assertFeedbackFollowsResult(run.requests[1], MAIN_TOOL_USE_ID);
});

test("background Bash: the context follows the launch result, before the command ends", async () => {
  // The command blocks on the fifo until the launch result's request
  // arrives, so the feedback in that request came before completion.
  const run = await runWithFeedback({
    caseName: "background",
    mainCall: bash("touch needs-permission && cat release", {
      run_in_background: true,
    }),
    releaseOnResult: true,
  });
  assertFeedbackFollowsResult(mainRequests(run)[1], MAIN_TOOL_USE_ID);
});

test("disableAllHooks in settings does not suppress callback hooks", async () => {
  const run = await runWithFeedback({
    caseName: "disable-all-hooks",
    mainCall: bash("touch needs-permission"),
    settings: { disableAllHooks: true },
  });
  assertFeedbackFollowsResult(run.requests[1], MAIN_TOOL_USE_ID);
});

test("an interrupt while the allowed tool runs fires neither hook", async () => {
  const run = await runWithFeedback({
    caseName: "interrupt",
    mainCall: bash("touch started && sleep 30"),
    interruptWhenStarted: true,
  });
  assert.deepEqual(run.hookCalls, []);
  assert.ok(
    run.requests.every((request) => !request.serialized.includes(FEEDBACK)),
  );
});
