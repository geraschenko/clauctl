/**
 * The four-bucket partition of the SDK `Options` type (spec: Phase 1,
 * "Options handling"), and the `claude`-flag → `Options` parser that `spawn`
 * uses — the inverse of the SDK's `initialize()` argv builder, pinned to SDK
 * 0.3.195.
 *
 * OPTION_BUCKETS is exhaustive over `keyof Options` via `satisfies`, so an SDK
 * bump that adds or removes a field breaks the build until it is classified —
 * the RISK-6 tripwire. Do not replace PersistedOptions with a hand-written
 * interface (that rots silently).
 */

import { readFileSync } from "node:fs";
import {
  filterEscalatingDefaultMode,
  resolveSettings,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { oneOf, UsageError } from "./generated/util.ts";

export type OptionBucket = "persist" | "code" | "invariant" | "respawn";

export const OPTION_BUCKETS = {
  // Bucket 1 — persist: round-tripped in agent.json; the serializable config.
  // (mcpServers: serializable entries only — in-process SdkMcpServer entries
  // are live code and must never reach agent.json.)
  model: "persist",
  fallbackModel: "persist",
  permissionMode: "persist",
  allowedTools: "persist",
  disallowedTools: "persist",
  tools: "persist",
  toolAliases: "persist",
  agent: "persist",
  agents: "persist",
  cwd: "persist",
  additionalDirectories: "persist",
  env: "persist",
  extraArgs: "persist",
  betas: "persist",
  enableFileCheckpointing: "persist",
  toolConfig: "persist",
  thinking: "persist",
  effort: "persist",
  maxThinkingTokens: "persist",
  maxTurns: "persist",
  maxBudgetUsd: "persist",
  taskBudget: "persist",
  mcpServers: "persist",
  planModeInstructions: "persist",
  plugins: "persist",
  promptSuggestions: "persist",
  agentProgressSummaries: "persist",
  sandbox: "persist",
  settings: "persist",
  managedSettings: "persist",
  settingSources: "persist",
  skills: "persist",
  strictMcpConfig: "persist",
  allowDangerouslySkipPermissions: "persist",
  supportedDialogKinds: "persist",
  systemPrompt: "persist",
  title: "persist",

  // Bucket 2 — code: live values re-supplied by clauctl every (re)spawn.
  abortController: "code",
  canUseTool: "code",
  hooks: "code",
  onElicitation: "code",
  onUserDialog: "code",
  sessionStore: "code",
  sessionStoreFlush: "code",
  stderr: "code",
  spawnClaudeCodeProcess: "code",

  // Bucket 3 — invariant: clauctl owns these; not user-tunable (see
  // invariantOptions and INVARIANT_FLAGS below).
  persistSession: "invariant",
  outputFormat: "invariant",
  includePartialMessages: "invariant",
  includeHookEvents: "invariant",
  forwardSubagentText: "invariant",
  pathToClaudeCodeExecutable: "invariant",
  executable: "invariant",
  executableArgs: "invariant",
  loadTimeoutMs: "invariant",
  debug: "invariant",
  debugFile: "invariant",
  permissionPromptToolName: "invariant",

  // Bucket 4 — respawn: session identity, set by clauctl per (re)spawn.
  resume: "respawn",
  continue: "respawn",
  forkSession: "respawn",
  resumeSessionAt: "respawn",
  sessionId: "respawn",
} as const satisfies Record<keyof Options, OptionBucket>;

export type PersistedOptionKey = {
  [K in keyof Options]-?: (typeof OPTION_BUCKETS)[K] extends "persist"
    ? K
    : never;
}[keyof Options];

export type PersistedOptions = Pick<Options, PersistedOptionKey>;

/**
 * The bucket-3 values the daemon applies on every (re)spawn (DECISION-8,
 * stream-shape invariants). `permissionPromptToolName` stays unset (the SDK
 * throws if both it and canUseTool are set); the executable trio and
 * loadTimeoutMs stay unset (SDK-bundled binary, default runtime); debug is
 * left to the SDK's own default (it self-selects a debug file).
 */
export function invariantOptions(): Pick<
  Options,
  | "persistSession"
  | "includePartialMessages"
  | "includeHookEvents"
  | "forwardSubagentText"
> {
  return {
    persistSession: true,
    includePartialMessages: true,
    includeHookEvents: true,
    // The augmented stream is the full observable record (DECISION-6): the
    // TUI renders subagent activity nested under its Task/Agent tool, which
    // only exists on the stream when subagent text is forwarded.
    forwardSubagentText: true,
  };
}

/**
 * The model and permission mode the settings cascade would give a `query()`
 * run with these persisted options — the settings tier of the AgentState
 * seed's "what will the NEXT query use" precedence (PersistedOptions win over
 * this; the daemon applies the fallbacks). Known fidelity gaps, accepted:
 * the `Options.settings` flag tier has no resolveSettings input; the
 * policy-tier policyHelper subprocess is not executed; the model may be an
 * alias the CLI would still resolve.
 */
export async function settingsSeed(
  persisted: PersistedOptions,
  cwd: string,
): Promise<{ model?: string; permissionMode?: PermissionMode }> {
  const resolved = await resolveSettings({
    cwd,
    ...(persisted.settingSources !== undefined && {
      settingSources: persisted.settingSources,
    }),
    ...(persisted.managedSettings !== undefined && {
      managedSettings: persisted.managedSettings,
    }),
  });
  const model = resolved.effective.model;
  // The CLI's trust filter: escalating defaultModes from repo-committed
  // files are not honored, so they must not be predicted either.
  const permissionMode =
    filterEscalatingDefaultMode(resolved).permissions?.defaultMode;
  return {
    ...(model !== undefined && { model }),
    ...(permissionMode !== undefined && { permissionMode }),
  };
}

/** parseClaudeFlags result; `spawn` folds it into the SpawnOptions handoff. */
export interface ParsedClaudeFlags {
  persistedOptions: PersistedOptions;
  /** Initial-spawn session wrap (`--resume <session-id>`), bucket-4 exception. */
  resume?: string;
}

/**
 * claude flags that clauctl owns (bucket 3 / stream-shape invariants) or that
 * would fork session identity; `spawn` rejects them rather than silently
 * overriding the daemon's values.
 */
const REJECTED_FLAGS = new Set([
  "--output-format",
  "--input-format",
  "--verbose",
  "--include-partial-messages",
  "--include-hook-events",
  "--forward-subagent-text",
  "--no-session-persistence",
  "--debug",
  "--debug-file",
  "--debug-to-stderr",
  "--permission-prompt-tool",
  "--continue",
  "--fork-session",
  "--resume-session-at",
  "--session-id",
  "--print",
  "-p",
]);

const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const;

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const THINKING_DISPLAYS = ["summarized", "omitted"] as const;

/**
 * Inline-JSON-or-file-path MCP server config (matching the claude CLI's
 * `--mcp-config`; `set-mcp-servers` reuses the same parse). The SDK wraps the
 * servers as `{"mcpServers": {...}}` when emitting the flag; accept both the
 * wrapped and bare forms. `what` names the flag/argument in errors.
 */
export function parseMcpConfig(
  value: string,
  what = "--mcp-config",
): Record<string, McpServerConfig> {
  const raw = value.trimStart().startsWith("{")
    ? value
    : readFileSync(value, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`${what} is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new UsageError(`${what} must be a JSON object`);
  }
  const wrapped = (parsed as { mcpServers?: unknown }).mcpServers;
  const servers = wrapped ?? parsed;
  if (typeof servers !== "object" || servers === null) {
    throw new UsageError(`${what} .mcpServers must be a JSON object`);
  }
  return servers as Record<string, McpServerConfig>;
}

function parsePositiveNumber(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(
      `${flag} expects a non-negative number, got '${value}'`,
    );
  }
  return parsed;
}

/** Split "a,b,c"; the SDK joins list flags with commas, this is the inverse. */
function splitCommaList(value: string): string[] {
  return value === "" ? [] : value.split(",");
}

/**
 * Parse `claude`-style flags into the bucket-1 options `spawn` persists (plus
 * the initial-spawn `resume` wrap). Modeled/merged fields get their first-class
 * `Options` field; any other `--flag [value]` falls through to the `extraArgs`
 * tail, forwarded verbatim (a following token is its value unless it looks
 * like another flag). Rejected flags are the ones clauctl owns.
 */
export function parseClaudeFlags(args: readonly string[]): ParsedClaudeFlags {
  const options: PersistedOptions = {};
  let resume: string | undefined;
  const extraArgs: Record<string, string | null> = {};
  const addDirs: string[] = [];

  let index = 0;
  // Set when the current token used `--flag=value` syntax.
  let inlineValue: string | undefined;
  const next = (flag: string): string => {
    if (inlineValue !== undefined) {
      const value = inlineValue;
      inlineValue = undefined;
      return value;
    }
    const value = args[index++];
    if (value === undefined) {
      throw new UsageError(`${flag} expects a value`);
    }
    return value;
  };

  const setThinking = (patch: Partial<ThinkingConfig>): void => {
    options.thinking = {
      type: "adaptive",
      ...options.thinking,
      ...patch,
    } as ThinkingConfig;
  };

  while (index < args.length) {
    const token = args[index++]!;
    if (!token.startsWith("-")) {
      throw new UsageError(
        `unexpected positional argument '${token}' in claude flags`,
      );
    }
    const equalsIndex = token.indexOf("=");
    const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);

    if (REJECTED_FLAGS.has(flag)) {
      throw new UsageError(
        `${flag} is owned by clauctl and cannot be set at spawn`,
      );
    }

    switch (flag) {
      case "--model":
        options.model = next(flag);
        break;
      case "--fallback-model":
        options.fallbackModel = next(flag);
        break;
      case "--permission-mode":
        options.permissionMode = oneOf(
          next(flag),
          PERMISSION_MODES,
          flag,
        ) as PermissionMode;
        break;
      case "--allow-dangerously-skip-permissions":
      case "--dangerously-skip-permissions":
        options.allowDangerouslySkipPermissions = true;
        break;
      case "--allowedTools":
      case "--allowed-tools":
        options.allowedTools = splitCommaList(next(flag));
        break;
      case "--disallowedTools":
      case "--disallowed-tools":
        options.disallowedTools = splitCommaList(next(flag));
        break;
      case "--tools":
        options.tools = splitCommaList(next(flag));
        break;
      case "--agent":
        options.agent = next(flag);
        break;
      case "--add-dir":
        addDirs.push(next(flag));
        break;
      case "--betas":
        options.betas = splitCommaList(next(flag)) as Options["betas"];
        break;
      case "--max-turns":
        options.maxTurns = parsePositiveNumber(flag, next(flag));
        break;
      case "--max-budget-usd":
        options.maxBudgetUsd = parsePositiveNumber(flag, next(flag));
        break;
      case "--task-budget":
        options.taskBudget = { total: parsePositiveNumber(flag, next(flag)) };
        break;
      case "--effort":
        options.effort = oneOf(next(flag), EFFORT_LEVELS, flag);
        break;
      case "--thinking": {
        const kind = oneOf(next(flag), ["adaptive", "disabled"] as const, flag);
        setThinking({ type: kind });
        break;
      }
      case "--max-thinking-tokens":
        setThinking({
          type: "enabled",
          budgetTokens: parsePositiveNumber(flag, next(flag)),
        });
        break;
      case "--thinking-display":
        setThinking({ display: oneOf(next(flag), THINKING_DISPLAYS, flag) });
        break;
      case "--mcp-config":
        options.mcpServers = {
          ...options.mcpServers,
          ...parseMcpConfig(next(flag)),
        };
        break;
      case "--setting-sources":
        options.settingSources = splitCommaList(
          next(flag),
        ) as Options["settingSources"];
        break;
      case "--settings":
        // Path string or inline JSON; Options.settings accepts the string form
        // directly, so store it as given.
        options.settings = next(flag);
        break;
      case "--strict-mcp-config":
        options.strictMcpConfig = true;
        break;
      case "--system-prompt":
        options.systemPrompt = next(flag);
        break;
      case "--append-system-prompt":
        options.systemPrompt = {
          type: "preset",
          preset: "claude_code",
          append: next(flag),
        };
        break;
      case "--resume":
        resume = next(flag);
        break;
      default: {
        // Unmodeled flag → extraArgs tail, forwarded verbatim. Repeats cannot
        // be represented (unique keys), so they are an error, not a silent drop.
        const key = flag.replace(/^--?/, "");
        if (key in extraArgs) {
          throw new UsageError(
            `${flag} given more than once; repeatable flags need first-class support`,
          );
        }
        if (inlineValue !== undefined) {
          extraArgs[key] = next(flag);
          break;
        }
        const value = args[index];
        if (value !== undefined && !value.startsWith("-")) {
          extraArgs[key] = value;
          index += 1;
        } else {
          extraArgs[key] = null;
        }
      }
    }
  }

  if (addDirs.length > 0) {
    options.additionalDirectories = addDirs;
  }
  if (Object.keys(extraArgs).length > 0) {
    options.extraArgs = extraArgs;
  }
  return { persistedOptions: options, ...(resume !== undefined && { resume }) };
}
