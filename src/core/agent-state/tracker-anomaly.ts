import type { AgentState, TrackerAnomaly } from "../protocol/index.ts";

const ANOMALY_PRECEDENCE: readonly TrackerAnomaly["kind"][] = [
  "merge-error",
  "classification",
  "head-mismatch",
];

/** A reported anomaly's `detail` names its kind, so a fold's merged
 *  report (several kinds, one detail) reads like a single one. */
export function labeledAnomaly(anomaly: TrackerAnomaly): TrackerAnomaly {
  return { kind: anomaly.kind, detail: `${anomaly.kind}: ${anomaly.detail}` };
}

/** At most one anomaly per fold: accumulates onto `state.anomaly` (this
 *  fold's earlier anomalies — `clearedForFold` runs first), kind by
 *  precedence over all, labeled details joined. */
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
    ...anomalies.map((anomaly) => labeledAnomaly(anomaly).detail),
  ].join("; ");
  return { ...state, anomaly: { kind, detail } };
}

/** What a client shows for a `trackerAnomaly` event. */
export function anomalyReport(
  anomaly: TrackerAnomaly,
  bundlePath: string,
): string {
  return `tracker anomaly ${anomaly.detail} — this shouldn't happen; details in ${bundlePath}; contact Anton (geraschenko@gmail.com) to help fix it`;
}
