// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/**
 * I (geraschenko) don't entirely know what I'm doing here. It's possible
 * there's a cli library out there that just does all this more cleanly. The
 * goals:
 * - Subcommands should be pretty easy to define and maintain, keeping
 *   information about the types of arguments/flags, the help text, and the
 *   subcommand definition all next to each other in code.
 * - A subcommand of clauctl must specify whether takes zero, one, or multiple
 *   target agents with -t/--target. The resolution of targets to AgentRecords
 *   and the validation of the correct number of targets should be centralized
 *   (currently in target.ts). I want to be able to set the CLAUCTL_TARGET env var
 *   to imply a target when there's no target(s) specified.
 */
import {
  buildCommand,
  run,
  type Aliases,
  type Command,
  type CommandFunction,
  type FlagParametersForType,
  type StricliProcess,
  type TypedCommandParameters,
  type TypedFlagParameter,
  type TypedPositionalParameters,
} from "@stricli/core";
import type { Application } from "@stricli/core";
import {
  auditEnabled,
  recordAuditEvent,
  resolveCallerSource,
} from "./audit.ts";
import {
  determineTargets,
  multiTargetFlags,
  resolveTargets,
  singleTargetFlags,
  type CommandContext,
} from "./targets.ts";
import { UsageError } from "./util.ts";

type CommandRoute = Command<CommandContext> & { common?: true };

type CommandFlagsConstraint<T> = Readonly<Partial<Record<keyof T, unknown>>>;

type Parameters<
  FLAGS extends CommandFlagsConstraint<FLAGS>,
  ARGS extends readonly unknown[],
> = {
  flags?: FlagParametersForType<FLAGS, CommandContext>;
  aliases?: Aliases<keyof FLAGS & string>;
  positional?: TypedPositionalParameters<ARGS, CommandContext>;
};

interface CommandSpec<
  FLAGS extends CommandFlagsConstraint<FLAGS>,
  ARGS extends readonly unknown[],
> {
  /** Marker field: commands are hidden from default help unless marked common. */
  common?: true;
  docs: {
    brief: string;
    fullDescription?: string;
    customUsage?: readonly string[];
  };
  parameters?: Parameters<FLAGS, ARGS>;
  /** Marker: write an audit event to each target before func runs. */
  audited?: true;
  func: CommandFunction<FLAGS, ARGS, CommandContext>;
}

/**
 * Record one audit-attempt event per agent dir, attributed to the invoking
 * process's caller source. The choke point for audited commands: called by
 * the target-resolving wrappers below after resolveTargets and before the
 * command func runs; `spawn` (no-target — the agent dir does not exist until
 * mid-command) calls it directly after creating the dir. Errors propagate
 * and fail the command loudly (a missing agent dir means the command could
 * not have worked anyway).
 */
export async function recordCommandAudit(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  agentDirs: readonly string[],
): Promise<void> {
  if (!auditEnabled(env)) {
    return;
  }
  const { source, manager } = resolveCallerSource(env.CLAUCTL_ID, process.ppid);
  const ts = new Date().toISOString();
  for (const agentDir of agentDirs) {
    await recordAuditEvent(agentDir, { ts, source, argv: [...argv] }, manager);
  }
}

export type CompletionFn = (
  partial: string,
) => readonly string[] | Promise<readonly string[]>;

export function completeChoices<const VALUES extends readonly string[]>(
  values: VALUES,
): CompletionFn {
  return (partial: string) =>
    values.filter((value) => value.startsWith(partial));
}

// This symbol is never created at runtime. It is a "phantom" property used
// only by TypeScript so a Stricli flag parameter can remember the value type
// it will produce after parsing.
declare const flagValue: unique symbol;

export type CliFlag<T, PARAMETER> = PARAMETER & {
  readonly [flagValue]: T;
};

export type InferFlagValue<TFlag> = TFlag extends {
  readonly [flagValue]: infer T;
}
  ? T
  : never;

// Optional object properties are different from required properties whose value
// can be undefined. This helper finds the flags whose phantom value includes
// undefined so InferFlags can turn `string | undefined` into `name?: string`.
export type OptionalFlagKeys<TFlags extends Record<string, unknown>> = {
  readonly [K in keyof TFlags]: undefined extends InferFlagValue<TFlags[K]>
    ? K
    : never;
}[keyof TFlags];

export type RequiredFlagKeys<TFlags extends Record<string, unknown>> = Exclude<
  keyof TFlags,
  OptionalFlagKeys<TFlags>
>;

