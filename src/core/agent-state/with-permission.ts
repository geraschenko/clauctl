import type {
  AgentState,
  PermissionRequest,
  TaskState,
} from "../protocol/index.ts";
import { withAnomalies } from "./tracker-anomaly.ts";

/** The ask joins its task's list (`agentId` = the task's id) or the main
 *  agent's. An `agentId` naming no live task is an anomaly (the CLI
 *  announced no such task); the ask lands on the main list so it can
 *  still be answered. */
export function withPermissionRequested(
  state: AgentState,
  request: PermissionRequest,
): AgentState {
  const task = state.tasks.find((task) => task.taskId === request.agentId);
  if (task !== undefined) {
    return withTask(state, {
      ...task,
      pendingPermissions: [...task.pendingPermissions, request],
    });
  }
  const onMain = {
    ...state,
    pendingPermissions: [...state.pendingPermissions, request],
  };
  return request.agentId === undefined
    ? onMain
    : withAnomalies(onMain, [
        {
          kind: "classification",
          detail: `permission ${request.toolUseId} names task ${request.agentId}, which is not live`,
        },
      ]);
}

/** Removes the ask by `toolUseId` wherever it is; identity when no list
 *  holds it. */
export function withPermissionResolved(
  state: AgentState,
  toolUseId: string,
): AgentState {
  const notResolved = (request: PermissionRequest): boolean =>
    request.toolUseId !== toolUseId;
  if (!state.pendingPermissions.every(notResolved)) {
    return {
      ...state,
      pendingPermissions: state.pendingPermissions.filter(notResolved),
    };
  }
  const task = state.tasks.find(
    (task) => !task.pendingPermissions.every(notResolved),
  );
  return task === undefined
    ? state
    : withTask(state, {
        ...task,
        pendingPermissions: task.pendingPermissions.filter(notResolved),
      });
}

/** `task` replaces the live task of its id, or joins the end. */
export function withTask(state: AgentState, task: TaskState): AgentState {
  const index = state.tasks.findIndex((live) => live.taskId === task.taskId);
  return {
    ...state,
    tasks:
      index === -1 ? [...state.tasks, task] : state.tasks.with(index, task),
  };
}

export function withoutTask(state: AgentState, taskId: string): AgentState {
  return state.tasks.some((task) => task.taskId === taskId)
    ? { ...state, tasks: state.tasks.filter((task) => task.taskId !== taskId) }
    : state;
}
