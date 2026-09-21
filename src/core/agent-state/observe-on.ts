import type { UUID } from "node:crypto";
import type { Result } from "neverthrow";
import {
  excludeFrom,
  type MergeError,
  type MergeStep,
  observe,
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

/** Folds one merge call's result into `session`: a failing call leaves
 *  the merge as it was and is reported; resolutions clear `pendingLeaf`
 *  and append to the session's `resolved`; a resolved node a stream
 *  skipped is a head-mismatch. */
function applyMergeStep(
  session: SessionState,
  result: Result<MergeStep<UUID, MergeStream>, MergeError>,
  className: string,
  uuid: UUID,
  stream: MergeStream,
): Observation {
  return result.match(
    (step) => {
      const skipped = step.resolved.flatMap((node) => {
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
      const pendingLeaf = step.resolved.some(
        (node) => node.id === session.pendingLeaf,
      )
        ? null
        : session.pendingLeaf;
      return {
        session: {
          ...session,
          merge: step.state,
          pendingLeaf,
          resolved: [...session.resolved, ...step.resolved],
        },
        anomalies:
          skipped.length === 0
            ? []
            : [{ kind: "head-mismatch", detail: skipped.join("; ") }],
      };
    },
    (error) => ({
      session,
      anomalies: [
        {
          kind:
            error.kind === "excluded-observed"
              ? "classification"
              : "merge-error",
          detail: `${className} ${uuid} on ${stream}: ${error.message}`,
        },
      ],
    }),
  );
}

/** One merge observation on `stream`. `excludeOther` is the caller's
 *  classification of a FIRST observation (an existing node is evidence
 *  the other stream carries the id). */
export function observeOn(
  session: SessionState,
  // TDC: what do you think of removing the remaining arguments and taking `event: AgentEvent` as an argument instead? That way we could have a central place that enforces that stream is eventStream(event), uuid is eventUuid(event), className is classOf(event), and excludeOther is some new function of event.
  stream: MergeStream,
  uuid: UUID,
  className: string,
  excludeOther: boolean,
): Observation {
  const excluded = excludeOther
    ? excludeOn(session, otherStream(stream), uuid, className)
    : { session, anomalies: [] };
  const observed = applyMergeStep(
    excluded.session,
    observe(excluded.session.merge, stream, uuid),
    className,
    uuid,
    stream,
  );
  return {
    session: observed.session,
    anomalies: [...excluded.anomalies, ...observed.anomalies],
  };
}

/** Exclude `uuid` from `stream`; resolves it when that was the last
 *  stream it awaited. */
export function excludeOn(
  session: SessionState,
  stream: MergeStream,
  uuid: UUID,
  className: string,
): Observation {
  return applyMergeStep(
    session,
    excludeFrom(session.merge, [stream], uuid),
    className,
    uuid,
    stream,
  );
}
