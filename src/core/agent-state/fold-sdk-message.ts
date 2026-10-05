import type { UUID } from "node:crypto";
import type { SDKTaskUpdatedMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentState, TaskState } from "../protocol/index.ts";
import { isSubagentTraffic } from "./classification.ts";
import { excludeResetPrompt } from "./observe-event/index.ts";
import { withObservedPermissionMode } from "./observed-permission-mode.ts";
import { withModelAndUsage } from "./query-message.ts";
import { liveTasks, queryingCount } from "./selectors.ts";
import { withSession } from "./with-session.ts";
import { withTask } from "./with-permission.ts";
import { withAnomalies } from "./tracker-anomaly.ts";
import { withUnresolvedTools } from "./with-unresolved-tools.ts";

/** After the observation: the message's evidence, then what it says
 *  about this agent's own turn (activity, settings, a reset). */
export function foldSdkMessage(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sdkMessage" }>,
): AgentState {
  const message = event.message;
  state = withUnresolvedTools(withModelAndUsage(state, event), message);
  if (isSubagentTraffic(message)) {
    // Observed for its place in the query order only: the activity and
    // settings below describe this agent's own turn.
    return state;
  }
  if (message.type === "conversation_reset") {
    // The CLI emits this before the new conversation's init. Despite
    // its name, new_conversation_id is not the transcript session_id
    // announced by that init (tests/sdk/clear-session.test.ts, verified
    // through SDK 0.3.280); the old context's evidence
    // stays with its file. Queued future turns still belong to the
    // running process. The reset command's own prompt is filed under the
    // NEXT session instead, so it is excluded from this file's stream.
    const sessionId = message.session_id as UUID;
    const resetSession = state.sessions[sessionId];
    if (resetSession === undefined) return state;
    const resetExclusion = excludeResetPrompt(resetSession);
    return withAnomalies(
      withSession(state, sessionId, resetExclusion.session),
      resetExclusion.anomalies,
    );
  }
  if (message.type === "system" && message.subtype === "init") {
    return withObservedPermissionMode(
      {
        ...state,
        model: message.model,
        cwd: message.cwd,
        claudeCodeVersion: message.claude_code_version,
      },
      message.permissionMode,
    );
  }
  if (
    message.type === "system" &&
    message.subtype === "status" &&
    message.permissionMode !== undefined
  ) {
    // Mode changes not initiated over socket (e.g. plan-mode
    // transitions).
    return withObservedPermissionMode(state, message.permissionMode);
  }
  if (message.type === "system" && message.subtype === "task_started") {
    // Ambient tasks (watchers, housekeeping) are not activity: never live.
    if (message.ambient === true) return state;
    // SendMessage resumes a task under the same id; it keeps its first
    // spawning call, its asks and its unresolved tool uses.
    const knownTask = state.tasks.find(
      (task) => task.taskId === message.task_id,
    );
    const toolUseId =
      knownTask === undefined ? message.tool_use_id : knownTask.toolUseId;
    return withTask(state, {
      taskId: message.task_id,
      ...(toolUseId !== undefined && { toolUseId }),
      description: message.description,
      ...(message.task_type !== undefined && { taskType: message.task_type }),
      ...(message.subagent_type !== undefined && {
        subagentType: message.subagent_type,
      }),
      background: message.is_backgrounded === true,
      status: "running",
      pendingPermissions: knownTask?.pendingPermissions ?? [],
      unresolvedToolUses: knownTask?.unresolvedToolUses ?? [],
    });
  }
  if (message.type === "system" && message.subtype === "task_updated") {
    const task = state.tasks.find((task) => task.taskId === message.task_id);
    if (task === undefined) return state;
    const { status, description, is_backgrounded } = message.patch;
    const patchedTask = {
      ...task,
      ...(description !== undefined && { description }),
      ...(is_backgrounded !== undefined && { background: is_backgrounded }),
    };
    return withTask(
      state,
      status === undefined ? patchedTask : withTaskStatus(patchedTask, status),
    );
  }
  if (message.type === "system" && message.subtype === "task_notification") {
    // Final for a task that ended without a terminal `task_updated`.
    const liveTask = liveTasks(state).find(
      (task) => task.taskId === message.task_id,
    );
    if (liveTask === undefined) return state;
    return withTask(
      state,
      withTaskStatus(
        liveTask,
        message.status === "stopped" ? "killed" : message.status,
      ),
    );
  }
  if (message.type === "assistant") {
    // Top-level assistant output confirms the turn started. Compacting is
    // exited by the subsequent `result`, not by assistant output or the
    // compact-boundary message (which arrives when compaction *finishes*).
    if (state.activity !== "compacting") {
      return { ...state, activity: "working" };
    }
  }
  if (message.type === "result") {
    // The about-to-run bucket (if any) is still in queuedMessages — its
    // dequeue event follows this result — so pending-vs-idle is decided
    // here.
    // The main agent's turn cannot end with its own tool uses open, so any
    // left are stale (their `tool_result` never came).
    return {
      ...state,
      unresolvedToolUses: [],
      activity: queryingCount(state) > 0 ? "pending" : "idle",
    };
  }
  return state;
}

/** An ended task keeps its metadata (SendMessage can resume it); its asks
 *  and tool uses can no longer be answered. */
function withTaskStatus(
  task: TaskState,
  status: NonNullable<SDKTaskUpdatedMessage["patch"]["status"]>,
): TaskState {
  return status === "completed" || status === "failed" || status === "killed"
    ? { ...task, status, pendingPermissions: [], unresolvedToolUses: [] }
    : { ...task, status };
}
