import type { UUID } from "node:crypto";
import type { AgentEvent, AgentState } from "../protocol/index.ts";
import { isSubagentTraffic } from "./classification.ts";
import { excludeResetPrompt } from "./observe-event/index.ts";
import { withObservedPermissionMode } from "./observed-permission-mode.ts";
import { withQueryEvidence } from "./query-message.ts";
import { queryingCount } from "./selectors.ts";
import { withSession } from "./with-session.ts";
import { withTask, withoutTask } from "./with-permission.ts";
import { withAnomalies } from "./tracker-anomaly.ts";

/** After the observation: the message's evidence, then what it says
 *  about this agent's own turn (activity, settings, a reset). */
export function foldSdkMessage(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sdkMessage" }>,
): AgentState {
  const message = event.message;
  const stateWithEvidence = withQueryEvidence(state, event);
  if (isSubagentTraffic(message)) {
    // Observed for its place in the query order only: the activity and
    // settings below describe this agent's own turn.
    return stateWithEvidence;
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
    const resetSession = stateWithEvidence.sessions[sessionId];
    if (resetSession === undefined) return stateWithEvidence;
    const resetExclusion = excludeResetPrompt(resetSession);
    return withAnomalies(
      withSession(stateWithEvidence, sessionId, resetExclusion.session),
      resetExclusion.anomalies,
    );
  }
  if (message.type === "system" && message.subtype === "init") {
    return withObservedPermissionMode(
      {
        ...stateWithEvidence,
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
    return withObservedPermissionMode(
      stateWithEvidence,
      message.permissionMode,
    );
  }
  if (message.type === "system" && message.subtype === "task_started") {
    // Ambient tasks (watchers, housekeeping) are not activity: never live.
    if (message.ambient === true) return stateWithEvidence;
    return withTask(stateWithEvidence, {
      taskId: message.task_id,
      ...(message.tool_use_id !== undefined && {
        toolUseId: message.tool_use_id,
      }),
      description: message.description,
      ...(message.task_type !== undefined && { taskType: message.task_type }),
      ...(message.subagent_type !== undefined && {
        subagentType: message.subagent_type,
      }),
      background: message.is_backgrounded === true,
      status: "running",
      pendingPermissions: [],
    });
  }
  if (message.type === "system" && message.subtype === "task_updated") {
    const task = stateWithEvidence.tasks.find(
      (live) => live.taskId === message.task_id,
    );
    const { status, description, is_backgrounded } = message.patch;
    if (task === undefined) return stateWithEvidence;
    if (status === "completed" || status === "failed" || status === "killed") {
      return withoutTask(stateWithEvidence, message.task_id);
    }
    return withTask(stateWithEvidence, {
      ...task,
      ...(status === "paused" && { status: "paused" }),
      ...(status === "running" && { status: "running" }),
      ...(description !== undefined && { description }),
      ...(is_backgrounded !== undefined && { background: is_backgrounded }),
    });
  }
  if (message.type === "system" && message.subtype === "task_notification") {
    return withoutTask(stateWithEvidence, message.task_id);
  }
  if (message.type === "assistant") {
    // Top-level assistant output confirms the turn started. Compacting is
    // exited by the subsequent `result`, not by assistant output or the
    // compact-boundary message (which arrives when compaction *finishes*).
    if (stateWithEvidence.activity !== "compacting") {
      return { ...stateWithEvidence, activity: "working" };
    }
  }
  if (message.type === "result") {
    // The about-to-run bucket (if any) is still in queuedMessages — its
    // dequeue event follows this result — so pending-vs-idle is decided
    // here.
    return {
      ...stateWithEvidence,
      activity: queryingCount(stateWithEvidence) > 0 ? "pending" : "idle",
    };
  }
  return stateWithEvidence;
}
