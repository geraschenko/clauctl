import type { UUID } from "node:crypto";
import { type AgentEvent, eventUuid } from "../protocol.ts";
import { pending } from "../stream-merge.ts";
import type { AgentState } from "./agent-state.ts";
import { foldQueryMessage, isSubagentTraffic } from "./fold-query-message.ts";
import { excludeOn } from "./observe-on.ts";
import { withObservedPermissionMode } from "./observed-permission-mode.ts";
import { queryingCount } from "./selectors.ts";
import { withSession } from "./session-state.ts";
import { withAnomalies } from "./tracker-anomaly.ts";

export function foldSdkMessage(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sdkMessage" }>,
): AgentState {
  const message = event.message;
  const next = foldQueryMessage(state, message, eventUuid(event));
  if (isSubagentTraffic(message)) {
    // Observed for its place in the query order only: the activity and
    // settings below describe this agent's own turn.
    return next;
  }
  if (message.type === "conversation_reset") {
    // SDK 0.3.250 emits this before the new conversation's init. Despite
    // its name, new_conversation_id is not the transcript session_id
    // announced by that init (verified live); the old context's evidence
    // stays with its file. Queued future turns still belong to the
    // running process. The reset command's own prompt — the last query
    // observation still awaiting this file — is filed under the NEXT
    // session instead, so it is excluded from this file's stream.
    const sessionId = message.session_id as UUID;
    const session = next.sessions[sessionId];
    if (session === undefined) return next;
    const last = pending(session.merge, "query")
      .filter(
        (id) => !session.merge.nodes[id]!.excludedFrom.includes("session"),
      )
      .at(-1);
    if (last === undefined) return next;
    const observation = excludeOn(
      session,
      "session",
      last,
      "conversation_reset",
    );
    return withAnomalies(
      withSession(next, sessionId, observation.session),
      observation.anomalies,
    );
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
