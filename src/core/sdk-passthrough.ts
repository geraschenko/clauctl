/**
 * The daemon side of the SDK passthrough: the mapping from wire-level control
 * requests to `Query` method calls, plus the DECISION-5 persistence rules.
 * Everything that must change when the SDK's `Query` control interface changes
 * is confined to three sibling files — protocol.ts (wire types), this file
 * (daemon dispatch), and sdk-commands.ts (CLI) — so daemon.ts and the state
 * machines never name individual Query methods.
 */

import { readFile } from "node:fs/promises";
import type { Options, Query, Settings } from "@anthropic-ai/claude-agent-sdk";
import type {
  FlagSettings,
  SdkControlMutation,
  SdkControlRead,
  ProtocolRequest,
} from "./protocol.ts";

const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// Record (not Set) so a new SdkControlMutation variant is a compile error here.
const MUTATION_TYPES: Record<SdkControlMutation["type"], true> = {
  "set-permission-mode": true,
  "set-mcp-permission-mode-override": true,
  "set-model": true,
  "set-max-thinking-tokens": true,
  "apply-flag-settings": true,
  "update-settings": true,
  "set-mcp-servers": true,
  "toggle-mcp-server": true,
  "reconnect-mcp-server": true,
  "stop-task": true,
  "background-tasks": true,
  "rewind-files": true,
  "seed-read-state": true,
  "reload-plugins": true,
  "reload-skills": true,
  "reload-output-styles": true,
};

export function isControlMutation(
  request: ProtocolRequest,
): request is SdkControlMutation {
  // hasOwn, not `in`: the wire type is untrusted, and inherited property
  // names ("constructor", "toString") must not classify as known.
  return Object.hasOwn(MUTATION_TYPES, request.type);
}

// Record (not Set) so a new SdkControlRead variant is a compile error here.
const READ_TYPES: Record<SdkControlRead["type"], true> = {
  "initialization-result": true,
  "supported-commands": true,
  "supported-models": true,
  "supported-agents": true,
  "mcp-server-status": true,
  "get-context-usage": true,
  usage: true,
  "account-info": true,
  "read-file": true,
  "read-mcp-resource": true,
};

export function isControlRead(
  request: ProtocolRequest,
): request is SdkControlRead {
  // hasOwn, not `in`: see isControlMutation.
  return Object.hasOwn(READ_TYPES, request.type);
}

/**
 * Applies a mutation to the live Query (DECISION-4 passthrough); returns the
 * method's result (undefined for void methods).
 */
export async function applyMutation(
  query: Query,
  mutation: SdkControlMutation,
): Promise<unknown> {
  switch (mutation.type) {
    case "set-permission-mode":
      return await query.setPermissionMode(mutation.mode);
    case "set-mcp-permission-mode-override":
      return await query.setMcpPermissionModeOverride(
        mutation.serverName,
        mutation.mode,
      );
    case "set-model":
      return await query.setModel(mutation.model);
    case "set-max-thinking-tokens":
      // Deprecated SDK-side, but kept: the only runtime thinking control
      // (the `thinking` option is spawn-time only).
      return await query.setMaxThinkingTokens(
        mutation.maxThinkingTokens,
        mutation.thinkingDisplay,
      );
    case "apply-flag-settings": {
      // The CLI runtime accepts anything here and silently drops unknown
      // levels into the settings cascade, so the daemon is the backstop for
      // every socket client (the TUI additionally validates per-model before
      // sending). The throw rejects the request before the SDK call; the
      // request handler emits controlApplied and persists only after a
      // successful apply, so the fold never sees garbage. Only effortLevel
      // is validated — the one key FlagSettings widens beyond the SDK type.
      const { effortLevel } = mutation.settings;
      if (
        effortLevel !== undefined &&
        effortLevel !== null &&
        !EFFORT_LEVELS.has(effortLevel)
      ) {
        throw new Error(
          `invalid effortLevel ${JSON.stringify(effortLevel)}; valid: ${[...EFFORT_LEVELS].join(", ")}`,
        );
      }
      // FlagSettings widens effortLevel to include "max", which the SDK's
      // parameter type omits but the runtime accepts (see FlagSettings).
      return await query.applyFlagSettings(
        mutation.settings as Parameters<Query["applyFlagSettings"]>[0],
      );
    }
    case "update-settings":
      // The SDK enforces its own key allowlist and transport gate; the daemon
      // forwards the request and lets that rejection propagate.
      return await query.updateSettings(mutation.source, mutation.settings);
    case "set-mcp-servers":
      return await query.setMcpServers(mutation.servers);
    case "toggle-mcp-server":
      return await query.toggleMcpServer(mutation.serverName, mutation.enabled);
    case "reconnect-mcp-server":
      return await query.reconnectMcpServer(mutation.serverName);
    case "stop-task":
      return await query.stopTask(mutation.taskId);
    case "background-tasks":
      return await query.backgroundTasks(mutation.toolUseId);
    case "rewind-files":
      return await query.rewindFiles(mutation.userMessageId, {
        ...(mutation.dryRun !== undefined && { dryRun: mutation.dryRun }),
      });
    case "seed-read-state":
      return await query.seedReadState(mutation.path, mutation.mtime);
    case "reload-plugins":
      return await query.reloadPlugins({
        ...(mutation.holdOnCacheImpact !== undefined && {
          holdOnCacheImpact: mutation.holdOnCacheImpact,
        }),
      });
    case "reload-skills":
      return await query.reloadSkills();
    case "reload-output-styles":
      return await query.reloadOutputStyles();
  }
}

