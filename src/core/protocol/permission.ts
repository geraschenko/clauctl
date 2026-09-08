import type {
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";

/** One canUseTool call, serialized. Omits requestId (SDK-internal) and
 *  matchedAskRule (unobserved; add when a consumer needs it). The answer
 *  is the SDK's own PermissionResult — the socket exposes the SDK's full
 *  API — but the request has no SDK counterpart to reuse: what the SDK
 *  hands a host is the canUseTool argument list, serialized here. */
export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
  /** The ask must not be approvable by one stray keystroke: the dialog
   *  opens on its decline row and takes no digit shortcut. */
  defaultToNo?: boolean;
  /** The ask must not offer a persistent "don't ask again" row: the rule
   *  it would write grants more than this ask's own action. */
  suppressAlwaysAllowRule?: boolean;
  /** The bridge's full prompt sentence; unpopulated over stdio today
   *  (docs/derisk/permission-prompt/FINDINGS.md) but the SDK says to
   *  prefer it when present. */
  title?: string;
  /** The CLI's user-facing tool name (`Greet` for `mcp__probe__greet`). */
  displayName?: string;
  /** The CLI's one-line subtitle (Bash description, file basename, url). */
  description?: string;
  /** The asking task's id (`task_started.task_id`) when the ask
   *  originates in a subagent; absent for the main agent. */
  agentId?: string;
}

/** How a pending ask ended; carries the decision so every observer (a
 *  second TUI, `tail`) sees what was answered, not just that it was. */
export type PermissionResolution = PermissionResult | { behavior: "cancelled" };

export const NOT_PENDING_ERROR = "permission not pending";

/** The protocol client's request() wraps daemon errors as `daemon rejected
 *  <type>: <error>`; this is the one predicate clients use to recognize
 *  a lost permission race through that wrapping. */
export function isNotPendingError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(NOT_PENDING_ERROR);
}
