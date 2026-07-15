import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import { type CommandContext } from "./generated/targets.ts";
import { attachRoute } from "./generated/attach.ts";
import { completionRoute } from "./generated/completion.ts";
import { internalRoutes } from "./daemon/daemon.ts";
import { listRoute, statusRoute } from "./inspect.ts";
import { gcRoute, lifecycleRoutes } from "./lifecycle.ts";
import { sdkRoutes } from "./sdk-commands.ts";
import { spawnRoute } from "./spawn.ts";
import { tailRoute } from "./tail.ts";
import { tuiRoute } from "../tui/interactive-mode.ts";
import { UsageError } from "./generated/util.ts";
import { VERSION } from "./generated/version.ts";

const routes = {
  ...spawnRoute,
  ...listRoute,
  ...statusRoute,
  ...lifecycleRoutes,
  ...gcRoute,
  ...sdkRoutes,
  ...attachRoute,
  ...tailRoute,
  ...tuiRoute,
  ...completionRoute,
  ...internalRoutes,
};

function routeIsCommon(route: unknown): boolean {
  return (route as { common?: true }).common === true;
}

const hideRoute = Object.fromEntries(
  Object.entries(routes)
    .filter(([, route]) => !routeIsCommon(route))
    .map(([name]) => [name, true]),
);

const root = buildRouteMap({
  routes,
  docs: {
    brief: "Spawn, observe, control, and attach to claude agents",
    hideRoute,
  },
});

export const app = buildApplication<CommandContext>(root, {
  name: "clauctl",
  versionInfo: { currentVersion: VERSION },
  scanner: {
    caseStyle: "allow-kebab-for-camel",
    allowArgumentEscapeSequence: true,
  },
  documentation: {
    useAliasInUsageLine: true,
    alwaysShowHelpAllFlag: true,
  },
  completion: {
    includeAliases: true,
    includeHiddenRoutes: true,
  },
  localization: {
    text: {
      ...text_en,
      exceptionWhileParsingArguments(exc, ansiColor) {
        if (exc instanceof UsageError) {
          return exc.message;
        }
        return text_en.exceptionWhileParsingArguments.call(
          this,
          exc,
          ansiColor,
        );
      },
      exceptionWhileRunningCommand(exc, ansiColor) {
        if (exc instanceof Error) {
          return exc.message;
        }
        return text_en.exceptionWhileRunningCommand.call(this, exc, ansiColor);
      },
      commandErrorResult(err) {
        return err.message;
      },
    },
  },
  determineExitCode: (error) => (error instanceof UsageError ? 2 : 1),
});
