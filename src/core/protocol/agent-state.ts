import type { UUID } from "node:crypto";
import type {
  EffortLevel,
  PermissionMode,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionRequest } from "./permission.ts";
import type { SessionState } from "./session-state.ts";
import type { TrackerAnomaly } from "./tracker-anomaly.ts";

export type AgentActivity = "idle" | "pending" | "working" | "compacting";

/** One live entry of the CLI's task map (sdk.d.ts: "clients merge into
 *  their local task map"). A subagent is a task of type `local_agent`.
 *  Its transcript is `<session>/subagents/agent-<taskId>.jsonl` (entries
 *  carry the main session's id; `taskId` is the identity) — a per-task
 *  `session: SessionState` merged over that file is the planned
 *  extension (docs/follow-ups/subagent-activity.md), not modeled yet. */
export interface TaskState {
  readonly taskId: string;
  /** The tool use that spawned it; subagent frames carry it as
   *  `parent_tool_use_id`. Absent for CLI-started tasks. */
  readonly toolUseId?: string;
  readonly description: string;
  readonly taskType?: string;
  readonly subagentType?: string;
  readonly background: boolean;
  readonly status: "running" | "paused";
  /** The task's own asks, arrival order. */
  readonly pendingPermissions: readonly PermissionRequest[];
}

/**
 * A wire type: the subscribe response is a serialized AgentState, so
 * daemon-side and client-side values are the same kind of thing (which is why
 * `nextAgentState` is a free function, not a method). Readonly is shallow:
 * the fold never mutates its input; nested SDK payloads are treated as
 * immutable by convention. Excluded by design: rendering state, queue-model
 * inference state (daemon-internal), the persisted AgentRecord, and tty
 * attachment state. Arrays are always present (empty, not absent); optional
 * scalars mean "not yet observed".
 */
export interface AgentState {
  readonly activity: AgentActivity;
  /** Predictive: what the next query will use (seeded from settings, folded
   *  from init/set-model), as opposed to the per-session observed `model`. */
  readonly model?: string;
  /** Predictive, like `model`; observed only through the query stream. */
  readonly permissionMode?: PermissionMode;
  /** The reasoning effort the next query will use. Seeded by the daemon
   *  (spawn `--effort` flag, else resolved settings), folded from
   *  apply-flag-settings. */
  readonly effortLevel?: EffortLevel;
  /** The CLI version announced by the session's claude child. */
  readonly claudeCodeVersion?: string;
  /** Every mode observed this daemon lifetime, in first-observed order. */
  readonly observedPermissionModes: readonly PermissionMode[];
  readonly cwd?: string;
  /** Accepted, not yet consumed by the CLI; `uuid` is the stamped uuid. */
  readonly queuedMessages: readonly { uuid: UUID; message: SDKUserMessage }[];
  /** Plain record (it crosses the wire in `subscribe`). */
  readonly sessions: Readonly<Record<UUID, SessionState>>;
  /** The query file: the session `querySessionChanged` last announced —
   *  the daemon's chosen id from hub construction on, then each new id
   *  before its first query message. */
  readonly querySessionId?: UUID;
  /** The tracked file; trails `querySessionId` until the switch;
   *  undefined until the first file exists. */
  readonly fileSessionId?: UUID;
  /** Live, non-ambient tasks in `task_started` order; a task leaves on a
   *  terminal `task_updated` status or its `task_notification`. */
  readonly tasks: readonly TaskState[];
  /** The main agent's own asks, arrival order. */
  readonly pendingPermissions: readonly PermissionRequest[];
  /** Set by the fold that detected it, absent on every other state:
   *  "the event just folded was anomalous". History lives in the log
   *  and the bundles. */
  readonly anomaly?: TrackerAnomaly;
}
