import { pending } from "../../stream-merge.ts";
import type { SessionState } from "../../protocol/index.ts";
import { excludeOn, type Observation } from "./observe-on.ts";

/** `conversation_reset`: the last pending query observation not already
 *  excluded from `session` — the reset command's prompt, filed under the
 *  next session — is excluded from this file's `session`. Identity when
 *  nothing is pending. */
export function excludeResetPrompt(session: SessionState): Observation {
  const last = pending(session.merge, "query")
    .filter((id) => !session.merge.nodes[id]!.excludedFrom.includes("session"))
    .at(-1);
  return last === undefined
    ? { session, anomalies: [] }
    : excludeOn(session, "session", last, "conversation_reset");
}
