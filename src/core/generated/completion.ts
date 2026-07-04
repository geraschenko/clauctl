// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import {
  buildRouteMap,
  proposeCompletions,
  type Command,
  type RouteMap,
} from "@stricli/core";
import {
  buildInstallCommand,
  buildUninstallCommand,
} from "@stricli/auto-complete";
import { app } from "../app.ts";
import { commandNoTarget, restArgs } from "./cli.ts";
import { type CommandContext } from "./targets.ts";

function completionInputs(inputs: readonly string[], env: NodeJS.ProcessEnv) {
  const completedInputs = inputs.slice(1);
  if (env.COMP_LINE?.endsWith(" ")) {
    completedInputs.push("");
  }
  return completedInputs;
}

export async function complete(
  this: CommandContext,
  _flags: Record<never, never>,
  ...inputs: string[]
): Promise<void> {
  try {
    for (const { completion } of await proposeCompletions(
      app,
      completionInputs(inputs, this.env),
      this,
    )) {
      this.process.stdout.write(`${completion}\n`);
    }
  } catch {
    // Completion must not make tab expansion noisy or fail the shell hook.
  }
}

const completeCommand = commandNoTarget<Record<never, never>, string[]>({
  docs: { brief: "print shell completion proposals" },
  parameters: {
    positional: restArgs("Current command line words", "word"),
  },
  func: complete,
});

// @stricli/auto-complete requires Node's concrete stdout/stderr types, but
// the commands only use write() and process.env. runCliApp supplies env on the
// Stricli process, so these commands are safe under clauctl's CommandContext.
const installCompletionCommand = buildInstallCommand("clauctl", {
  bash: "clauctl completion complete --",
}) as unknown as Command<CommandContext>;
const uninstallCompletionCommand = buildUninstallCommand("clauctl", {
  bash: true,
}) as unknown as Command<CommandContext>;

const completionRoutes = buildRouteMap({
  routes: {
    complete: completeCommand,
    install: installCompletionCommand,
    uninstall: uninstallCompletionCommand,
  },
  docs: {
    brief: "Manage shell completion",
    hideRoute: { complete: true },
  },
});

export const completionRoute: {
  readonly completion: RouteMap<CommandContext> & { readonly common?: true };
} = {
  completion: Object.assign(completionRoutes, { common: true as const }),
} as const;
