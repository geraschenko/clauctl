import type { UUID } from "node:crypto";
import type {
  NonNullableUsage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "./agent-state.ts";
import { classOf, excludedFromSession } from "./classification.ts";
import { observeOn } from "./observe-on.ts";
import {
  freshSessionState,
  type SessionState,
  withSession,
} from "./session-state.ts";
import { toNonNullableUsage } from "./to-non-nullable-usage.ts";
import { type TrackerAnomaly, withAnomalies } from "./tracker-anomaly.ts";

/** A leaf-eligible query message: the file entry it becomes is a tree
 *  row (user/assistant with a uuid; subagent traffic is filtered before
 *  the fold reaches here). */
function isLeafEligible(message: SDKMessage): boolean {
  return (
    (message.type === "user" || message.type === "assistant") &&
    message.uuid !== undefined
  );
}

/** A query message's merge rule on its `session_id` file (spec, Fold rules,
 *  sdkMessage): observe on `query`, first observations excluded from
 *  `session` per the classification; per-file usage/model evidence. */
export function foldQueryMessage(
  state: AgentState,
  message: SDKMessage,
): AgentState {
  const sessionId = message.session_id as UUID;
  let session = state.sessions[sessionId] ?? freshSessionState();
  let anomalies: readonly TrackerAnomaly[] = [];
  if (message.uuid !== undefined) {
    const uuid = message.uuid as UUID;
    if (isLeafEligible(message)) session = { ...session, pendingLeaf: uuid };
    const first = !Object.hasOwn(session.merge.nodes, uuid);
    ({ session, anomalies } = observeOn(
      session,
      "query",
      uuid,
      classOf(message),
      first && excludedFromSession(message),
    ));
  }
  if (message.type === "assistant") {
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
    withSession({ ...state, querySessionId: sessionId }, sessionId, session),
    anomalies,
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
