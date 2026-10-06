// Unresolved tool uses (with-unresolved-tools.ts) and the input-needed selectors;
// definitions in docs/specs/permission-cli.md, "Definitions".

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  AgentState,
  PermissionRequest,
  TaskState,
} from "../protocol/index.ts";
import { initialAgentState, nextAgentState } from "./next-agent-state.ts";
import { isInputNeeded, isStoppedOnAsk } from "./selectors.ts";

const sdk = (message: Record<string, unknown>): AgentEvent => ({
  kind: "sdkMessage",
  message: message as unknown as SDKMessage,
  uuid: crypto.randomUUID(),
});

const assistantToolUse = (id: string, parent: string | null): AgentEvent =>
  sdk({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name: "Bash", input: {} }] },
  });

const toolResult = (id: string, parent: string | null): AgentEvent =>
  sdk({
    type: "user",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_result", tool_use_id: id }] },
  });

const taskStarted = (taskId: string, toolUseId: string): AgentEvent =>
  sdk({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "d",
  });

const ask = (toolUseId: string, agentId?: string): AgentEvent => ({
  kind: "permissionRequested",
  uuid: crypto.randomUUID(),
  request: {
    toolUseId,
    toolName: "Bash",
    input: {},
    arrivedAt: 0,
    suggestions: [],
    ...(agentId !== undefined && { agentId }),
  } as PermissionRequest,
});

const fold = (events: AgentEvent[], from = initialAgentState()): AgentState =>
  events.reduce(nextAgentState, from);

const notification = (taskId: string, status: string): AgentEvent =>
  sdk({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status,
  });

test("a tool_use is unresolved until its tool_result, on the agent that produced it", () => {
  const open = fold([
    taskStarted("t1", "agent1"),
    assistantToolUse("main1", null),
    assistantToolUse("sub1", "agent1"),
  ]);
  assert.deepEqual(open.unresolvedToolUses, ["main1"]);
  assert.deepEqual(open.tasks[0]!.unresolvedToolUses, ["sub1"]);
  const resolved = fold([toolResult("sub1", "agent1")], open);
  assert.deepEqual(resolved.unresolvedToolUses, ["main1"]);
  assert.deepEqual(resolved.tasks[0]!.unresolvedToolUses, []);
});

test("a subagent frame of no live task is not tracked", () => {
  const state = fold([assistantToolUse("sub1", "agent1")]);
  assert.deepEqual(state.unresolvedToolUses, []);
  assert.deepEqual(state.tasks, []);
});

test("the main agent's result clears only its own tool uses; a task's end clears the task's and keeps the task", () => {
  const open = fold([
    taskStarted("t1", "agent1"),
    assistantToolUse("main1", null),
    assistantToolUse("sub1", "agent1"),
    ask("sub1", "t1"),
  ]);
  const afterResult = fold([sdk({ type: "result" })], open);
  assert.deepEqual(afterResult.unresolvedToolUses, []);
  assert.deepEqual(afterResult.tasks[0]!.unresolvedToolUses, ["sub1"]);
  const ended = fold([notification("t1", "stopped")], afterResult);
  assert.equal(ended.tasks.length, 1);
  assert.equal(ended.tasks[0]!.status, "killed");
  assert.deepEqual(ended.tasks[0]!.unresolvedToolUses, []);
  assert.deepEqual(ended.tasks[0]!.pendingPermissions, []);
});

test("a task_notification does not override a terminal task_updated status", () => {
  const state = fold([
    taskStarted("t1", "agent1"),
    sdk({
      type: "system",
      subtype: "task_updated",
      task_id: "t1",
      patch: { status: "completed" },
    }),
    notification("t1", "stopped"),
  ]);
  assert.equal(state.tasks[0]!.status, "completed");
});

test("a re-emitted task_started resumes the task, keeping its spawning call, asks and tool uses", () => {
  const state = fold([
    taskStarted("t1", "agent1"),
    assistantToolUse("sub1", "agent1"),
    ask("sub1", "t1"),
    taskStarted("t1", "sendMessage1"),
  ]);
  const [resumed] = state.tasks;
  assert.equal(resumed!.toolUseId, "agent1");
  assert.deepEqual(
    resumed!.pendingPermissions.map((request) => request.toolUseId),
    ["sub1"],
  );
  assert.deepEqual(resumed!.unresolvedToolUses, ["sub1"]);
  const afterEnd = fold(
    [notification("t1", "completed"), taskStarted("t1", "sendMessage2")],
    state,
  );
  assert.equal(afterEnd.tasks[0]!.status, "running");
  assert.equal(afterEnd.tasks[0]!.toolUseId, "agent1");
});