// Derive the implementation-facing flags object from a flag-spec object:
// - booleanFlag(...) becomes `name: boolean`
// - optionalBooleanFlag(...) becomes `name?: boolean`
// - variadicStringFlag(...) becomes `name: readonly string[]`
// - stringFlag(...) becomes `name?: string`
// The runtime flag specs remain ordinary Stricli parameters; the phantom type
// information only exists to make this mapped type possible.
export type InferFlags<TFlags extends Record<string, unknown>> = {
  readonly [K in RequiredFlagKeys<TFlags>]: InferFlagValue<TFlags[K]>;
} & {
  readonly [K in OptionalFlagKeys<TFlags>]?: Exclude<
    InferFlagValue<TFlags[K]>,
    undefined
  >;
};

// The helper bodies use casts because Stricli's TypedFlagParameter is a
// conditional type: TypeScript cannot prove that a generic object literal is
// the right branch for every T. Keeping the casts here centralizes that
// unsafety; command modules still receive checked, inferred flag types.
export function booleanFlag(
  brief: string,
): CliFlag<boolean, TypedFlagParameter<boolean, CommandContext>> {
  return {
    kind: "boolean",
    brief,
    default: false,
  } as unknown as CliFlag<boolean, TypedFlagParameter<boolean, CommandContext>>;
}

/** A boolean flag that is `undefined` when not given, so the caller can
 *  fall back elsewhere; Stricli accepts `--no-<name>` for `false`. */
export function optionalBooleanFlag(
  brief: string,
): CliFlag<
  boolean | undefined,
  TypedFlagParameter<boolean | undefined, CommandContext>
> {
  return {
    kind: "boolean",
    brief,
    optional: true,
  } as unknown as CliFlag<
    boolean | undefined,
    TypedFlagParameter<boolean | undefined, CommandContext>
  >;
}

export function stringFlag(
  brief: string,
  placeholder: string,
  proposeCompletions?: CompletionFn,
): CliFlag<
  string | undefined,
  TypedFlagParameter<string | undefined, CommandContext>
> {
  return {
    kind: "parsed",
    parse: String,
    brief,
    placeholder,
    optional: true,
    proposeCompletions,
  } as unknown as CliFlag<
    string | undefined,
    TypedFlagParameter<string | undefined, CommandContext>
  >;
}

export function variadicStringFlag(
  brief: string,
  placeholder: string,
  proposeCompletions?: CompletionFn,
): CliFlag<
  readonly string[],
  TypedFlagParameter<readonly string[], CommandContext>
> {
  return {
    kind: "parsed",
    parse: String,
    brief,
    placeholder,
    variadic: true,
    default: [],
    proposeCompletions,
  } as unknown as CliFlag<
    readonly string[],
    TypedFlagParameter<readonly string[], CommandContext>
  >;
}

export function enumFlag<const VALUES extends readonly [string, ...string[]]>(
  brief: string,
  values: VALUES,
): CliFlag<
  VALUES[number] | undefined,
  TypedFlagParameter<VALUES[number] | undefined, CommandContext>
> {
  return {
    kind: "enum",
    values,
    brief,
    optional: true,
  } as unknown as CliFlag<
    VALUES[number] | undefined,
    TypedFlagParameter<VALUES[number] | undefined, CommandContext>
  >;
}

export function parsedFlag<T>(
  brief: string,
  parse: (input: string) => T,
  placeholder: string,
  proposeCompletions?: CompletionFn,
): CliFlag<T | undefined, TypedFlagParameter<T | undefined, CommandContext>> {
  return {
    kind: "parsed",
    parse,
    brief,
    placeholder,
    optional: true,
    proposeCompletions,
  } as unknown as CliFlag<
    T | undefined,
    TypedFlagParameter<T | undefined, CommandContext>
  >;
}

export function requiredParsedFlag<T>(
  brief: string,
  parse: (input: string) => T,
  placeholder: string,
  proposeCompletions?: CompletionFn,
): CliFlag<T, TypedFlagParameter<T, CommandContext>> {
  return {
    kind: "parsed",
    parse,
    brief,
    placeholder,
    proposeCompletions,
  } as unknown as CliFlag<T, TypedFlagParameter<T, CommandContext>>;
}

export function requiredStringFlag(
  brief: string,
  placeholder: string,
  proposeCompletions?: CompletionFn,
): CliFlag<string, TypedFlagParameter<string, CommandContext>> {
  return requiredParsedFlag(brief, String, placeholder, proposeCompletions);
}

export function secondsFlag(brief = "Timeout in seconds") {
  return parsedFlag(
    brief,
    (input: string): number => {
      const seconds = Number(input);
      if (!(Number.isFinite(seconds) && seconds >= 0)) {
        throw new UsageError(`invalid seconds value: ${input}`);
      }
      return seconds;
    },
    "secs",
  );
}