/**
 * DECISION-5 persist-on-mutation: the persisted options after `mutation`, or
 * undefined when the mutation persists nothing. The args of each mutating call
 * are the record; nothing is ever read back from the SDK.
 */
export async function persistedOptionsAfter(
  mutation: SdkControlMutation,
  current: Options,
): Promise<Options | undefined> {
  switch (mutation.type) {
    case "set-model": {
      const next: Options = { ...current };
      next.model = mutation.model;
      return next;
    }
    case "set-permission-mode": {
      const next: Options = { ...current };
      next.permissionMode = mutation.mode;
      if (mutation.mode === "bypassPermissions") {
        // Entering bypass requires the spawn-time dangerous-skip flag; a
        // session that entered it once keeps the capability across respawn.
        next.allowDangerouslySkipPermissions = true;
      }
      return next;
    }
    case "set-max-thinking-tokens": {
      // thinkingDisplay has no Options home; accepted as lost across respawn.
      const next: Options = { ...current };
      if (mutation.maxThinkingTokens === null) {
        delete next.maxThinkingTokens;
      } else {
        next.maxThinkingTokens = mutation.maxThinkingTokens;
      }
      return next;
    }
    case "apply-flag-settings":
      return {
        ...current,
        settings: await mergeFlagSettings(current.settings, mutation.settings),
      };
    case "set-mcp-servers":
      // All entries arrived over JSON, so all are serializable by
      // construction (in-process SdkMcpServer entries cannot reach here).
      return { ...current, mcpServers: mutation.servers };
    case "update-settings":
      // The settings file it writes is the record: the CLI reads it back
      // through the settings cascade on every respawn.
      return undefined;
    case "set-mcp-permission-mode-override":
    case "toggle-mcp-server":
    case "reconnect-mcp-server":
    case "stop-task":
    case "background-tasks":
    case "rewind-files":
    case "seed-read-state":
    case "reload-plugins":
    case "reload-skills":
    case "reload-output-styles":
      return undefined;
  }
}

/** Runs a read against the live Query; the return value is the response data. */
export async function runRead(
  query: Query,
  read: SdkControlRead,
): Promise<unknown> {
  switch (read.type) {
    case "initialization-result":
      return await query.initializationResult();
    case "supported-commands":
      return await query.supportedCommands();
    case "supported-models":
      return await query.supportedModels();
    case "supported-agents":
      return await query.supportedAgents();
    case "mcp-server-status":
      return await query.mcpServerStatus();
    case "get-context-usage":
      return await query.getContextUsage({
        ...(read.detail !== undefined && { detail: read.detail }),
      });
    case "usage":
      // Stable alias for the experimental method; rename here when the SDK
      // stabilizes it.
      return await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
        {
          ...(read.skipBehaviors !== undefined && {
            skipBehaviors: read.skipBehaviors,
          }),
        },
      );
    case "account-info":
      return await query.accountInfo();
    case "read-file":
      return await query.readFile(read.path, {
        ...(read.maxBytes !== undefined && { maxBytes: read.maxBytes }),
        ...(read.encoding !== undefined && { encoding: read.encoding }),
      });
    case "read-mcp-resource":
      return await query.readMcpResource(read.serverName, read.uri);
    // Coverage invariant (DECISION-4): between applyMutation and runRead,
    // every Query method is reachable except close (the daemon's teardown owns
    // the connection lifecycle), streamInput (the daemon's TurnQueue IS the
    // input stream), and reinitialize (a transport-gap recovery tool for
    // ring-buffer clients; the daemon never has a transport gap with its own
    // SDK).
  }
}

/**
 * DECISION-5 cumulative shallow-merge for apply-flag-settings: `null` clears a
 * key, everything else replaces it. If the persisted settings is a path string
 * (spawned via `--settings <file>`), the first apply reads and parses that
 * file, then merges; from then on the merged object is what persists.
 */
async function mergeFlagSettings(
  current: Options["settings"],
  applied: FlagSettings,
): Promise<Settings> {
  const base: Record<string, unknown> =
    typeof current === "string"
      ? (JSON.parse(await readFile(current, "utf8")) as Record<string, unknown>)
      : { ...current };
  for (const [key, value] of Object.entries(applied)) {
    if (value === null) {
      delete base[key];
    } else if (value !== undefined) {
      base[key] = value;
    }
  }
  return base as Settings;
}
