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

/** At most one anomaly per fold: accumulates onto `state.anomaly` (this
 *  fold's earlier anomalies — `clearedForFold` runs first), kind by
 *  precedence over all, details joined. */
export function withAnomalies(
  state: AgentState,
  anomalies: readonly TrackerAnomaly[],
): AgentState {
  if (anomalies.length === 0) return state;
  const kinds = [
    ...(state.anomaly === undefined ? [] : [state.anomaly.kind]),
    ...anomalies.map((anomaly) => anomaly.kind),
  ];
  const kind =
    ANOMALY_PRECEDENCE.find((candidate) => kinds.includes(candidate)) ??
    kinds[0]!;
  const detail = [
    ...(state.anomaly === undefined ? [] : [state.anomaly.detail]),
    ...anomalies.map((anomaly) => `${anomaly.kind}: ${anomaly.detail}`),
  ].join("; ");
  return { ...state, anomaly: { kind, detail } };
}
