/**
 * The full `Query` passthrough (DECISION-4): every Query method as a flat
 * kebab-case subcommand — the daemon's mapping site documents the three
 * exclusions — plus `query --image/--no-query` and the client-side
 * `resolve-settings`.
 *
 * Every subcommand takes the agent as --target (reviving a dormant agent
 * transparently), sends one request over the agent's sdk.sock, and prints the
 * response data as JSON if there is any.
 */

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import type {
  ContentBlockParam,
  ImageBlockParam,
} from "@anthropic-ai/sdk/resources";
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
  variadicStringFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { oneTarget, type CommandContext } from "./generated/targets.ts";
import { ensureAgentRunning } from "./lifecycle.ts";
import { parseMcpConfig } from "./options.ts";
import { sdkSocketPath } from "./registry.ts";
import {
  connectWithRetry,
  parseSetContextRequest,
  type FlagSettings,
  type SdkRequest,
  type SetContextRequest,
} from "./sdk-socket.ts";
import { parseTreeNodeRef } from "./tree.ts";
import { oneOf, UsageError } from "./generated/util.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const;

const PRIORITIES = ["now", "next", "later"] as const;

async function requestData(
  context: CommandContext,
  request: SdkRequest,
): Promise<unknown> {
  const agent = await ensureAgentRunning(oneTarget(context).id);
  const client = await connectWithRetry(
    sdkSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  try {
    return await client.request(request);
  } finally {
    client.close();
  }
}

async function sendRequest(
  context: CommandContext,
  request: SdkRequest,
): Promise<void> {
  const data = await requestData(context, request);
  if (data !== undefined) {
    context.process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
}

/** Like bareRequestCommand, but the response is a list printed as JSONL. */
function jsonlRequestCommand(brief: string, request: SdkRequest) {
  return commandOneTarget({
    docs: { brief },
    func: async function (this: CommandContext): Promise<void> {
      const data = await requestData(this, request);
      for (const record of data as unknown[]) {
        this.process.stdout.write(`${JSON.stringify(record)}\n`);
      }
    },
  });
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

// --- query -------------------------------------------------------------------

type ImageMediaType = ImageBlockParam["source"] extends infer S
  ? S extends { media_type: infer M }
    ? M
    : never
  : never;

const IMAGE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function imageBlock(path: string): Promise<ImageBlockParam> {
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
  if (mediaType === undefined) {
    throw new UsageError(
      `--image ${path}: unsupported extension (expected ` +
        `${Object.keys(IMAGE_MEDIA_TYPES).join("|")})`,
    );
  }
  const data = (await readFile(path)).toString("base64");
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  };
}

const queryFlags = {
  priority: enumFlag("Queue placement (now|next|later)", PRIORITIES),
  image: variadicStringFlag("Attach an image file (repeatable)", "path"),
  noQuery: booleanFlag("Append to the transcript without triggering a turn"),
};

type QueryFlags = InferFlags<typeof queryFlags>;

async function queryCommand(
  this: CommandContext,
  flags: QueryFlags,
  text: string,
): Promise<void> {
  const images = await Promise.all(flags.image.map(imageBlock));
  const content: string | ContentBlockParam[] =
    images.length === 0 ? text : [...images, { type: "text", text }];
  await sendRequest(this, {
    type: "query",
    content,
    ...(flags.priority !== undefined && { priority: flags.priority }),
    ...(flags.noQuery && { shouldQuery: false }),
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

/** Inline-JSON-or-file settings argument for apply-flag-settings. */
function parseSettingsArg(value: string): FlagSettings {
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
  return parsed as FlagSettings;
}

async function applyFlagSettings(
  this: CommandContext,
  _flags: Record<never, never>,
  settings: string,
): Promise<void> {
  await sendRequest(this, {
    type: "apply-flag-settings",
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
  await sendRequest(this, {
    type: "rewind-files",
    userMessageId,
    ...(flags.dryRun && { dryRun: true }),
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
  summary: stringFlag("Summary text written as the compact summary", "text"),
  anchor: enumFlag(
    "Context order: summary first (up_to, default) or uuids first (from)",
    ["summary", "boundary"] as const,
  ),
  rewindTo: stringFlag(
    "Rewind to this tree node — <uuid> or <uuid>@<boundary-uuid> for an occurrence inside that boundary's context (mutually exclusive with uuids)",
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
  // mode conflicts, then the daemon's own parser for uuid syntax and the
  // rest) avoids a pointless daemon revival.
  if (
    flags.rewindTo !== undefined &&
    (uuids.length > 0 ||
      flags.summary !== undefined ||
      flags.anchor !== undefined ||
      flags.empty)
  ) {
    throw new UsageError(
      "--rewind-to is mutually exclusive with uuids/--summary/--anchor/--empty",
    );
  }
  if (
    flags.empty &&
    (uuids.length > 0 ||
      flags.summary !== undefined ||
      flags.anchor !== undefined)
  ) {
    // Summary-only context is already expressible via --summary alone.
    throw new UsageError(
      "--empty is mutually exclusive with uuids/--summary/--anchor/--rewind-to",
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
  let request: SetContextRequest;
  try {
    request = parseSetContextRequest(
      flags.rewindTo !== undefined
        ? { rewindTo: parseTreeNodeRef(flags.rewindTo) }
        : {
            uuids: flags.empty ? [] : uuids,
            ...(flags.summary !== undefined && { summaryText: flags.summary }),
            ...(flags.anchor !== undefined && { anchor: flags.anchor }),
          },
    );
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  await sendRequest(this, request);
}

// --- reads with arguments ------------------------------------------------------

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
  query: commandOneTarget<QueryFlags, [string]>({
    common: true,
    docs: { brief: "send a turn to the agent" },
    parameters: {
      flags: queryFlags,
      positional: {
        kind: "tuple",
        parameters: [stringArg("Turn text", "text")],
      },
    },
    audited: true,
    func: queryCommand,
  }),
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
        parameters: [stringArg("User message UUID", "user-message-id")],
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
  "get-messages": jsonlRequestCommand(
    "print the transcript since the last compaction as JSONL",
    { type: "get-messages" },
  ),
  "get-entries": bareRequestCommand(
    "print the session snapshot (every jsonl entry, verbatim, plus the current leaf) as one JSON document",
    { type: "get-entries" },
  ),
  "set-context": commandOneTarget<SetContextFlags, string[]>({
    docs: {
      brief:
        "reshape the agent's effective context (preserved uuids or --rewind-to)",
    },
    parameters: {
      flags: setContextFlags,
      positional: restArgs("Message uuids to keep, in order", "uuid"),
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
  "get-context-usage": bareRequestCommand(
    "print the context window usage breakdown",
    { type: "get-context-usage" },
  ),
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
