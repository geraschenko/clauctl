import type { UUID } from "node:crypto";
import type { Result } from "neverthrow";
import {
  excludeFrom,
  type MergeError,
  type MergeStep,
  observe,
  type Resolved,
} from "../stream-merge.ts";
import {
  MERGE_STREAMS,
  type MergeStream,
  type SessionState,
} from "./session-state.ts";
import type { TrackerAnomaly } from "./tracker-anomaly.ts";

const otherStream = (stream: MergeStream): MergeStream =>
  stream === "query" ? "session" : "query";

export interface Observation {
  readonly session: SessionState;
  readonly anomalies: readonly TrackerAnomaly[];
}

/** One merge observation on `file`. `excludeOther` is the caller's
 *  classification of a FIRST observation (an existing node is evidence
 *  the other stream carries the id); a failing merge call leaves the
 *  merge as it was and is reported. Resolutions clear `pendingLeaf`; a
 *  resolved node a stream skipped is a head-mismatch. */
export function observeOn(
  session: SessionState,
  stream: MergeStream,
  uuid: UUID,
  className: string,
  excludeOther: boolean,
): Observation {
  const anomalies: TrackerAnomaly[] = [];
  const resolved: Resolved<UUID, MergeStream>[] = [];
  let merge = session.merge;
  const apply = (
    result: Result<MergeStep<UUID, MergeStream>, MergeError>,
  ): void =>
    result.match(
      (step) => {
        merge = step.state;
        resolved.push(...step.resolved);
      },
      (error) => {
        anomalies.push({
          kind:
            error.kind === "excluded-observed"
              ? "classification"
              : "merge-error",
          detail: `${className} ${uuid} on ${stream}: ${error.message}`,
        });
      },
    );
  if (excludeOther) apply(excludeFrom(merge, [otherStream(stream)], uuid));
  apply(observe(merge, stream, uuid));
  const skipped = resolved.flatMap((node) => {
    const missing = MERGE_STREAMS.filter(
      (name) =>
        !node.seenOn.includes(name) && !node.excludedFrom.includes(name),
    );
    return missing.length === 0
      ? []
      : [
          `${node.id} seen on ${node.seenOn.join(",")}, skipped by ${missing.join(",")}`,
        ];
  });
  if (skipped.length > 0) {
    anomalies.push({ kind: "head-mismatch", detail: skipped.join("; ") });
  }
  const pendingLeaf = resolved.some((node) => node.id === session.pendingLeaf)
    ? null
    : session.pendingLeaf;
  return { session: { ...session, merge, pendingLeaf }, anomalies };
}