export function restArgs(brief: string, placeholder: string, minimum = 0) {
  return {
    kind: "array",
    minimum,
    parameter: { brief, placeholder, parse: String },
  } as const;
}

export function stringArg(
  brief: string,
  placeholder: string,
  proposeCompletions?: CompletionFn,
) {
  return { brief, placeholder, parse: String, proposeCompletions } as const;
}

function markCommon(
  command: Command<CommandContext>,
  common: true | undefined,
): CommandRoute {
  return Object.assign(command, { common });
}

export function commandNoTarget<
  FLAGS extends CommandFlagsConstraint<FLAGS> = Record<never, never>,
  ARGS extends readonly unknown[] = [],
>(spec: CommandSpec<FLAGS, ARGS>): CommandRoute {
  return markCommon(
    buildCommand<FLAGS, ARGS, CommandContext>({
      func: async function (this: CommandContext, flags: FLAGS, ...args: ARGS) {
        this.targets = [];
        await spec.func.call(this, flags, ...args);
      },
      parameters: (spec.parameters ?? {}) as TypedCommandParameters<
        FLAGS,
        ARGS,
        CommandContext
      >,
      docs: spec.docs,
    }),
    spec.common,
  );
}

export function commandOneTarget<
  FLAGS extends CommandFlagsConstraint<FLAGS> = Record<never, never>,
  ARGS extends readonly unknown[] = [],
>(spec: CommandSpec<FLAGS, ARGS>): CommandRoute {
  type AugmentedFlags = FLAGS & { target?: string };
  return markCommon(
    buildCommand<AugmentedFlags, ARGS, CommandContext>({
      func: async function (
        this: CommandContext,
        flags: AugmentedFlags,
        ...args: ARGS
      ) {
        const { target, ...commandFlags } = flags;
        this.targets = await resolveTargets(
          determineTargets(
            "single",
            target === undefined ? [] : [target],
            this.env,
          ),
        );
        if (spec.audited) {
          await recordCommandAudit(
            this.env,
            this.argv,
            this.targets.map((agent) => agent.agentDir),
          );
        }
        await spec.func.call(this, commandFlags as FLAGS, ...args);
      },
      parameters: {
        flags: { ...(spec.parameters?.flags ?? {}), ...singleTargetFlags },
        aliases: { t: "target", ...(spec.parameters?.aliases ?? {}) },
        ...(spec.parameters?.positional === undefined
          ? {}
          : { positional: spec.parameters.positional }),
      } as unknown as TypedCommandParameters<
        AugmentedFlags,
        ARGS,
        CommandContext
      >,
      docs: spec.docs,
    }),
    spec.common,
  );
}

export function commandMultiTarget<
  FLAGS extends CommandFlagsConstraint<FLAGS> = Record<never, never>,
  ARGS extends readonly unknown[] = [],
>(spec: CommandSpec<FLAGS, ARGS>): CommandRoute {
  type AugmentedFlags = FLAGS & { target?: readonly string[] };
  return markCommon(
    buildCommand<AugmentedFlags, ARGS, CommandContext>({
      func: async function (
        this: CommandContext,
        flags: AugmentedFlags,
        ...args: ARGS
      ) {
        const { target, ...commandFlags } = flags;
        this.targets = await resolveTargets(
          determineTargets("multiple", target ?? [], this.env),
        );
        if (spec.audited) {
          await recordCommandAudit(
            this.env,
            this.argv,
            this.targets.map((agent) => agent.agentDir),
          );
        }
        await spec.func.call(this, commandFlags as FLAGS, ...args);
      },
      parameters: {
        flags: { ...(spec.parameters?.flags ?? {}), ...multiTargetFlags },
        aliases: { t: "target", ...(spec.parameters?.aliases ?? {}) },
        ...(spec.parameters?.positional === undefined
          ? {}
          : { positional: spec.parameters.positional }),
      } as unknown as TypedCommandParameters<
        AugmentedFlags,
        ARGS,
        CommandContext
      >,
      docs: spec.docs,
    }),
    spec.common,
  );
}

export async function runCliApp(
  app: Application<CommandContext>,
  argv: readonly string[],
  proc: StricliProcess & { env?: NodeJS.ProcessEnv } = process,
): Promise<void> {
  proc.exitCode = undefined;
  const env = proc.env ?? process.env;
  await run(app, argv, {
    process: Object.assign(proc, { env }),
    env,
    targets: [],
    argv,
  });
  if (typeof proc.exitCode === "number" && proc.exitCode < 0) {
    proc.exitCode = 2;
  }
}
