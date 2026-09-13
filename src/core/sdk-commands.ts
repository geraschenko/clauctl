/**
 * The full `Query` passthrough (DECISION-4): every Query method as a flat
 * kebab-case subcommand — the daemon's mapping site documents the three
 * exclusions — plus the client-side `resolve-settings`. Turn submission
 * lives in prompt.ts.
 *
 * Every subcommand takes the agent as --target (reviving a dormant agent
 * transparently), sends one request over the agent's sdk.sock, and prints the
 * response data as JSON if there is any.
 */

import type { UUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import {
  booleanFlag,
  commandNoTarget,
  commandOneTarget,
  completeChoices,
  enumFlag,
  parsedFlag,
  restArgs,
  stringArg,
  stringFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { oneTarget, type CommandContext } from "./generated/targets.ts";
import { ensureAgentRunning } from "./lifecycle.ts";
import { parseMcpConfig } from "./options.ts";
import { sdkSocketPath } from "./registry.ts";
import {
  connectWithRetry,
  parseSetContextRequest,
  type GetContextResponse,
  type EntryPayload,
  type FlagSettings,
  type SdkRequest,
  type SdkSocketClient,
  type GetEntriesResponse,
  type SetContextRequest,
} from "./sdk-socket.ts";
import {
  formatTreeNodeRef,
  resolveTreeNodeRef,
  type TreeNodeRef,
} from "./tree/nodes.ts";
import {
  isUuidPrefix,
  parseUuidPrefixFlag,
  resolveUuidPrefix,
  UUID_PATTERN,
} from "./uuid.ts";
import { oneOf, UsageError } from "./generated/util.ts";
import { SOCKET_CONNECT_DEADLINE_MS } from "./generated/constants.ts";

const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const;

/** Revive/connect to the target and run `fn` against the open connection —
 *  the seam that lets one invocation issue several requests (uuid-prefix
 *  resolution needs a get-entries before the real request). */
async function withClient<T>(
  context: CommandContext,
  fn: (client: SdkSocketClient) => Promise<T>,
): Promise<T> {
  const agent = await ensureAgentRunning(oneTarget(context).id);
  const client = await connectWithRetry(
    sdkSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function requestData(
  context: CommandContext,
  request: SdkRequest,
): Promise<unknown> {
  return withClient(context, (client) => client.request(request));
}

function printData(context: CommandContext, data: unknown): void {
  if (data !== undefined) {
    context.process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
}

async function sendRequest(
  context: CommandContext,
  request: SdkRequest,
): Promise<void> {
  printData(context, await requestData(context, request));
}

/** The current session's entry uuids (one get-entries request) — the
 *  resolution universe for unique uuid prefixes. Prefix acceptance is CLI
 *  ergonomics only: the wire protocol carries full uuids. */
export async function sessionEntryUuids(
  client: SdkSocketClient,
): Promise<ReadonlySet<UUID>> {
  const snapshot = (await client.request({
    type: "get-entries",
    payload: "uuids",
  })) as GetEntriesResponse;
  return new Set(snapshot.uuids);
}

const payloadFlag = booleanFlag(
  "Print identities only (no entry payloads); the daemon reads nothing from the session file",
);

const entryPayload = (uuidsOnly: boolean | undefined): EntryPayload =>
  uuidsOnly === true ? "uuids" : "full";

/** `text` as a node ref (`<uuid>` or `<uuid>@<boundary-uuid>`, unique
 *  prefixes resolved against `sessionUuids`); a UsageError names `flagName`
 *  on any failure. */
function resolveNodeRefText(
  text: string,
  flagName: string,
  sessionUuids: ReadonlySet<UUID>,
): TreeNodeRef {
  try {
    return resolveTreeNodeRef(text, sessionUuids);
  } catch (error) {
    throw new UsageError(
      `${flagName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A target-taking subcommand whose request needs no arguments. */
function bareRequestCommand(
  brief: string,
  request: SdkRequest,
  audited?: true,
) {
  return commandOneTarget({
    docs: { brief },
    ...(audited && { audited }),
    func: async function (this: CommandContext): Promise<void> {
      await sendRequest(this, request);
    },
  });
}

// --- mutation arguments --------------------------------------------------------

const setModelFlags = {
  model: stringFlag("Model (omit to reset to default)", "model"),
};

type SetModelFlags = InferFlags<typeof setModelFlags>;

async function setModel(
  this: CommandContext,
  flags: SetModelFlags,
): Promise<void> {
  await sendRequest(this, {
    type: "set-model",
    ...(flags.model !== undefined && { model: flags.model }),
  });
}

async function setPermissionMode(
  this: CommandContext,
  _flags: Record<never, never>,
  mode: string,
): Promise<void> {
  await sendRequest(this, {
    type: "set-permission-mode",
    mode: oneOf(mode, PERMISSION_MODES, "mode"),
  });
}

const MCP_OVERRIDE_MODES = ["default", "auto", "clear"] as const;

async function setMcpPermissionModeOverride(
  this: CommandContext,
  _flags: Record<never, never>,
  serverName: string,
  mode: string,
): Promise<void> {
  const parsed = oneOf(mode, MCP_OVERRIDE_MODES, "mode");
  await sendRequest(this, {
    type: "set-mcp-permission-mode-override",
    serverName,
    mode: parsed === "clear" ? null : parsed,
  });
}

const THINKING_DISPLAYS = ["summarized", "omitted", "clear"] as const;

const setMaxThinkingTokensFlags = {
  thinkingDisplay: enumFlag(
    "Thinking display for the rest of the session ('clear' resets to the API default)",
    THINKING_DISPLAYS,
  ),
};

type SetMaxThinkingTokensFlags = InferFlags<typeof setMaxThinkingTokensFlags>;

async function setMaxThinkingTokens(
  this: CommandContext,
  flags: SetMaxThinkingTokensFlags,
  tokens: string,
): Promise<void> {
  let maxThinkingTokens: number | null;
  if (tokens === "clear") {
    maxThinkingTokens = null;
  } else {
    maxThinkingTokens = Number(tokens);
    if (!Number.isFinite(maxThinkingTokens) || maxThinkingTokens < 0) {
      throw new UsageError(
        `expected a non-negative token count or 'clear', got '${tokens}'`,
      );
    }
  }
  await sendRequest(this, {
    type: "set-max-thinking-tokens",
    maxThinkingTokens,
    ...(flags.thinkingDisplay !== undefined && {
      thinkingDisplay:
        flags.thinkingDisplay === "clear" ? null : flags.thinkingDisplay,
    }),
  });
}

/** Inline-JSON-or-file settings argument (apply-flag-settings, update-settings). */
function parseSettingsArg(value: string): Record<string, unknown> {
  const raw = value.trimStart().startsWith("{")
    ? value
    : readFileSync(value, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`settings is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("settings must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function applyFlagSettings(
  this: CommandContext,
  _flags: Record<never, never>,
  settings: string,
): Promise<void> {
  await sendRequest(this, {
    type: "apply-flag-settings",
    settings: parseSettingsArg(settings) as FlagSettings,
  });
}

const SETTINGS_SOURCES = ["localSettings"] as const;

async function updateSettings(
  this: CommandContext,
  _flags: Record<never, never>,
  source: string,
  settings: string,
): Promise<void> {
  await sendRequest(this, {
    type: "update-settings",
    source: oneOf(source, SETTINGS_SOURCES, "source"),
    settings: parseSettingsArg(settings),
  });
}

async function setMcpServers(
  this: CommandContext,
  _flags: Record<never, never>,
  servers: string,
): Promise<void> {
  await sendRequest(this, {
    type: "set-mcp-servers",
    servers: parseMcpConfig(servers, "servers"),
  });
}

async function toggleMcpServer(
  this: CommandContext,
  _flags: Record<never, never>,
  serverName: string,
  enabled: string,
): Promise<void> {
  await sendRequest(this, {
    type: "toggle-mcp-server",
    serverName,
    enabled:
      oneOf(enabled, ["enabled", "disabled"] as const, "enabled") === "enabled",
  });
}

async function reconnectMcpServer(
  this: CommandContext,
  _flags: Record<never, never>,
  serverName: string,
): Promise<void> {
  await sendRequest(this, { type: "reconnect-mcp-server", serverName });
}

async function stopTask(
  this: CommandContext,
  _flags: Record<never, never>,
  taskId: string,
): Promise<void> {
  await sendRequest(this, { type: "stop-task", taskId });
}

const backgroundTasksFlags = {
  toolUseId: stringFlag(
    "Target the single task started by this tool_use",
    "id",
  ),
};

type BackgroundTasksFlags = InferFlags<typeof backgroundTasksFlags>;

async function backgroundTasks(
  this: CommandContext,
  flags: BackgroundTasksFlags,
): Promise<void> {
  await sendRequest(this, {
    type: "background-tasks",
    ...(flags.toolUseId !== undefined && { toolUseId: flags.toolUseId }),
  });
}

const rewindFilesFlags = {
  dryRun: booleanFlag("Preview changes without modifying files"),
};

type RewindFilesFlags = InferFlags<typeof rewindFilesFlags>;

async function rewindFiles(
  this: CommandContext,
  flags: RewindFilesFlags,
  userMessageId: string,
): Promise<void> {
  if (!isUuidPrefix(userMessageId)) {
    throw new UsageError(`invalid uuid or uuid prefix: '${userMessageId}'`);
  }
  await withClient(this, async (client) => {
    const resolved = UUID_PATTERN.test(userMessageId)
      ? userMessageId
      : resolveUuidPrefix(userMessageId, await sessionEntryUuids(client));
    printData(
      this,
      await client.request({
        type: "rewind-files",
        userMessageId: resolved,
        ...(flags.dryRun && { dryRun: true }),
      }),
    );
  });
}

async function seedReadState(
  this: CommandContext,
  _flags: Record<never, never>,
  path: string,
  mtime: string,
): Promise<void> {
  const parsed = Number(mtime);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`expected an mtime in floored ms, got '${mtime}'`);
  }
  await sendRequest(this, { type: "seed-read-state", path, mtime: parsed });
}

// --- set-context ----------------------------------------------------------------

const setContextFlags = {
  summary: stringFlag(
    "Summary text written as the compact summary (context reads summary first, then uuids)",
    "text",
  ),
  rewindTo: stringFlag(
    "Rewind to this tree node — <uuid> or <uuid>@<boundary-uuid> for an occurrence inside that boundary's context (unique prefixes accepted); positional uuids are appended after its context",
    "node-ref",
  ),
  empty: booleanFlag("Reset the context to empty (keep no messages)"),
};

type SetContextFlags = InferFlags<typeof setContextFlags>;

async function setContext(
  this: CommandContext,
  flags: SetContextFlags,
  ...uuids: string[]
): Promise<void> {
  // The daemon re-validates; failing malformed invocations here (flag-named
  // mode conflicts, then uuid/prefix syntax) avoids a pointless daemon
  // revival. Prefix RESOLUTION needs the session's entry uuids, so it runs
  // after connecting, on the same connection as the request.
  if (
    flags.rewindTo !== undefined &&
    (flags.summary !== undefined || flags.empty)
  ) {
    throw new UsageError(
      "--rewind-to is mutually exclusive with --summary/--empty",
    );
  }
  if (flags.empty && (uuids.length > 0 || flags.summary !== undefined)) {
    // Summary-only context is already expressible via --summary alone.
    throw new UsageError(
      "--empty is mutually exclusive with uuids/--summary/--rewind-to",
    );
  }
  if (
    !flags.empty &&
    flags.rewindTo === undefined &&
    uuids.length === 0 &&
    flags.summary === undefined
  ) {
    // --summary alone is valid: empty uuids + a summary is the deliberate
    // summary-only context (the boundary preserves nothing). --empty is the
    // only way to send an empty list with no summary — the wire accepts it,
    // but a bare invocation is more likely a fat-finger than a reset.
    throw new UsageError(
      "expected message uuids, --summary, --rewind-to, or --empty",
    );
  }
  const rewindHalves = flags.rewindTo?.split("@") ?? [];
  if (
    flags.rewindTo !== undefined &&
    (rewindHalves.length > 2 ||
      rewindHalves.some((half) => !isUuidPrefix(half)))
  ) {
    throw new UsageError(
      `--rewind-to expects "<uuid>" or "<uuid>@<boundary-uuid>" (unique ` +
        `prefixes accepted), got '${flags.rewindTo}'`,
    );
  }
  for (const uuid of uuids) {
    if (!isUuidPrefix(uuid)) {
      throw new UsageError(`invalid uuid or uuid prefix: '${uuid}'`);
    }
  }

  const buildRequest = (
    rewindTo: TreeNodeRef | undefined,
    fullUuids: readonly string[],
  ): SetContextRequest => {
    try {
      return parseSetContextRequest(
        rewindTo !== undefined
          ? {
              rewindTo,
              ...(fullUuids.length > 0 && { append: [...fullUuids] }),
            }
          : {
              uuids: flags.empty ? [] : [...fullUuids],
              ...(flags.summary !== undefined && {
                summaryText: flags.summary,
              }),
            },
      );
    } catch (error) {
      throw new UsageError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const needsResolution = [...uuids, ...rewindHalves].some(
    (ref) => !UUID_PATTERN.test(ref),
  );
  if (!needsResolution) {
    await sendRequest(
      this,
      buildRequest(
        flags.rewindTo === undefined
          ? undefined
          : resolveNodeRefText(flags.rewindTo, "--rewind-to", new Set()),
        uuids,
      ),
    );
    return;
  }
  await withClient(this, async (client) => {
    const sessionUuids = await sessionEntryUuids(client);
    const request = buildRequest(
      flags.rewindTo === undefined
        ? undefined
        : resolveNodeRefText(flags.rewindTo, "--rewind-to", sessionUuids),
      uuids.map((uuid) =>
        UUID_PATTERN.test(uuid) ? uuid : resolveUuidPrefix(uuid, sessionUuids),
      ),
    );
    printData(this, await client.request(request));
  });
}

// --- reads with arguments ------------------------------------------------------

const getContextFlags = {
  at: stringFlag(
    "Context at this tree node instead of the current leaf — <uuid> or <uuid>@<boundary-uuid> for an occurrence inside that boundary's context (unique prefixes accepted)",
    "node-ref",
  ),
  uuids: payloadFlag,
};

type GetContextFlags = InferFlags<typeof getContextFlags>;

async function getContext(
  this: CommandContext,
  flags: GetContextFlags,
): Promise<void> {
  await withClient(this, async (client) => {
    const at =
      flags.at === undefined
        ? undefined
        : resolveNodeRefText(
            flags.at,
            "--at",
            flags.at.split("@").every((half) => UUID_PATTERN.test(half))
              ? new Set()
              : await sessionEntryUuids(client),
          );
    const slice = (await client.request({
      type: "get-context",
      ...(at !== undefined && { at }),
      payload: entryPayload(flags.uuids),
    })) as GetContextResponse;
    const lines =
      slice.entries === undefined
        ? slice.refs.map(formatTreeNodeRef)
        : slice.entries.map((entry) => JSON.stringify(entry));
    for (const line of lines) {
      this.process.stdout.write(`${line}\n`);
    }
  });
}

const getContextUsageFlags = {
  detail: enumFlag(
    "'full' (default) counts each category via the token-count API; 'summary' uses the last response's usage and local estimates",
    ["summary", "full"] as const,
  ),
};

const getEntriesFlags = {
  since: parsedFlag(
    "Only the entries after this session-entry uuid (any unique prefix)",
    parseUuidPrefixFlag,
    "uuid",
  ),
  uuids: payloadFlag,
};

type GetEntriesFlags = InferFlags<typeof getEntriesFlags>;

async function getEntries(
  this: CommandContext,
  flags: GetEntriesFlags,
): Promise<void> {
  await withClient(this, async (client) => {
    const since =
      flags.since === undefined
        ? undefined
        : UUID_PATTERN.test(flags.since)
          ? (flags.since as UUID)
          : resolveUuidPrefix(flags.since, await sessionEntryUuids(client));
    printData(
      this,
      await client.request({
        type: "get-entries",
        payload: entryPayload(flags.uuids),
        ...(since !== undefined && { since }),
      }),
    );
  });
}

type GetContextUsageFlags = InferFlags<typeof getContextUsageFlags>;

async function getContextUsage(
  this: CommandContext,
  flags: GetContextUsageFlags,
): Promise<void> {
  await sendRequest(this, {
    type: "get-context-usage",
    ...(flags.detail !== undefined && { detail: flags.detail }),
  });
}

const readFileFlags = {
  maxBytes: parsedFlag(
    "Byte cap (default 1MB)",
    (input: string): number => {
      const parsed = Number(input);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new UsageError(
          `--max-bytes expects a positive integer, got '${input}'`,
        );
      }
      return parsed;
    },
    "n",
  ),
  base64: booleanFlag("Return base64 (for binary files)"),
};

type ReadFileFlags = InferFlags<typeof readFileFlags>;

async function readFileCommand(
  this: CommandContext,
  flags: ReadFileFlags,
  path: string,
): Promise<void> {
  await sendRequest(this, {
    type: "read-file",
    path,
    ...(flags.maxBytes !== undefined && { maxBytes: flags.maxBytes }),
    ...(flags.base64 && { encoding: "base64" as const }),
  });
}

// --- resolve-settings (client-side, target-less) -------------------------------

const resolveSettingsFlags = {
  cwd: stringFlag("Directory to resolve against (default: current)", "dir"),
};

type ResolveSettingsFlags = InferFlags<typeof resolveSettingsFlags>;

async function resolveSettingsCommand(
  this: CommandContext,
  flags: ResolveSettingsFlags,
): Promise<void> {
  // What a spawn at this cwd would see (DECISION-7); no daemon involved.
  const resolved = await resolveSettings({
    ...(flags.cwd !== undefined && { cwd: flags.cwd }),
  });
  this.process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
}

export const sdkRoutes = {
  interrupt: commandOneTarget({
    docs: { brief: "interrupt the current turn" },
    audited: true,
    func: async function (this: CommandContext): Promise<void> {
      await sendRequest(this, { type: "interrupt" });
    },
  }),
  "set-model": commandOneTarget<SetModelFlags>({
    docs: { brief: "change the agent's model" },
    parameters: { flags: setModelFlags },
    audited: true,
    func: setModel,
  }),
  "set-permission-mode": commandOneTarget<Record<never, never>, [string]>({
    docs: { brief: "change the agent's permission mode" },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [
          stringArg(
            `Permission mode (${PERMISSION_MODES.join("|")})`,
            "mode",
            completeChoices(PERMISSION_MODES),
          ),
        ],
      },
    },
    audited: true,
    func: setPermissionMode,
  }),
  "set-mcp-permission-mode-override": commandOneTarget<
    Record<never, never>,
    [string, string]
  >({
    docs: { brief: "pin or clear a per-MCP-server permission-mode override" },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [
          stringArg("MCP server name", "server"),
          stringArg(
            `Override (${MCP_OVERRIDE_MODES.join("|")})`,
            "mode",
            completeChoices(MCP_OVERRIDE_MODES),
          ),
        ],
      },
    },
    audited: true,
    func: setMcpPermissionModeOverride,
  }),
  "set-max-thinking-tokens": commandOneTarget<
    SetMaxThinkingTokensFlags,
    [string]
  >({
    docs: { brief: "cap thinking tokens ('clear' removes the cap)" },
    parameters: {
      flags: setMaxThinkingTokensFlags,
      positional: {
        kind: "tuple",
        parameters: [stringArg("Token count or 'clear'", "n|clear")],
      },
    },
    audited: true,
    func: setMaxThinkingTokens,
  }),
  "apply-flag-settings": commandOneTarget<Record<never, never>, [string]>({
    docs: { brief: "merge settings into the flag settings layer" },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [
          stringArg("Inline JSON or a settings file path", "json-or-path"),
        ],
      },
    },
    audited: true,
    func: applyFlagSettings,
  }),
  "update-settings": commandOneTarget<Record<never, never>, [string, string]>({
    docs: {
      brief:
        "merge settings into a settings file via the CLI's writer and apply them",
    },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [
          stringArg(
            `Settings file (${SETTINGS_SOURCES.join("|")})`,
            "source",
            completeChoices(SETTINGS_SOURCES),
          ),
          stringArg("Inline JSON or a settings file path", "json-or-path"),
        ],
      },
    },
    audited: true,
    func: updateSettings,
  }),
  "set-mcp-servers": commandOneTarget<Record<never, never>, [string]>({
    docs: { brief: "replace the dynamically-added MCP servers" },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [
          stringArg("Inline JSON or a config file path", "json-or-path"),
        ],
      },
    },
    audited: true,
    func: setMcpServers,
  }),
  "toggle-mcp-server": commandOneTarget<Record<never, never>, [string, string]>(
    {
      docs: { brief: "enable or disable an MCP server" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [
            stringArg("MCP server name", "server"),
            stringArg(
              "enabled|disabled",
              "state",
              completeChoices(["enabled", "disabled"]),
            ),
          ],
        },
      },
      audited: true,
      func: toggleMcpServer,
    },
  ),
  "reconnect-mcp-server": commandOneTarget<Record<never, never>, [string]>({
    docs: { brief: "reconnect an MCP server" },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [stringArg("MCP server name", "server")],
      },
    },
    audited: true,
    func: reconnectMcpServer,
  }),
  "stop-task": commandOneTarget<Record<never, never>, [string]>({
    docs: { brief: "stop a running task" },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [stringArg("Task id (from task_notification)", "task-id")],
      },
    },
    audited: true,
    func: stopTask,
  }),
  "background-tasks": commandOneTarget<BackgroundTasksFlags>({
    docs: { brief: "background in-flight foreground tasks" },
    parameters: { flags: backgroundTasksFlags },
    audited: true,
    func: backgroundTasks,
  }),
  "rewind-files": commandOneTarget<RewindFilesFlags, [string]>({
    docs: { brief: "rewind tracked files to a user message's checkpoint" },
    parameters: {
      flags: rewindFilesFlags,
      positional: {
        kind: "tuple",
        parameters: [
          stringArg("User message uuid (any unique prefix)", "user-message-id"),
        ],
      },
    },
    audited: true,
    func: rewindFiles,
  }),
  "seed-read-state": commandOneTarget<Record<never, never>, [string, string]>({
    docs: { brief: "seed the CLI's readFileState cache with path+mtime" },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [
          stringArg("File path", "path"),
          stringArg("File mtime (floored ms)", "mtime"),
        ],
      },
    },
    audited: true,
    func: seedReadState,
  }),
  "reload-plugins": bareRequestCommand(
    "reload plugins from disk",
    { type: "reload-plugins" },
    true,
  ),
  "reload-skills": bareRequestCommand(
    "reload skills from disk",
    { type: "reload-skills" },
    true,
  ),
  // JSONL rather than a pretty-printed array: one record per line, the shape
  // `format messages` consumes.
  "get-context": commandOneTarget<GetContextFlags>({
    docs: {
      brief:
        "print the assistant's context (session entries, JSONL; node refs with --uuids) at the current leaf or at --at",
    },
    parameters: { flags: getContextFlags },
    func: getContext,
  }),
  "get-entries": commandOneTarget<GetEntriesFlags>({
    docs: {
      brief:
        "print the session snapshot (every entry uuid, the entries verbatim unless --uuids, plus the current leaf) as one JSON document",
    },
    parameters: { flags: getEntriesFlags },
    func: getEntries,
  }),
  "set-context": commandOneTarget<SetContextFlags, string[]>({
    docs: {
      brief:
        "reshape the agent's effective context (preserved uuids or --rewind-to)",
    },
    parameters: {
      flags: setContextFlags,
      positional: restArgs(
        "Message uuids to keep, in order (unique prefixes accepted); with --rewind-to, appended after the target's context",
        "uuid",
      ),
    },
    audited: true,
    func: setContext,
  }),
  "initialization-result": bareRequestCommand(
    "print the full initialization result",
    { type: "initialization-result" },
  ),
  "supported-commands": bareRequestCommand("list available slash commands", {
    type: "supported-commands",
  }),
  "supported-models": bareRequestCommand("list available models", {
    type: "supported-models",
  }),
  "supported-agents": bareRequestCommand("list available subagents", {
    type: "supported-agents",
  }),
  "mcp-server-status": bareRequestCommand("print MCP server statuses", {
    type: "mcp-server-status",
  }),
  "get-context-usage": commandOneTarget<GetContextUsageFlags>({
    docs: { brief: "print the context window usage breakdown" },
    parameters: { flags: getContextUsageFlags },
    func: getContextUsage,
  }),
  usage: bareRequestCommand("print session cost/usage and plan rate limits", {
    type: "usage",
  }),
  "account-info": bareRequestCommand("print authenticated account info", {
    type: "account-info",
  }),
  "read-file": commandOneTarget<ReadFileFlags, [string]>({
    docs: { brief: "read a file through the agent's permission rules" },
    parameters: {
      flags: readFileFlags,
      positional: {
        kind: "tuple",
        parameters: [
          stringArg("File path (relative to cwd or absolute)", "path"),
        ],
      },
    },
    func: readFileCommand,
  }),
  "resolve-settings": commandNoTarget<ResolveSettingsFlags>({
    docs: { brief: "print the effective settings a spawn would see" },
    parameters: { flags: resolveSettingsFlags },
    func: resolveSettingsCommand,
  }),
} as const;
