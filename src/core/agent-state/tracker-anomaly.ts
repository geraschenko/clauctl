import type { AgentState } from "./agent-state.ts";

export interface TrackerAnomaly {
  readonly kind:
    | "merge-error"
    | "head-mismatch"
    | "classification"
    | "awaiting-anchor"
    | "malformed-line"
    | "follower-failure";
  /** Names the ids, streams and classes involved, the boundary (anchor),
   *  the line's byte range (malformed), or the error (follower). */
  readonly detail: string;
}

const ANOMALY_PRECEDENCE: readonly TrackerAnomaly["kind"][] = [
  "merge-error",
  "classification",
  "head-mismatch",
];

/** At most one anomaly per fold: the kind by precedence, the detail
 *  naming every condition that fired. */
export function withAnomalies(
  state: AgentState,
  anomalies: readonly TrackerAnomaly[],
): AgentState {
  if (anomalies.length === 0) return state;
  const kind =
    ANOMALY_PRECEDENCE.find((candidate) =>
      anomalies.some((anomaly) => anomaly.kind === candidate),
    ) ?? anomalies[0]!.kind;
  const detail = anomalies
    .map((anomaly) => `${anomaly.kind}: ${anomaly.detail}`)
    .join("; ");
  return { ...state, anomaly: { kind, detail } };
}
