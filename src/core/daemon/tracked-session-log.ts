/**
 * The daemon's follow of the session log across files (docs/specs/
 * session-tracker.md, "Tracked log"): owns the current SessionLogFollower +
 * SessionTracker pair, the startup scan, and the switch worker that
 * replaces both when the query moves to another file (Data flow 3) or the
 * follower fails (same-file rescan). Not on the data path itself — it
 * connects follower → tracker.push → hub.emit.
 */

import type { UUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  awaitFileExists,
  SESSION_FILE_TIMEOUT_MS,
} from "../session/await-file-exists.ts";
import { SessionLogFollower } from "../session/entry-stream.ts";
import { malformedLineMessage } from "../session/file.ts";
import type { OnInvalid } from "../tree/loader.ts";
import type { EventHub } from "./event-hub.ts";
import type { RwGate } from "./rw-gate.ts";
import { SessionTracker } from "./session-tracker.ts";

/** Quiet window on the old file before a switch (Data flow 3). */
export const SESSION_FILE_QUIET_MS = 500;

/** A CLI-written log has at most one boundary awaiting its anchor, and only
 *  until the next entry (its summary); the detail of the `awaiting-anchor`
 *  anomaly when a push leaves either expectation failed (spec, Log entries
 *  are never buffered), else undefined. */
function awaitingAnchorAnomaly(
  before: readonly UUID[],
  after: readonly UUID[],
): string | undefined {
  if (after.length > 1) {
    return `boundaries awaiting anchors: [${after.join(", ")}]`;
  }
  const stale = before.find((boundary) => after.includes(boundary));
  return stale === undefined
    ? undefined
    : `boundary ${stale} still awaiting its anchor after the next entry`;
}

export interface TrackedSessionLogDeps {
  hub: EventHub;
  /** The request gate; the switch's gated part takes it exclusively. */
  gate: RwGate;
  sessionFilePath(sessionId: UUID): string;
  onInvalid: OnInvalid;
  log(message: string): void;
}

export class TrackedSessionLog {
  private readonly deps: TrackedSessionLogDeps;
  private follower: SessionLogFollower | undefined;
  private current: SessionTracker | undefined;
  /** A switch worker is running; at most one. A flag rather than the
   *  worker's promise: the worker may finish inside its first synchronous
   *  segment, before any promise for it could be stored. */
  private workerRunning = false;
  /** The tracked file's follower failed: the next switch is a same-file
   *  rescan, entered without the settle and quiet waits. */
  private rescanNeeded = false;
  private unsubscribe: (() => void) | undefined;
  private closed = false;

  constructor(deps: TrackedSessionLogDeps) {
    this.deps = deps;
  }

  /** When the seed file exists: emit `sessionFileChanged {sessionId: seed}`,
   *  build the follower + tracker on it, scan, `scanComplete` (Data flow
   *  1). Then start the switch worker, which subscribes to the hub and runs
   *  whenever the folded state shows a defined querySessionId ≠
   *  fileSessionId. */
  start(seedSessionId: UUID | undefined): void {
    if (seedSessionId !== undefined) {
      const path = this.deps.sessionFilePath(seedSessionId);
      if (existsSync(path)) {
        this.open(seedSessionId, path);
      }
    }
    this.unsubscribe = this.deps.hub.subscribe((event) => {
      if (event.kind === "sdkMessage") {
        this.ensureWorker();
      }
    });
  }

  /** The tracked file's tracker; replaced at a switch (so handlers read it
   *  after acquiring the gate); undefined before the first file. */
  get tracker(): SessionTracker | undefined {
    return this.current;
  }

  /** The follower's drainVisibleBytes (set-context, shutdown). */
  drainVisibleBytes(): void {
    this.follower?.drainVisibleBytes();
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.follower?.close();
  }

  private ensureWorker(): void {
    if (!this.workerRunning && !this.closed) {
      void this.runWorker();
    }
  }

