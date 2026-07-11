/**
 * The agent registry is a directory of agent dirs: $CLAUCTL_DIR/<agentId>/ with
 * agent.json (written only by the daemon), sdk.sock, daemon.log, the
 * audit.jsonl/sources.jsonl audit logs (generated/audit.ts), and optionally
 * a tombstone file marking the dir for gc.
 */

import { open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import envPaths from "env-paths";
import type { PersistedOptions } from "./options.ts";
import { fileExists } from "./generated/util.ts";

export interface SessionHistoryEntry {
  sessionId: string;
  /** $CLAUDE_CONFIG_DIR/projects/<cwd>/<sessionId>.jsonl — for Phase-3 tail. */
  sessionFile: string;
}

export interface AgentRecord {
  id: string;
  createdAt: string;
  cwd: string;
  /** Optional label set at spawn (`--tag`); non-unique, for grouping. */
  tag?: string;

  /** Bucket-1 Options, serializable; mutated in place by the DECISION-5 merge. */
  persistedOptions: PersistedOptions;

  /** Full history, dedup-on-reannounce. currentSessionId = last entry. */
  sessions: SessionHistoryEntry[];

  daemonPid: number;
  /** child `claude` pid — best-effort, not on the Query surface; never depended on. */
  claudePid?: number;
  /** claude_code_version from system/init; respawn-across-upgrade diagnostics (RISK-6). */
  claudeCodeVersion?: string;

  /**
   * The agent's own directory. Derived from the path, not persisted: populated
   * by readAgentRecord and stripped by writeAgentRecord (see there).
   */
  agentDir: string;
}

export function clauctlBaseDir(): string {
  // env-paths picks the per-OS user data dir (~/.local/share/clauctl on Linux,
  // ~/Library/Application Support/clauctl on macOS, %LOCALAPPDATA%\clauctl on
  // Windows). suffix:"" suppresses its default "-nodejs" project-name suffix.
  return process.env.CLAUCTL_DIR ?? envPaths("clauctl", { suffix: "" }).data;
}

/** The agent's own directory within the registry. */
export function agentDirPath(agentId: string): string {
  return join(clauctlBaseDir(), agentId);
}

/**
 * An agent id becomes a single path segment under the registry dir (and is
 * embedded in the socket path), so a user-supplied `--id` must be one safe
 * component: no path separators and not `.`/`..`, which would otherwise escape
 * the registry. The default (randomUUID) always passes; this guards explicit
 * ids. Returns a human-readable error, or undefined if the id is acceptable.
 */
export function agentIdError(agentId: string): string | undefined {
  if (
    !/^[A-Za-z0-9._-]+$/.test(agentId) ||
    agentId === "." ||
    agentId === ".."
  ) {
    return (
      `invalid agent id '${agentId}': use only letters, digits, '.', '_', ` +
      `and '-' (no path separators)`
    );
  }
  return undefined;
}

export function agentJsonPath(agentDir: string): string {
  return join(agentDir, "agent.json");
}

export function sdkSocketPath(agentDir: string): string {
  return join(agentDir, "sdk.sock");
}

/**
 * Transient spawn handoff: `spawn` writes the parsed bucket-1 options here and
 * the daemon folds them into the agent.json it writes (preserving "daemon is
 * the sole agent.json writer"), then removes the file. Its presence also
 * classifies daemon startup: agent.json present → revival (a present spawn
 * file is stale and deleted); otherwise this file present → initial spawn;
 * otherwise startup fails.
 */
export function spawnOptionsPath(agentDir: string): string {
  return join(agentDir, "spawn-options.json");
}

/** Field names mirror AgentRecord; the daemon folds these into agent.json. */
export interface SpawnOptions {
  cwd: string;
  /** Optional label set at spawn (`--tag`). */
  tag?: string;
  persistedOptions: PersistedOptions;
  /** Initial-spawn session wrap (`--resume <session-id>`), bucket-4 exception. */
  resume?: string;
}

export async function writeSpawnOptions(
  agentDir: string,
  options: SpawnOptions,
): Promise<void> {
  // Plain writeFile — the daemon (the only reader) is launched after this.
  await writeFile(
    spawnOptionsPath(agentDir),
    `${JSON.stringify(options, null, "\t")}\n`,
  );
}

export type SpawnOptionsReadResult =
  | { kind: "ok"; options: SpawnOptions }
  | { kind: "missing" }
  | { kind: "corrupt"; error: string };

export async function readSpawnOptions(
  agentDir: string,
): Promise<SpawnOptionsReadResult> {
  let raw: string;
  try {
    raw = await readFile(spawnOptionsPath(agentDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "corrupt", error: String(error) };
  }
  try {
    const options = JSON.parse(raw) as SpawnOptions;
    if (
      typeof options.cwd !== "string" ||
      typeof options.persistedOptions !== "object" ||
      options.persistedOptions === null
    ) {
      return {
        kind: "corrupt",
        error: "spawn-options.json missing required fields",
      };
    }
    return { kind: "ok", options };
  } catch (error) {
    return {
      kind: "corrupt",
      error: `spawn-options.json is not valid JSON: ${String(error)}`,
    };
  }
}

/**
 * Unix socket paths must fit in sockaddr_un.sun_path including its NUL
 * terminator: 108 bytes on Linux, 104 on macOS/BSD. The daemon binds sdk.sock
 * under agentDir; if it would not fit, the bind later fails with an opaque
 * `EINVAL: invalid argument`. Returns a human-readable error describing the
 * overflow and how to fix it, or undefined if the socket fits. Pure; platform
 * is injectable for testing.
 */
export function socketPathLengthError(
  agentDir: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const limit = platform === "linux" ? 108 : 104;
  const longest = sdkSocketPath(agentDir);
  const needed = Buffer.byteLength(longest) + 1; // + NUL terminator
  if (needed <= limit) return undefined;
  return (
    `socket path is too long for this OS: "${longest}" needs ${needed} bytes ` +
    `(including NUL terminator) but the limit is ${limit}. ` +
    `Use a shorter --id, or set CLAUCTL_DIR to a shorter directory.`
  );
}

export function tombstonePath(agentDir: string): string {
  return join(agentDir, "tombstone");
}

/**
 * Marks an agent as archived: a dormant agent the user is done with, hidden
 * from `list` by default but kept and revivable. A marker file (not a field in
 * daemon-owned agent.json) so the CLI can set it without racing the daemon.
 */
export function archivedPath(agentDir: string): string {
  return join(agentDir, "archived");
}

/** Serializes dormant-agent revival; holds the reviving process's pid. */
export function reviveLockPath(agentDir: string): string {
  return join(agentDir, "revive.lock");
}

export function daemonLogPath(agentDir: string): string {
  return join(agentDir, "daemon.log");
}

/** Audited-command events, appended as JSONL (generated/audit.ts). */
export function auditLogPath(agentDir: string): string {
  return join(agentDir, "audit.jsonl");
}

/** Metadata for observed pid-based caller sources, appended as JSONL. */
export function sourcesLogPath(agentDir: string): string {
  return join(agentDir, "sources.jsonl");
}

export type AgentRecordReadResult =
  | { kind: "ok"; record: AgentRecord }
  | { kind: "missing" }
  | { kind: "corrupt"; error: string };

export async function readAgentRecord(
  agentDir: string,
): Promise<AgentRecordReadResult> {
  let raw: string;
  try {
    raw = await readFile(agentJsonPath(agentDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "corrupt", error: String(error) };
  }
  try {
    const record = JSON.parse(raw) as AgentRecord;
    if (
      typeof record.id !== "string" ||
      typeof record.daemonPid !== "number" ||
      !Array.isArray(record.sessions) ||
      typeof record.persistedOptions !== "object" ||
      record.persistedOptions === null
    ) {
      return { kind: "corrupt", error: "agent.json missing required fields" };
    }
    record.agentDir = agentDir;
    return { kind: "ok", record };
  } catch (error) {
    return {
      kind: "corrupt",
      error: `agent.json is not valid JSON: ${String(error)}`,
    };
  }
}

/**
 * Atomic write: write + fsync a temp file, then rename over the target.
 * Without the fsync a crash shortly after rename can leave an empty file on
 * some filesystems; with it, readers see either the old or the new content.
 *
 * agentDir is derived from the path (readAgentRecord repopulates it), so it is
 * stripped from the persisted JSON rather than duplicated into the file.
 */
export async function writeAgentRecord(record: AgentRecord): Promise<void> {
  const { agentDir, ...persisted } = record;
  const target = agentJsonPath(agentDir);
  const tmp = `${target}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(persisted, null, "\t")}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
}

export async function listAgentIds(prefix = ""): Promise<string[]> {
  try {
    // Node's directory APIs do not support prefix-filtered reads, so dynamic
    // completion still scans the flat registry directory and filters locally.
    const entries = await readdir(clauctlBaseDir(), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Resolve an agent id, exact or as a unique prefix — to a full agent id. An
 * ambiguous prefix is an error listing the candidates, never a guess.
 */
export async function resolveAgentId(agentIdPrefix: string): Promise<string> {
  const agentIds = await listAgentIds();
  if (agentIds.includes(agentIdPrefix)) {
    return agentIdPrefix;
  }
  const matches = agentIds.filter((agentId) =>
    agentId.startsWith(agentIdPrefix),
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous agent id '${agentIdPrefix}', candidates:\n  ${matches.join("\n  ")}`,
    );
  }
  throw new Error(`no agent matches '${agentIdPrefix}'`);
}

/** Resolve an agent id and read its record (with agentDir populated). */
export async function loadAgent(agentIdPrefix: string): Promise<AgentRecord> {
  const agentId = await resolveAgentId(agentIdPrefix);
  const read = await readAgentRecord(agentDirPath(agentId));
  if (read.kind !== "ok") {
    throw new Error(
      read.kind === "missing"
        ? `agent '${agentId}' has no agent.json (failed spawn?); run \`clauctl gc\``
        : `agent '${agentId}' has a corrupt agent.json: ${read.error}; run \`clauctl gc\``,
    );
  }
  return read.record;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent's status as far as on-disk markers and the daemon pid can tell —
 * no socket involved. A live daemon is reported as `running`; distinguishing
 * live assistant state needs the Phase-2 sdk.sock probe. gc only needs the
 * socket-free verdict, so it uses this directly.
 */
export type RegistryStatus =
  | { kind: "tombstoned" }
  | { kind: "corrupt"; error: string }
  | { kind: "archived"; record: AgentRecord }
  | { kind: "dormant"; record: AgentRecord }
  | { kind: "running"; record: AgentRecord };

export async function classifyAgentDir(
  agentId: string,
): Promise<RegistryStatus> {
  const agentDir = agentDirPath(agentId);
  if (await fileExists(tombstonePath(agentDir))) {
    return { kind: "tombstoned" };
  }
  const read = await readAgentRecord(agentDir);
  if (read.kind !== "ok") {
    return {
      kind: "corrupt",
      error: read.kind === "missing" ? "no agent.json" : read.error,
    };
  }
  const record = read.record;
  if (!isPidAlive(record.daemonPid)) {
    return (await fileExists(archivedPath(agentDir)))
      ? { kind: "archived", record }
      : { kind: "dormant", record };
  }
  return { kind: "running", record };
}
