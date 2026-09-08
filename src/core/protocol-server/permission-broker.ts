/**
 * The daemon's side of a permission ask: the SDK's `canUseTool` promise is
 * parked here until a socket client answers (`permission-response`), the
 * CLI aborts the ask (interrupt), or the daemon tears down. Every
 * transition is published through the hub (`permissionRequested` /
 * `permissionResolved`), so `AgentState.pendingPermissions` is the
 * observable projection of the resolver map (docs/specs/permission-prompt.md).
 */

import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import {
  NOT_PENDING_ERROR,
  type PermissionRequest,
} from "../protocol/index.ts";
import { isRecord } from "../generated/util.ts";
import type { EventHub } from "./event-hub.ts";

/** The canUseTool arguments → wire shape (drops signal/requestId/matchedAskRule). */
export function permissionRequestOf(
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): PermissionRequest {
  return {
    toolUseId: options.toolUseID,
    toolName,
    input,
    suggestions: options.suggestions ?? [],
    ...(options.blockedPath !== undefined && {
      blockedPath: options.blockedPath,
    }),
    ...(options.decisionReason !== undefined && {
      decisionReason: options.decisionReason,
    }),
    ...(options.defaultToNo !== undefined && {
      defaultToNo: options.defaultToNo,
    }),
    ...(options.suppressAlwaysAllowRule !== undefined && {
      suppressAlwaysAllowRule: options.suppressAlwaysAllowRule,
    }),
    ...(options.title !== undefined && { title: options.title }),
    ...(options.displayName !== undefined && {
      displayName: options.displayName,
    }),
    ...(options.description !== undefined && {
      description: options.description,
    }),
    ...(options.agentID !== undefined && { agentId: options.agentID }),
  };
}

/** What settles an abandoned ask's promise: the SDK has already stopped
 *  waiting for it (abort) or is being closed (cancelAll). */
const CANCELLED_RESULT: PermissionResult = {
  behavior: "deny",
  message: "cancelled",
};

export class PermissionBroker {
  private readonly resolvers = new Map<
    string,
    (decision: PermissionResult) => void
  >();

  private readonly events: EventHub;

  constructor(events: EventHub) {
    this.events = events;
  }

  /** Parks the ask until respond(), abort, or cancelAll(). Throws on a
   *  toolUseId already pending (the CLI asks once per tool use). An ask
   *  whose signal is already aborted is never observable: neither event
   *  is emitted. */
  request(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    if (this.resolvers.has(request.toolUseId)) {
      throw new Error(`permission ${request.toolUseId} already pending`);
    }
    if (signal.aborted) {
      return Promise.resolve(CANCELLED_RESULT);
    }
    return new Promise<PermissionResult>((resolve) => {
      this.resolvers.set(request.toolUseId, resolve);
      signal.addEventListener(
        "abort",
        () => this.settle(request.toolUseId, { behavior: "cancelled" }),
        { once: true },
      );
      this.events.emit({ kind: "permissionRequested", request });
    });
  }

  /** Throws NOT_PENDING_ERROR when the toolUseId is not pending. */
  respond(toolUseId: string, decision: PermissionResult): void {
    if (!this.settle(toolUseId, decision)) {
      throw new Error(NOT_PENDING_ERROR);
    }
  }

  /** Idempotent; a later abort for an already-cancelled ask is a no-op. */
  cancelAll(): void {
    for (const toolUseId of [...this.resolvers.keys()]) {
      this.settle(toolUseId, { behavior: "cancelled" });
    }
  }

  /** Remove the resolver, emit, settle — in that order, so an observer
   *  sees the resolution before the CLI can act on it. False when the
   *  ask is not pending. */
  private settle(
    toolUseId: string,
    resolution: PermissionResult | { behavior: "cancelled" },
  ): boolean {
    const resolve = this.resolvers.get(toolUseId);
    if (resolve === undefined) return false;
    this.resolvers.delete(toolUseId);
    this.events.emit({ kind: "permissionResolved", toolUseId, resolution });
    resolve(
      resolution.behavior === "cancelled" ? CANCELLED_RESULT : resolution,
    );
    return true;
  }
}

/** Transcribed from the SDK's `PermissionUpdateDestination` and
 *  `PermissionBehavior` unions (sdk.d.ts): the SDK exports the types only,
 *  nothing to check against at runtime. */
const DESTINATIONS: readonly string[] = [
  "userSettings",
  "projectSettings",
  "localSettings",
  "session",
  "cliArg",
];
const BEHAVIORS: readonly string[] = ["allow", "deny", "ask"];

function validatePermissionUpdate(
  value: unknown,
  label: string,
): PermissionUpdate {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (!DESTINATIONS.includes(value.destination as string)) {
    throw new Error(
      `${label}.destination must be one of ${DESTINATIONS.join("/")}`,
    );
  }
  const requireStringArray = (key: string): void => {
    const list = value[key];
    if (
      !Array.isArray(list) ||
      !list.every((item) => typeof item === "string")
    ) {
      throw new Error(`${label}.${key} must be a string array`);
    }
  };
  const requireRules = (): void => {
    const rules = value.rules;
    if (
      !Array.isArray(rules) ||
      !rules.every(
        (rule) =>
          isRecord(rule) &&
          typeof rule.toolName === "string" &&
          (rule.ruleContent === undefined ||
            typeof rule.ruleContent === "string"),
      )
    ) {
      throw new Error(
        `${label}.rules must be {toolName, ruleContent?} objects`,
      );
    }
    if (!BEHAVIORS.includes(value.behavior as string)) {
      throw new Error(
        `${label}.behavior must be one of ${BEHAVIORS.join("/")}`,
      );
    }
  };
  switch (value.type) {
    case "addRules":
    case "replaceRules":
    case "removeRules":
      requireRules();
      break;
    case "setMode":
      if (typeof value.mode !== "string") {
        throw new Error(`${label}.mode must be a string`);
      }
      break;
    case "addDirectories":
    case "removeDirectories":
      requireStringArray("directories");
      break;
    default:
      throw new Error(`${label}.type is not a PermissionUpdate type`);
  }
  return value as PermissionUpdate;
}

/** The socket casts untrusted JSON; the decision reaches the SDK (and the
 *  CLI's settings writers) verbatim, so its shape is checked here. */
export function validatePermissionResult(value: unknown): PermissionResult {
  if (!isRecord(value)) throw new Error("decision must be an object");
  if (value.behavior === "deny") {
    if (typeof value.message !== "string") {
      throw new Error("decision.message must be a string");
    }
    if (value.interrupt !== undefined && typeof value.interrupt !== "boolean") {
      throw new Error("decision.interrupt must be a boolean");
    }
    return {
      behavior: "deny",
      message: value.message,
      ...(value.interrupt !== undefined && { interrupt: value.interrupt }),
    };
  }
  if (value.behavior !== "allow") {
    throw new Error("decision.behavior must be allow or deny");
  }
  if (value.updatedInput !== undefined && !isRecord(value.updatedInput)) {
    throw new Error("decision.updatedInput must be an object");
  }
  const updates = value.updatedPermissions;
  if (updates !== undefined && !Array.isArray(updates)) {
    throw new Error("decision.updatedPermissions must be an array");
  }
  return {
    behavior: "allow",
    ...(value.updatedInput !== undefined && {
      updatedInput: value.updatedInput,
    }),
    ...(updates !== undefined && {
      updatedPermissions: updates.map((update, index) =>
        validatePermissionUpdate(
          update,
          `decision.updatedPermissions[${index}]`,
        ),
      ),
    }),
  };
}
