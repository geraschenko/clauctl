/**
 * Placing a session file where the CLI will find it on `resume`
 * (docs/derisk/api-context-view/README.md): either a prefix copy in a
 * scratch CLAUDE_CONFIG_DIR with the mirrored config allowlist, or the
 * user's own ~/.claude with the file restored afterwards.
 */

import { spawnSync } from "node:child_process";
import type { UUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  readSessionEntries,
  sessionFilePath,
  projectKey,
  type SessionEntry,
} from "../../src/core/session/file.ts";
import { settledPrefixLengths } from "../../src/core/tree/context-check.ts";
import { baseEnv, makeConfigDir } from "./harness.ts";

const REAL_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`;

/** Parts of ~/.claude that shape the request, mirrored into the scratch
 *  dir on top of what makeConfigDir seeds. Relative to the config dir;
 *  `todos` entries are filtered by session id. */
const MIRRORED_PATHS = ["CLAUDE.md", "settings.json", "skills", "agents"];

/** A session file placed where the CLI will find it on `resume`, with the
 *  env to run the CLI in and `restore()` to undo the placement. */
export interface ResumableSession {
  /** CLI environment: scratch mode points CLAUDE_CONFIG_DIR at the scratch
   *  dir; real-config mode leaves it exactly as the user's shell has it
   *  (setting it to ~/.claude would move `.claude.json` lookup into that
   *  dir). */
  env: NodeJS.ProcessEnv;
  cwd: string;
  sessionId: UUID;
  entries: SessionEntry[];
  /** Real-config mode: truncate the session file back to its recorded
   *  length and verify against the backup. Scratch mode: no-op. */
  restore(): void;
}

/** The session's cwd and id, from the first entry carrying them. */
export function sessionIdentity(entries: SessionEntry[]): {
  cwd: string;
  sessionId: UUID;
} {
  const entry = entries.find(
    (candidate) =>
      typeof candidate.cwd === "string" &&
      typeof candidate.sessionId === "string",
  );
  if (entry === undefined) {
    throw new Error("no entry carries cwd and sessionId");
  }
  return { cwd: entry.cwd as string, sessionId: entry.sessionId as UUID };
}

/** The file's non-empty lines through the first one whose uuid is `at`
 *  (all lines when undefined). Raw lines, so the placed prefix is
 *  byte-faithful. */
export function prefixLines(
  sessionFile: string,
  at: UUID | undefined,
): string[] {
  const lines = fs
    .readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line !== "");
  if (at === undefined) {
    return lines;
  }
  const index = lines.findIndex((line) => {
    try {
      return (JSON.parse(line) as { uuid?: unknown }).uuid === at;
    } catch {
      return false;
    }
  });
  if (index === -1) {
    throw new Error(`--at ${at}: no line with that uuid in ${sessionFile}`);
  }
  return lines.slice(0, index + 1);
}

/** The main worktree's root: the CLI keys auto-memory by it, not by a
 *  linked worktree's cwd. cwd itself when not in a git repo. */
export function gitMainRoot(cwd: string): string {
  const result = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      encoding: "utf8",
    },
  );
  return result.status === 0 ? path.dirname(result.stdout.trim()) : cwd;
}

function copyIfExists(source: string, target: string): string | undefined {
  if (!fs.existsSync(source)) {
    return undefined;
  }
  fs.cpSync(source, target, { recursive: true });
  return source;
}

/** Mirror MIRRORED_PATHS, the project's memory dir and the session's todo
 *  files from the real config dir; returns what was copied. */
export function mirrorConfig(
  configDir: string,
  cwd: string,
  sessionId: UUID,
): string[] {
  const mirrored: (string | undefined)[] = MIRRORED_PATHS.map((relative) =>
    copyIfExists(
      path.join(REAL_CONFIG_DIR, relative),
      path.join(configDir, relative),
    ),
  );
  for (const root of new Set([cwd, gitMainRoot(cwd)])) {
    const memory = path.join("projects", projectKey(root), "memory");
    mirrored.push(
      copyIfExists(
        path.join(REAL_CONFIG_DIR, memory),
        path.join(configDir, memory),
      ),
    );
  }
  const todosDir = path.join(REAL_CONFIG_DIR, "todos");
  if (fs.existsSync(todosDir)) {
    fs.mkdirSync(path.join(configDir, "todos"), { recursive: true });
    for (const name of fs.readdirSync(todosDir)) {
      if (name.startsWith(sessionId)) {
        mirrored.push(
          copyIfExists(
            path.join(todosDir, name),
            path.join(configDir, "todos", name),
          ),
        );
      }
    }
  }
  return mirrored.filter((source): source is string => source !== undefined);
}

/** A prefix copy in a scratch CLAUDE_CONFIG_DIR (makeConfigDir + mirrored
 *  allowlist): the prefix of sessionFile through the first line with uuid
 *  `at` (whole file when undefined). Throws when the session's cwd does
 *  not exist: the CLI reads CLAUDE.md, git state and skills from it.
 *  Mirrored paths are logged on stderr. */
export function scratchResumableSession(
  sessionFile: string,
  at: UUID | undefined,
): ResumableSession {
  const lines = prefixLines(sessionFile, at);
  const { cwd, sessionId } = sessionIdentity(
    lines.map((line) => JSON.parse(line) as SessionEntry),
  );
  if (!fs.existsSync(cwd)) {
    throw new Error(
      `session cwd ${cwd} does not exist; the CLI reads CLAUDE.md, git state and skills from it`,
    );
  }
  const configDir = makeConfigDir(
    `api-capture-${sessionId}`,
    undefined,
    "never-expiring",
  );
  const target = sessionFilePath(configDir, cwd, sessionId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.join("\n")}\n`);
  for (const source of mirrorConfig(configDir, cwd, sessionId)) {
    console.error(`mirrored ${source}`);
  }
  return {
    env: baseEnv(configDir),
    cwd,
    sessionId,
    entries: readSessionEntries(target),
    restore: () => {},
  };
}