  /** The switch the folded state calls for: a rescan of the tracked file
   *  after a follower failure, else the query file when it is not the
   *  tracked one. */
  private switchTarget(): { sessionId: UUID; rescan: boolean } | undefined {
    const state = this.deps.hub.agentState;
    if (this.rescanNeeded && state.fileSessionId !== undefined) {
      return { sessionId: state.fileSessionId, rescan: true };
    }
    if (
      state.querySessionId !== undefined &&
      state.querySessionId !== state.fileSessionId
    ) {
      return { sessionId: state.querySessionId, rescan: false };
    }
    return undefined;
  }

  // The flag is cleared in the same synchronous segment as the last target
  // check, so a message folded meanwhile always finds either a running
  // worker that will re-check or no worker and starts one.
  private async runWorker(): Promise<void> {
    this.workerRunning = true;
    try {
      while (true) {
        const target = this.switchTarget();
        if (target === undefined || this.closed) {
          return;
        }
        const path = this.deps.sessionFilePath(target.sessionId);
        if (!target.rescan && this.follower !== undefined) {
          await Promise.race([
            this.settleAndQuiet(this.follower),
            this.follower.whenFailed(),
          ]);
          if (this.rescanNeeded) {
            continue;
          }
        }
        if (!existsSync(path)) {
          await awaitFileExists(path, SESSION_FILE_TIMEOUT_MS);
        }
        const release = await this.deps.gate.awaitExclusive();
        try {
          if (this.closed) {
            return;
          }
          this.open(target.sessionId, path);
        } finally {
          release();
        }
      }
    } catch (error) {
      this.deps.log(`session log switch failed: ${String(error)}`);
    } finally {
      this.workerRunning = false;
    }
  }

  private async settleAndQuiet(follower: SessionLogFollower): Promise<void> {
    const fileSessionId = this.deps.hub.agentState.fileSessionId;
    if (fileSessionId !== undefined) {
      await this.deps.hub
        .whenFileSettled(fileSessionId)
        .catch((error: Error) =>
          this.deps.log(
            `switching away from ${fileSessionId} unsettled: ${error.message}`,
          ),
        );
    }
    await follower.whenQuiet(SESSION_FILE_QUIET_MS);
  }

  /** The gated part of a switch: replace the pair, announce the file, scan
   *  it. A scan that cannot start leaves the file announced but
   *  unfollowed and flags a rescan for the next worker run. */
  private open(sessionId: UUID, path: string): void {
    this.follower?.close();
    const tracker = new SessionTracker(path, this.deps.onInvalid);
    this.current = tracker;
    this.rescanNeeded = false;
    this.deps.hub.emit({ kind: "sessionFileChanged", sessionId });
    let awaitingAnchors: readonly UUID[] = [];
    const follower = new SessionLogFollower(
      path,
      (parsed) => {
        const events = tracker.push(parsed);
        for (const event of events) {
          this.deps.hub.emit(event);
        }
        const pushed = events.find((event) => event.kind === "sessionEntry");
        if (pushed === undefined) {
          return;
        }
        const detail = awaitingAnchorAnomaly(
          awaitingAnchors,
          pushed.awaitingAnchors,
        );
        awaitingAnchors = pushed.awaitingAnchors;
        if (detail !== undefined) {
          this.deps.hub.emit({
            kind: "trackerAnomaly",
            anomaly: { kind: "awaiting-anchor", detail: `${path}: ${detail}` },
          });
        }
      },
      (line) =>
        this.deps.hub.emit({
          kind: "trackerAnomaly",
          anomaly: {
            kind: "malformed-line",
            detail: `${path}:${line.lineNumber}: bytes ${line.range.offset}+${line.range.length}: ${malformedLineMessage(line)}`,
          },
        }),
      (error) => this.onFollowerFailure(error),
    );
    this.follower = follower;
    try {
      follower.start();
    } catch (error) {
      this.rescanNeeded = true;
      throw error;
    }
    this.deps.hub.emit({ kind: "scanComplete" });
  }

  private onFollowerFailure(error: Error): void {
    if (this.closed) {
      return;
    }
    this.deps.hub.emit({
      kind: "trackerAnomaly",
      anomaly: { kind: "follower-failure", detail: error.message },
    });
    this.rescanNeeded = true;
    this.ensureWorker();
  }
}
