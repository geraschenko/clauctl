import type { UUID } from "node:crypto";
import type {
  NonNullableUsage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "./agent-state.ts";
import { classOf, excludedFromSession } from "./classification.ts";
import { observeOn } from "./observe-on.ts";
import { type SessionState, withSession } from "./session-state.ts";
import { toNonNullableUsage } from "./to-non-nullable-usage.ts";
import { withAnomalies } from "./tracker-anomaly.ts";

/** A leaf-eligible query message: the file entry it becomes is a tree
 *  row (user/assistant with a uuid). */
function isLeafEligible(message: SDKMessage): boolean {
  return (
    (message.type === "user" || message.type === "assistant") &&
    message.uuid !== undefined
  );
}

/** Subagent traffic (user, assistant and their stream_events): its usage
 *  describes the subagent's own context, not this agent's, and its
 *  transcript lives in the subagent's own file, so none of its ids can
 *  meet an entry here — a subagent's merge is a separate session model
 *  over that file (docs/thoughts/subagent-activity.md). */
export function isSubagentTraffic(message: SDKMessage): boolean {
  return (
    "parent_tool_use_id" in message &&
    typeof message.parent_tool_use_id === "string"
  );
}

/** A query message's merge rule on its `session_id` file (spec, Fold rules,
 *  sdkMessage): observe on `query` under its own uuid or the event's
 *  stamp, first observations excluded from `session` per the
 *  classification (always for a uuid-less message and for subagent
 *  traffic); per-file usage/model evidence from top-level messages. The
 *  session was announced by `querySessionChanged`; a message on an
 *  unannounced session is a daemon bug and is reported. */
export function foldQueryMessage(
  state: AgentState,
  message: SDKMessage,
  eventUuid: UUID,
): AgentState {
  const sessionId = message.session_id as UUID;
  let session = state.sessions[sessionId];
  if (session === undefined) {
    return withAnomalies(state, [
      {
        kind: "merge-error",
        detail: `${classOf(message)} ${eventUuid} on query: session ${sessionId} not announced`,
      },
    ]);
  }
  const subagent = isSubagentTraffic(message);
  if (!subagent && isLeafEligible(message)) {
    session = { ...session, pendingLeaf: eventUuid };
  }
  const appearedInSession = Object.hasOwn(session.merge.nodes, eventUuid);
  const excludeOther =
    !appearedInSession &&
    (message.uuid === undefined || subagent || excludedFromSession(message));
  const observation = observeOn(
    session,
    "query",
    eventUuid,
    classOf(message),
    excludeOther,
  );
  session = observation.session;
  if (!subagent && message.type === "assistant") {
    session = {
      ...session,
      lastUsage: toNonNullableUsage(message.message.usage),
      model: message.message.model,
    };
  }
  if (message.type === "system" && message.subtype === "compact_boundary") {
    session = withPostTokens(session, message.compact_metadata.post_tokens);
  }
  return withAnomalies(
    withSession(state, sessionId, session),
    observation.anomalies,
  );
}

/** post_tokens is the compacted context size; represented as a pure
 *  input_tokens usage so consumers summing the input-side counters
 *  (footer, set-context's preTokensOf) read back exactly post_tokens.
 *  Without it the old lastUsage describes the superseded context, so it
 *  is dropped rather than kept wrong. */
function withPostTokens(
  session: SessionState,
  postTokens: number | undefined,
): SessionState {
  if (postTokens === undefined) {
    const { lastUsage: _lastUsage, ...withoutUsage } = session;
    return withoutUsage;
  }
  return {
    ...session,
    lastUsage: {
      input_tokens: postTokens,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as NonNullableUsage,
  };
}
