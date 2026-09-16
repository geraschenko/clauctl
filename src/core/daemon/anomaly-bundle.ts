/**
 * Diagnostic bundles for tracker anomalies (docs/specs/session-tracker.md,
 * "Anomaly bundles"): not state — the hub delegates here, the fold knows
 * nothing of it.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentState, TrackerAnomaly } from "../agent-state.ts";
import type { AgentEvent } from "../protocol.ts";

/** Events of both streams kept as context for a bundle. */
export const ANOMALY_CONTEXT_EVENTS = 50;

interface EventSummary {
  kind: AgentEvent["kind"];
  type?: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
}

function summarize(event: AgentEvent): EventSummary {
  switch (event.kind) {
    case "sdkMessage": {
      const message = event.message as {
        type: string;
        subtype?: string;
        uuid?: string;
        session_id?: string;
      };
      return {
        kind: event.kind,
        type: message.type,
        subtype: message.subtype,
        uuid: message.uuid,
        session_id: message.session_id,
      };
    }
    case "sessionEntry":
      return {
        kind: event.kind,
        type: event.entry.type,
        subtype: event.entry.subtype,
        uuid: event.entry.uuid,
        session_id: event.entry.sessionId as string | undefined,
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

  /** Ring of the last ANOMALY_CONTEXT_EVENTS events (no payloads). Called on
   *  every fold. */
  record(event: AgentEvent): void {
    this.recent.push(summarize(event));
    if (this.recent.length > ANOMALY_CONTEXT_EVENTS) {
      this.recent.shift();
    }
  }

  /** Writes `<daemonDir>/anomaly-<timestamp>.json`: the anomaly, the merge
   *  state before the failing fold (`before.sessions`), the ring, the CLI
   *  version and the tracked/query session ids; returns the path. */
  write(
    anomaly: TrackerAnomaly,
    before: AgentState,
    after: AgentState,
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
          claudeCodeVersion: after.claudeCodeVersion,
          fileSessionId: after.fileSessionId,
          querySessionId: after.querySessionId,
          sessionsBefore: before.sessions,
          recentEvents: this.recent,
        },
        null,
        2,
      ),
    );
    return path;
  }
}
