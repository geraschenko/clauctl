import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "../protocol/index.ts";
import { liveTasks } from "./selectors.ts";
import { withTask } from "./with-permission.ts";

/** An assistant frame's tool_use blocks join, and a user frame's
 *  tool_result blocks leave, the unresolved tool uses of the agent that
 *  produced the frame: the main agent's, or the live task whose
 *  `toolUseId` is the frame's `parent_tool_use_id`. Frames of no live task
 *  are not tracked. */
export function withUnresolvedTools(
  state: AgentState,
  message: SDKMessage,
): AgentState {
  if (message.type !== "assistant" && message.type !== "user") return state;
  const content = message.message.content;
  if (typeof content === "string") return state;
  const added: string[] = [];
  const resolved = new Set<string>();
  for (const block of content) {
    if (block.type === "tool_use") added.push(block.id);
    if (block.type === "tool_result") resolved.add(block.tool_use_id);
  }
  if (added.length === 0 && resolved.size === 0) return state;
  const updated = (unresolved: readonly string[]): string[] => [
    ...unresolved.filter((toolUseId) => !resolved.has(toolUseId)),
    ...added,
  ];
  if (message.parent_tool_use_id === null) {
    return {
      ...state,
      unresolvedToolUses: updated(state.unresolvedToolUses),
    };
  }
  const task = liveTasks(state).find(
    (task) => task.toolUseId === message.parent_tool_use_id,
  );
  return task === undefined
    ? state
    : withTask(state, {
        ...task,
        unresolvedToolUses: updated(task.unresolvedToolUses),
      });
}
