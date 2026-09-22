import type { UUID } from "node:crypto";
import type {
  NonNullableUsage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type AgentEvent, eventUuid } from "../protocol.ts";
import type { AgentState } from "./agent-state.ts";
import { isSubagentTraffic } from "./classification.ts";
import { type SessionState, withSession } from "./session-state.ts";
import { toNonNullableUsage } from "./to-non-nullable-usage.ts";

/** A leaf-eligible query message: the file entry it becomes is a tree
 *  row (user/assistant with a uuid). */
function isLeafEligible(message: SDKMessage): boolean {
  return (
    (message.type === "user" || message.type === "assistant") &&
    message.uuid !== undefined
  );
}

/** The session a query message's evidence belongs to: its `session_id`
 *  when that is the announced query session. Undefined otherwise — the
 *  message's observation (`observeEvent`) reports it as not announced,
 *  and nothing else about the state changes. */
function announcedSession(
  state: AgentState,
  message: SDKMessage,
): SessionState | undefined {
  const sessionId = message.session_id as UUID;
  return sessionId === state.querySessionId
    ? state.sessions[sessionId]
    : undefined;
}

/** Before the observation: a leaf-eligible top-level message is its
 *  session's next leaf (the observation itself may resolve that node and
 *  clear `pendingLeaf` again). */
export function withPendingLeaf(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sdkMessage" }>,
): AgentState {
  const message = event.message;
  const session = announcedSession(state, message);
  if (
    session === undefined ||
    isSubagentTraffic(message) ||
    !isLeafEligible(message)
  ) {
    return state;
  }
  return withSession(state, message.session_id as UUID, {
    ...session,
    pendingLeaf: eventUuid(event),
  });
}

/** After the observation: per-session usage/model evidence from
 *  top-level messages. */
export function withQueryEvidence(
  state: AgentState,
  event: Extract<AgentEvent, { kind: "sdkMessage" }>,
): AgentState {
  const message = event.message;
  const session = announcedSession(state, message);
  if (session === undefined || isSubagentTraffic(message)) return state;
  if (message.type === "assistant") {
    return withSession(state, message.session_id as UUID, {
      ...session,
      lastUsage: toNonNullableUsage(message.message.usage),
      model: message.message.model,
    });
  }
  if (message.type === "system" && message.subtype === "compact_boundary") {
    return withSession(
      state,
      message.session_id as UUID,
      withPostTokens(session, message.compact_metadata.post_tokens),
    );
  }
  return state;
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
