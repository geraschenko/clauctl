/**
 * Diagnostic bundles for tracker anomalies (docs/specs/session-tracker.md,
 * "Anomaly bundles"): not state — the hub delegates here, the fold knows
 * nothing of it.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentState,
  TrackerAnomaly,
  AgentEvent,
} from "../protocol/index.ts";
import { isSubagentTraffic } from "../agent-state/index.ts";

/** Events of both streams kept as context for a bundle. */
export const ANOMALY_CONTEXT_EVENTS = 50;

interface EventSummary {
  kind: AgentEvent["kind"];
  type?: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  /** Assistant frames and entries: the API `message.id` (a response's
   *  blocks share it). */
  apiMessageId?: string;
  /** Entries: the file's parent link. */
  parentUuid?: string;
}

/** Stream events and subagent traffic carry no node the merge relates to
 *  anything; they would only push the useful context out of the ring. */
function isContext(event: AgentEvent): boolean {
  return (
    event.kind !== "sdkMessage" ||
    (event.message.type !== "stream_event" && !isSubagentTraffic(event.message))
  );
}

function summarize(event: AgentEvent): EventSummary {
  switch (event.kind) {
    case "sdkMessage": {
      const message = event.message as {
        type: string;
        subtype?: string;
        uuid?: string;
        session_id?: string;
        message?: { id?: string };
      };
      return {
        kind: event.kind,
        type: message.type,
        subtype: message.subtype,
        uuid: message.uuid,
        session_id: message.session_id,
        apiMessageId: message.message?.id,
      };
    }
    case "sessionEntry":
      return {
        kind: event.kind,
        type: event.entry.type,
        subtype: event.entry.subtype,
        uuid: event.entry.uuid,
        session_id: event.entry.sessionId as string | undefined,
        apiMessageId: (event.entry.message as { id?: string } | undefined)?.id,
        parentUuid: event.entry.parentUuid ?? undefined,
      };
    default:
      return { kind: event.kind };
  }
}

export class AnomalyRecorder {
  private readonly daemonDir: string;
  private readonly recent: EventSummary[] = [];

  constructor(daemonDir: string) {
    this.daemonDir = daemonDir;
  }

  /** Ring of the last ANOMALY_CONTEXT_EVENTS context events (no payloads;
   *  `isContext`). Called on every fold. */
  record(event: AgentEvent): void {
    if (!isContext(event)) return;
    this.recent.push(summarize(event));
    if (this.recent.length > ANOMALY_CONTEXT_EVENTS) {
      this.recent.shift();
    }
  }

  /** Writes `<daemonDir>/anomaly-<timestamp>.json`: the anomaly, the merge
   *  the failing fold started from (`foldInput.sessions`), the ring, and
   *  the CLI version and tracked/query session ids of `current`; returns
   *  the path. */
  write(
    anomaly: TrackerAnomaly,
    foldInput: AgentState,
    current: AgentState,
  ): string {
    const path = join(
      this.daemonDir,
      `anomaly-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    writeFileSync(
      path,
      JSON.stringify(
        {
          anomaly,
          claudeCodeVersion: current.claudeCodeVersion,
          fileSessionId: current.fileSessionId,
          querySessionId: current.querySessionId,
          sessionsBefore: foldInput.sessions,
          recentEvents: this.recent,
        },
        null,
        2,
      ),
    );
    return path;
  }
}
