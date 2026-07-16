// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/**
 * Caller-source resolution and JSONL audit logging. Every audited clauctl
 * command appends an event to <agent-dir>/audit.jsonl attributed to a caller
 * source; metadata for pid-based sources goes to <agent-dir>/sources.jsonl.
 * Cooperative, not a security boundary — see
 * docs/specs/auditing-and-attach-tracking.md.
 */

import { readFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { auditLogPath, sourcesLogPath } from "../registry.ts";
import { type AttachmentInfo } from "./tty-server.ts";

/** "clauctl:<agent-id>" | "<comm>:<pid>" | "process:<pid>". */
export type CallerSource = string;

export interface ManagerInfo {
  pid: number;
  comm: string;
  cmdline: string[];
}

export interface AuditCommandEvent {
  ts: string;
  source: CallerSource;
  argv: string[];
}

export interface AuditAttachEvent {
  ts: string;
  source: CallerSource;
  event: "attach" | "detach";
  pid: number;
}

export type AuditEvent = AuditCommandEvent | AuditAttachEvent;

export interface SourceRecord {
  source: CallerSource;
  firstSeen: string;
  comm: string;
  cmdline: string[];
}

const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh"]);

function readProc(pid: number, file: string): string {
  return readFileSync(`/proc/${pid}/${file}`, "utf8");
}

function readCmdline(pid: number): string[] {
  return readProc(pid, "cmdline").replace(/\0+$/, "").split("\0");
}

/**
 * Ancestry walk (Linux /proc): ascend past harness shells, so fresh-shell-per-
 * call harnesses (and pipelines/subshells, whose extra shell layers are
 * skipped) derive a stable identity. Adapted from `walkToManagerPid` in
 * skills/team/team (a standalone script that cannot import from src/).
 * Interactive shells stop the walk (per-pane identity); session leadership
 * alone does not identify one — daemonized-harness tool shells are session
 * leaders too — so the stop requires a controlling tty as well. Throws when
 * /proc is unreadable (non-Linux, or a pid vanished mid-walk).
 */
function walkToManager(startPid: number): ManagerInfo {
  let pid = startPid;
  for (;;) {
    const comm = readProc(pid, "comm").trim();
    const stat = readProc(pid, "stat");
    // Parse after the last ')' to survive parens in comm; the fields there
    // are: state ppid pgrp session tty_nr ...
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const parent = Number(fields[1]);
    const sessionId = Number(fields[3]);
    const ttyNr = Number(fields[4]);
    const isInteractiveShell = sessionId === pid && ttyNr !== 0;
    if (!SHELL_NAMES.has(comm) || isInteractiveShell || parent <= 1) {
      return { pid, comm, cmdline: readCmdline(pid) };
    }
    pid = parent;
  }
}

function sourceFromAncestry(startPid: number): {
  source: CallerSource;
  manager?: ManagerInfo;
} {
  try {
    const manager = walkToManager(startPid);
    return { source: `${manager.comm}:${manager.pid}`, manager };
  } catch {
    return { source: `process:${startPid}` };
  }
}

/**
 * piAgentId wins ("clauctl:<id>", no manager); else walk /proc ancestry from
 * ppid ("<comm>:<pid>" with manager metadata); else fallback
 * ("process:<ppid>", no manager).
 */
export function resolveCallerSource(
  piAgentId: string | undefined,
  ppid: number,
): { source: CallerSource; manager?: ManagerInfo } {
  if (piAgentId !== undefined && piAgentId !== "") {
    return { source: `clauctl:${piAgentId}` };
  }
  return sourceFromAncestry(ppid);
}

/**
 * The same resolution for another live process (the daemon's view of a
 * tty.sock client): CLAUCTL_ID from /proc/<pid>/environ (the exec-time
 * environment — exactly the inherited env we want), walk from that pid's
 * ppid (from /proc/<pid>/stat). Falls back to "process:<pid>" — the hello pid
 * itself, since that is the caller — on any /proc failure, including a walk
 * that fails partway.
 */
export function resolveCallerSourceForPid(pid: number): {
  source: CallerSource;
  manager?: ManagerInfo;
} {
  try {
    const piAgentId = readProc(pid, "environ")
      .split("\0")
      .find((entry) => entry.startsWith("CLAUCTL_ID="))
      ?.slice("CLAUCTL_ID=".length);
    if (piAgentId !== undefined && piAgentId !== "") {
      return { source: `clauctl:${piAgentId}` };
    }
    const stat = readProc(pid, "stat");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const manager = walkToManager(ppid);
    return { source: `${manager.comm}:${manager.pid}`, manager };
  } catch {
    return { source: `process:${pid}` };
  }
}

/** False when env.CLAUCTL_AUDIT is "0" or "off"; true otherwise. */
export function auditEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUCTL_AUDIT !== "0" && env.CLAUCTL_AUDIT !== "off";
}

/**
 * Whether sources.jsonl already has a line for `source`. Dedup is
 * read-before-append: two concurrent first observations can both append;
 * readers dedup by source, duplicates are harmless.
 */
async function sourceRecorded(
  agentDir: string,
  source: CallerSource,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(sourcesLogPath(agentDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  for (const line of raw.split("\n")) {
    if (line === "") {
      continue;
    }
    try {
      if ((JSON.parse(line) as Partial<SourceRecord>).source === source) {
        return true;
      }
    } catch {
      // A torn or corrupt line never matches; keep scanning.
    }
  }
  return false;
}

/**
 * Append event to <agentDir>/audit.jsonl (O_APPEND; each event is a single
 * write of one line, atomic for appends of this size on local filesystems).
 * If manager is present and its source has no line in sources.jsonl yet,
 * append a SourceRecord. Callers check auditEnabled first.
 */
export async function recordAuditEvent(
  agentDir: string,
  event: AuditEvent,
  manager?: ManagerInfo,
): Promise<void> {
  await appendFile(auditLogPath(agentDir), `${JSON.stringify(event)}\n`);
  if (manager === undefined) {
    return;
  }
  if (await sourceRecorded(agentDir, event.source)) {
    return;
  }
  const record: SourceRecord = {
    source: event.source,
    firstSeen: new Date().toISOString(),
    comm: manager.comm,
    cmdline: manager.cmdline,
  };
  await appendFile(sourcesLogPath(agentDir), `${JSON.stringify(record)}\n`);
}

/**
 * Fire-and-forget attach/detach audit for the daemon's tty.sock hooks:
 * resolve the client's caller source and record the event. A no-op unless
 * enabled (the audit toggle is frozen at daemon start). Never throws and
 * never kills the daemon — failures are reported via log and otherwise
 * ignored.
 */
export function auditAttachEvent(
  agentDir: string,
  enabled: boolean,
  event: "attach" | "detach",
  info: AttachmentInfo,
  log: (message: string) => void,
): void {
  if (!enabled) {
    return;
  }
  const { source, manager } = resolveCallerSourceForPid(info.pid);
  const auditRecord = {
    ts: new Date().toISOString(),
    source,
    event,
    pid: info.pid,
  };
  void recordAuditEvent(agentDir, auditRecord, manager).catch((error) =>
    log(`${event} audit failed: ${String(error)}`),
  );
}
