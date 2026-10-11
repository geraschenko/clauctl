import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "../../core/protocol/index.ts";

/** The mode after the agent's current one: default, plan, acceptEdits,
 *  auto, then any other modes the agent has reported, without repeats. */
export function nextPermissionMode(state: AgentState): PermissionMode {
  const cycle = [
    ...new Set<PermissionMode>([
      "default",
      "plan",
      "acceptEdits",
      "auto",
      ...state.observedPermissionModes,
    ]),
  ];
  const current = state.permissionMode ?? "default";
  return cycle[(cycle.indexOf(current) + 1) % cycle.length]!;
}
