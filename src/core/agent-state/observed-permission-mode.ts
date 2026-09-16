import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "./agent-state.ts";

export function withObservedPermissionMode(
  state: AgentState,
  mode: PermissionMode,
): AgentState {
  return {
    ...state,
    permissionMode: mode,
    observedPermissionModes: state.observedPermissionModes.includes(mode)
      ? state.observedPermissionModes
      : [...state.observedPermissionModes, mode],
  };
}
