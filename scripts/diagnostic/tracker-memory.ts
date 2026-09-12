/**
 * Daemon-resident memory after the startup scan of a session file
 * (docs/specs/session-tracker.md, criterion 10): the same TrackedSessionLog →
 * SessionTracker → EventHub path daemon.ts runs at start, with no
 * subscribers, then heapUsed after a forced GC. Anomalies the scan raises
 * are tallied by kind (a falsifier run on a real log). Read-only. Usage:
 *   node --expose-gc scripts/diagnostic/tracker-memory.ts <session.jsonl>...
 */

import type { UUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { initialAgentState } from "../../src/core/agent-state.ts";
import { AnomalyRecorder } from "../../src/core/daemon/anomaly-bundle.ts";
import { EventHub } from "../../src/core/daemon/event-hub.ts";
import { RwGate } from "../../src/core/daemon/rw-gate.ts";
import { TrackedSessionLog } from "../../src/core/daemon/tracked-session-log.ts";

const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;

const forceGc = globalThis.gc;
const files = process.argv.slice(2);
if (forceGc === undefined || files.length === 0) {
  console.error(
    "usage: node --expose-gc scripts/diagnostic/tracker-memory.ts <session.jsonl>...",
  );
  process.exit(2);
}

function heapUsedAfterGc(): number {
  forceGc!();
  return process.memoryUsage().heapUsed;
}

for (const file of files) {
  const bundleDir = mkdtempSync(join(tmpdir(), "tracker-memory-"));
  const baseline = heapUsedAfterGc();
  const anomalyCounts = new Map<string, number>();
  const hub: EventHub = new EventHub({
    seed: initialAgentState(),
    deliver: () => {},
    tracker: () => trackedLog.tracker,
    log: (message) => console.error(`  ${message}`),
    anomalies: new AnomalyRecorder(bundleDir),
  });
  const trackedLog: TrackedSessionLog = new TrackedSessionLog({
    hub,
    gate: new RwGate(),
    sessionFilePath: () => file,
    onInvalid: (message) => console.error(`  invalid: ${message}`),
    log: (message) => console.error(`  ${message}`),
  });
  hub.subscribe((event) => {
    if (event.kind === "trackerAnomaly") {
      const count = anomalyCounts.get(event.anomaly.kind) ?? 0;
      anomalyCounts.set(event.anomaly.kind, count + 1);
    }
  });
  const started = performance.now();
  trackedLog.start(basename(file, ".jsonl") as UUID);
  const elapsedMs = performance.now() - started;
  const resident = heapUsedAfterGc() - baseline;
  const tracker = trackedLog.tracker;
  console.log(file);
  console.log(
    `  ${tracker?.index.size ?? 0} entries, scan ${elapsedMs.toFixed(0)} ms, ` +
      `resident ${mb(resident)} (heapUsed ${mb(baseline)} → ${mb(baseline + resident)})`,
  );
  console.log(
    `  anomalies: ${anomalyCounts.size === 0 ? "none" : [...anomalyCounts].map(([kind, count]) => `${kind}=${count}`).join(", ")}`,
  );
  trackedLog.close();
  rmSync(bundleDir, { recursive: true, force: true });
}
