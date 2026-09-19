import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "./agent-state.ts";
import { foldQueryMessage } from "./fold-query-message.ts";
import { withObservedPermissionMode } from "./observed-permission-mode.ts";
import { queryingCount } from "./selectors.ts";

export function foldSdkMessage(
  state: AgentState,
  message: SDKMessage,
): AgentState {
  if (
    "parent_tool_use_id" in message &&
    typeof message.parent_tool_use_id === "string"
  ) {
    // Subagent traffic (user, assistant and their stream_events): its
    // usage describes the subagent's own context, not this agent's, and
    // its transcript lives in the subagent's own file, so none of its ids
    // can meet an entry here — a subagent's merge is a separate session
    // model over that file (docs/thoughts/subagent-activity.md).
    return state;
  }
  let next = foldQueryMessage(state, message);
  if (
    (message.type === "user" || message.type === "assistant") &&
    message.uuid !== undefined
  ) {
    // The uuid guard is for the type only: stream user/assistant messages
    // always carry the transcript uuid (verified in the CLI binary; the
    // optional uuid on SDKUserMessage is for host-pushed input). The
    // boundary advance (foldQueryMessage's pendingLeaf) and the
    // deliveredMessages clear happen in the same fold step — that is the
    // prompt-visibility bookkeeping (agent-state.ts header comment).
    if (next.deliveredMessages.length > 0) {
      next = { ...next, deliveredMessages: [] };
    }
  }
  if (message.type === "conversation_reset") {
    // SDK 0.3.250 emits this before the new conversation's init. Despite
    // its name, new_conversation_id is not the transcript session_id
    // announced by that init (verified live); the old context's evidence
    // stays with its file. Queued future turns still belong to the
    // running process.
    return { ...next, deliveredMessages: [] };
  }
  if (message.type === "system" && message.subtype === "init") {
    return withObservedPermissionMode(
      {
        ...next,
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
    return withObservedPermissionMode(next, message.permissionMode);
  }
  if (message.type === "assistant") {
    // Top-level assistant output confirms the turn started. Compacting is
    // exited by the subsequent `result`, not by assistant output or the
    // compact-boundary message (which arrives when compaction *finishes*).
    if (next.activity !== "compacting") {
      return { ...next, activity: "working" };
    }
  }
  if (message.type === "result") {
    // The about-to-run bucket (if any) is still in queuedMessages — its
    // dequeue event follows this result — so pending-vs-idle is decided
    // here.
    return {
      ...next,
      activity: queryingCount(next) > 0 ? "pending" : "idle",
    };
  }
  return next;
}