test("a query session change clears tasks; re-announcing the same session keeps them", () => {
  const first = crypto.randomUUID();
  const withTask = fold([
    { kind: "querySessionChanged", sessionId: first },
    taskStarted("t1", "agent1"),
    { kind: "querySessionChanged", sessionId: first },
  ]);
  assert.equal(withTask.tasks.length, 1);
  const changed = fold(
    [{ kind: "querySessionChanged", sessionId: crypto.randomUUID() }],
    withTask,
  );
  assert.deepEqual(changed.tasks, []);
});

const task = (
  toolUseId: string,
  pendingPermissions: readonly PermissionRequest[] = [],
  unresolvedToolUses: readonly string[] = [],
  status: TaskState["status"] = "running",
): TaskState => ({
  taskId: `task-${toolUseId}`,
  toolUseId,
  description: "d",
  background: true,
  status,
  pendingPermissions,
  unresolvedToolUses,
});

const request = (toolUseId: string): PermissionRequest => ({
  toolUseId,
  toolName: "Bash",
  input: {},
  arrivedAt: 0,
  suggestions: [],
});

const state = (fields: Partial<AgentState>): AgentState => ({
  ...initialAgentState(),
  ...fields,
});

const CASES: [string, AgentState, boolean, boolean][] = [
  ["idle, nothing live", state({}), true, false],
  ["working, no tool in flight", state({ activity: "working" }), false, false],
  [
    "main agent asking",
    state({
      activity: "working",
      unresolvedToolUses: ["a"],
      pendingPermissions: [request("a")],
    }),
    true,
    true,
  ],
  [
    "main agent asking beside a running sibling",
    state({
      activity: "working",
      unresolvedToolUses: ["a", "read"],
      pendingPermissions: [request("a")],
    }),
    false,
    false,
  ],
  [
    "idle with a background task that asks nothing",
    state({ tasks: [task("bg")] }),
    false,
    false,
  ],
  [
    "idle with an asking background task",
    state({ tasks: [task("bg", [request("b")])] }),
    true,
    true,
  ],
  [
    "foreground subagent asking: the Agent call is task-backed",
    state({
      activity: "working",
      tasks: [task("agent1", [request("b")], ["b"])],
      unresolvedToolUses: ["agent1"],
    }),
    true,
    true,
  ],
  [
    "foreground subagent asking beside its own running sibling",
    state({
      activity: "working",
      tasks: [task("agent1", [request("b")], ["b", "c"])],
      unresolvedToolUses: ["agent1"],
    }),
    false,
    false,
  ],
  [
    "foreground nested subagent asking: each Agent call waits on a live task",
    state({
      activity: "working",
      tasks: [
        task("outer", [], ["nested"]),
        task("nested", [request("n")], ["n"]),
      ],
      unresolvedToolUses: ["outer"],
    }),
    true,
    true,
  ],
  [
    "background nested subagent asking under an ended parent",
    state({
      tasks: [
        task("outer", [], [], "completed"),
        task("nested", [request("n")], ["n"]),
      ],
    }),
    true,
    true,
  ],
  [
    "a parent generating beside its asking background child",
    state({
      tasks: [task("outer"), task("nested", [request("n")], ["n"])],
    }),
    false,
    false,
  ],
  [
    "a parent running a tool beside its asking background child",
    state({
      tasks: [
        task("outer", [], ["read"]),
        task("nested", [request("n")], ["n"]),
      ],
    }),
    false,
    false,
  ],
  [
    "idle with an ended task: not live",
    state({ tasks: [task("bg", [], [], "completed")] }),
    true,
    false,
  ],
  [
    "a querying message queued",
    state({
      queuedMessages: [
        {
          uuid: crypto.randomUUID(),
          message: {
            type: "user",
            message: { role: "user", content: "hi" },
            parent_tool_use_id: null,
          },
        },
      ],
    }),
    false,
    false,
  ],
];

for (const [name, agentState, inputNeeded, stoppedOnAsk] of CASES) {
  test(`isInputNeeded/isStoppedOnAsk: ${name}`, () => {
    assert.equal(isInputNeeded(agentState), inputNeeded);
    assert.equal(isStoppedOnAsk(agentState), stoppedOnAsk);
  });
}
