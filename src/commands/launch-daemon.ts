/** Launch the per-agent daemon; shared by `spawn` and dormant-agent revival
 *  (lifecycle.ts). */

import { spawn as spawnChild } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { Readable } from "node:stream";
import { agentDirPath, daemonLogPath } from "../core/registry.ts";
import { mainEntryPath } from "./main-entry-path.ts";

async function readAll(stream: Readable): Promise<string> {
  let data = "";
  for await (const chunk of stream) {
    data += chunk.toString();
  }
  return data;
}

/**
 * Launch the per-agent daemon: detached, stdio to daemon.log, plus a pipe on
 * fd 3 that the daemon writes a one-line ready/error message to once socket
 * is up (or startup failed).
 * Awaiting that pipe is what makes spawn exit only after the agent is actually
 * reachable — no fixed sleeps.
 *
 * Everything else the daemon needs is derived, not passed: agentDir from the
 * inherited CLAUCTL_DIR, spawn-vs-revival (and the config for each) from the
 * on-disk agent.json / spawn-options.json (see the daemon's startup
 * classification). `--ready-fd` stays a flag because it is per-launch
 * plumbing, not configuration.
 */
export async function launchDaemon(agentId: string): Promise<void> {
  const agentDir = agentDirPath(agentId);
  const logFd = openSync(daemonLogPath(agentDir), "a");
  const daemonArgs = [
    mainEntryPath(),
    "_daemon",
    "--agent-id",
    agentId,
    "--ready-fd",
    "3", // readiness pipe fd
  ];
  const child = spawnChild(process.execPath, daemonArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd, "pipe"],
  });
  closeSync(logFd);
  child.unref();

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (error) =>
      reject(new Error(`failed to start daemon: ${error.message}`)),
    );
  });
  const readyData = await Promise.race([
    readAll(child.stdio[3] as Readable),
    spawnError,
  ]);

  let ready: { ok: boolean; error?: string } | undefined;
  try {
    ready =
      readyData.trim() === ""
        ? undefined
        : (JSON.parse(readyData) as { ok: boolean; error?: string });
  } catch {
    ready = undefined;
  }
  if (!ready?.ok) {
    // Daemon-reported errors already carry the log path.
    throw new Error(
      ready?.error !== undefined
        ? `daemon failed to start: ${ready.error}`
        : `daemon failed to start: exited before signaling ready (log: ${daemonLogPath(agentDir)})`,
    );
  }
}
