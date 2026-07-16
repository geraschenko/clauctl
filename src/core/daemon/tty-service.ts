/**
 * The shared-tui service: the daemon-managed tui process (TuiHost) and the
 * tty.sock attach server (TtyServer), wired together as one unit — every
 * TtyServer hook targets the TuiHost and vice versa, so splitting them would
 * cut through a dense seam neither side survives alone. daemon.ts sees only
 * this service: start, two-phase teardown, and record-facing callbacks
 * (attachments, tui-failure) it can persist.
 *
 * Attach auditing lives here too (it hangs off the attach/detach hooks); it
 * never kills the daemon — failures are logged and otherwise ignored.
 */

import {
  recordAuditEvent,
  resolveCallerSourceForPid,
} from "../generated/audit.ts";
import { TtyServer, type AttachmentInfo } from "../generated/tty-server.ts";
import { ttySocketPath } from "../registry.ts";
import { TuiHost } from "./tui-host.ts";

export interface TtyServiceOptions {
  agentDir: string;
  cwd: string;
  env: Record<string, string>;
  sdkSocket: string;
  /** Evaluated once by daemon.ts. */
  auditEnabled: boolean;
  onAttachmentsChanged(attachments: AttachmentInfo[]): void;
  onTuiFailedChanged(failedAt: string | undefined): void;
  log(message: string): void;
}

export interface TtyService {
  /** Teardown phase 1: stop respawning, SIGTERM the tui. */
  stopTui(): void;
  /** Teardown phase 2: exit frames to attachers + close, after stream end. */
  shutdown(reason: string): Promise<void>;
}

/**
 * Spawn the managed tui and bind tty.sock. The tui is spawned before the
 * socket listen; if listen rejects, the tui is SIGTERMed and the server shut
 * down before rethrowing — the caller gets no handle to clean up with, so a
 * rejected startTtyService must not leave either resource running.
 */
export async function startTtyService(
  opts: TtyServiceOptions,
): Promise<TtyService> {
  const auditAttachEvent = (
    event: "attach" | "detach",
    info: AttachmentInfo,
  ): void => {
    if (!opts.auditEnabled) {
      return;
    }
    const { source, manager } = resolveCallerSourceForPid(info.pid);
    const auditRecord = {
      ts: new Date().toISOString(),
      source,
      event,
      pid: info.pid,
    };
    void recordAuditEvent(opts.agentDir, auditRecord, manager).catch((error) =>
      opts.log(`${event} audit failed: ${String(error)}`),
    );
  };

  // Hooks fire only once listen() succeeds, after both assignments below,
  // so they never see tuiHost unassigned.
  /* eslint-disable prefer-const -- assigned after ttyServer, but read by its hooks */
  let tuiHost: TuiHost;
  /* eslint-enable prefer-const */
  const ttyServer = new TtyServer({
    serializeScreen: () => tuiHost.serializeScreen(),
    writeInput: (data) => tuiHost.write(data),
    // The size itself is computed by TtyServer (min across attached clients).
    resize: (cols, rows) => tuiHost.resize(cols, rows),
    onAttach: (info) => {
      // A new attacher wakes a failed tui host (retries the spawn).
      tuiHost.notifyAttach();
      auditAttachEvent("attach", info);
    },
    onDetach: (info) => auditAttachEvent("detach", info),
    onAttachmentsChanged: opts.onAttachmentsChanged,
  });
  // The tui connects to sdk.sock, which the caller has listening by now.
  tuiHost = new TuiHost({
    sdkSocket: opts.sdkSocket,
    cwd: opts.cwd,
    env: opts.env,
    onOutput: (data) => ttyServer.broadcastOutput(data),
    onFailedChanged: opts.onTuiFailedChanged,
    log: opts.log,
  });
  try {
    await ttyServer.listen(ttySocketPath(opts.agentDir));
  } catch (error) {
    // listen can reject after binding (its chmod step), so the server must
    // be shut down too, not just the tui.
    tuiHost.shutdown();
    await ttyServer.shutdown("tty service failed to start");
    throw error;
  }

  return {
    stopTui: () => tuiHost.shutdown(),
    shutdown: (reason) => ttyServer.shutdown(reason),
  };
}