/** The session file in place in the user's own ~/.claude; backs it up to
 *  /tmp and records its length so restore() can truncate the CLI's
 *  appended lines back. */
export function realConfigResumableSession(
  sessionFile: string,
): ResumableSession {
  const entries = readSessionEntries(sessionFile);
  const { cwd, sessionId } = sessionIdentity(entries);
  const expected = path.resolve(
    sessionFilePath(REAL_CONFIG_DIR, cwd, sessionId),
  );
  if (path.resolve(sessionFile) !== expected) {
    throw new Error(
      `--real-config: ${sessionFile} is not the CLI's file for this session (${expected})`,
    );
  }
  const backup = `/tmp/capture-api-request-${sessionId}-${Date.now()}.jsonl`;
  fs.copyFileSync(sessionFile, backup);
  const length = fs.statSync(sessionFile).size;
  console.error(`backup ${backup} (${length} bytes)`);
  return {
    env: process.env,
    cwd,
    sessionId,
    entries,
    restore: () => {
      fs.truncateSync(sessionFile, length);
      if (!fs.readFileSync(sessionFile).equals(fs.readFileSync(backup))) {
        throw new Error(
          `${sessionFile} differs from ${backup} after truncation; restore by hand`,
        );
      }
      console.error(`restored ${sessionFile}`);
    },
  };
}

/** A prefix ending mid tool-turn or mid boundary (settledPrefixLengths) is
 *  a legitimate "what if the user typed here" state, but worth flagging. */
export function warnIfUnsettled(entries: SessionEntry[]): void {
  if (!new Set(settledPrefixLengths(entries)).has(entries.length)) {
    console.error(
      "note: the prefix is unsettled (a tool call awaits its result or a boundary its anchor)",
    );
  }
}
