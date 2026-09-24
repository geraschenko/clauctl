// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import {
  buildRouteMap,
  proposeCompletions,
  type Application,
  type Command,
  type RouteMap,
} from "@stricli/core";
import {
  buildInstallCommand,
  buildUninstallCommand,
} from "@stricli/auto-complete";
import { commandNoTarget, restArgs } from "./cli.ts";
import { type CommandContext } from "./targets.ts";

function completionInputs(inputs: readonly string[], env: NodeJS.ProcessEnv) {
  const completedInputs = inputs.slice(1);
  if (env.COMP_LINE?.endsWith(" ")) {
    completedInputs.push("");
  }
  return completedInputs;
}

/** The app is read lazily: the route is part of the app being built. */
function completeCommand(
  app: () => Application<CommandContext>,
): Command<CommandContext> {
  return commandNoTarget<Record<never, never>, string[]>({
    docs: { brief: "print shell completion proposals" },
    parameters: {
      positional: restArgs("Current command line words", "word"),
    },
    async func(this: CommandContext, _flags, ...inputs: string[]) {
      try {
        for (const { completion } of await proposeCompletions(
          app(),
          completionInputs(inputs, this.env),
          this,
        )) {
          this.process.stdout.write(`${completion}\n`);
        }
      } catch {
        // Completion must not make tab expansion noisy or fail the shell hook.
      }
    },
  });
}

// @stricli/auto-complete requires Node's concrete stdout/stderr types, but
// the commands only use write() and process.env. runCliApp supplies env on the
// Stricli process, so these commands are safe under clauctl's CommandContext.
const installCompletionCommand = buildInstallCommand("clauctl", {
  bash: "clauctl completion complete --",
}) as unknown as Command<CommandContext>;
const uninstallCompletionCommand = buildUninstallCommand("clauctl", {
  bash: true,
}) as unknown as Command<CommandContext>;

export function completionRoute(app: () => Application<CommandContext>): {
  readonly completion: RouteMap<CommandContext> & { readonly common?: true };
} {
  const completionRoutes = buildRouteMap({
    routes: {
      complete: completeCommand(app),
      install: installCompletionCommand,
      uninstall: uninstallCompletionCommand,
    },
    docs: {
      brief: "Manage shell completion",
      hideRoute: { complete: true },
    },
  });
  return {
    completion: Object.assign(completionRoutes, { common: true as const }),
  };
}
