/**
 * DO NOT MODIFY
 * TODO: this is an almost byte-for-byte copy of pictl's. We'll have to figure out how/if to share it between the two.
 * Target resolution for clauctl subcommands. A subcommand specifies whether it
 * takes zero, one, or multiple target agents with -t/--target. Resolving target
 * strings to AgentRecords and validating the cardinality is centralized here.
 * Setting the CLAUCTL_TARGET env var implies a target when none is specified.
 */
import {
  type CommandContext as StricliCommandContext,
  type FlagParametersForType,
  type StricliProcess,
} from "@stricli/core";
import type { AgentRecord } from "./registry.ts";
import { listAgentIds, loadAgent } from "./registry.ts";
import { UsageError } from "./util.ts";

export interface CommandContext extends StricliCommandContext {
  process: StricliProcess & { env: NodeJS.ProcessEnv };
  env: NodeJS.ProcessEnv;
  /** Empty for targetMode none; length 1 for single; length >= 1 for multiple. */
  targets: AgentRecord[];
}

const targetFlag = {
  kind: "parsed",
  parse: String,
  brief: "Target agent id or unique prefix",
  placeholder: "target",
  optional: true,
  proposeCompletions: listAgentIds,
} as const;

export const singleTargetFlags = {
  target: targetFlag,
} satisfies FlagParametersForType<{ target?: string }, CommandContext>;

export const multiTargetFlags = {
  target: { ...targetFlag, variadic: true },
} satisfies FlagParametersForType<
  { target?: readonly string[] },
  CommandContext
>;

/** @internal Exported for focused tests of target precedence/cardinality. */
export function determineTargets(
  targetMode: "none" | "single" | "multiple",
  flagTargets: readonly string[],
  env: NodeJS.ProcessEnv,
): string[] {
  switch (targetMode) {
    case "none":
      if (flagTargets.length > 0) {
        throw new UsageError("this command does not accept --target");
      }
      return [];
    case "single": {
      if (flagTargets.length > 1) {
        throw new UsageError("expected at most one --target");
      }
      const target = flagTargets[0] ?? env.CLAUCTL_TARGET;
      if (target === undefined || target === "") {
        throw new UsageError("expected --target <agent> (or CLAUCTL_TARGET)");
      }
      return [target];
    }
    case "multiple": {
      if (flagTargets.length > 0) {
        return [...flagTargets];
      }
      if (env.CLAUCTL_TARGET !== undefined && env.CLAUCTL_TARGET !== "") {
        return [env.CLAUCTL_TARGET];
      }
      throw new UsageError(
        "expected at least one --target <agent> (or CLAUCTL_TARGET)",
      );
    }
  }
}

export async function resolveTargets(
  targetInputs: readonly string[],
): Promise<AgentRecord[]> {
  return await Promise.all(targetInputs.map((target) => loadAgent(target)));
}

export function oneTarget(context: CommandContext): AgentRecord {
  const target = context.targets[0];
  if (target === undefined || context.targets.length !== 1) {
    throw new Error(`internal error: expected exactly one target`);
  }
  return target;
}

export function multiTargets(context: CommandContext): readonly AgentRecord[] {
  if (context.targets.length === 0) {
    throw new Error(`internal error: expected at least one target`);
  }
  return context.targets;
}
