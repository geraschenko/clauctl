import {
  type Application,
  buildApplication,
  buildRouteMap,
  text_en,
} from "@stricli/core";
import { type CommandContext } from "./core/generated/targets.ts";
import { attachRoute } from "./commands/attach.ts";
import { completionRoute } from "./core/generated/completion.ts";
import { internalRoutes } from "./core/protocol-server/index.ts";
import { listRoute, statusRoute } from "./commands/inspect.ts";
import { gcRoute, lifecycleRoutes } from "./commands/lifecycle.ts";
import { formatRoute } from "./commands/format.ts";
import { promptRoute } from "./commands/prompt.ts";
import { sdkRoutes } from "./commands/sdk-commands.ts";
import { spawnRoute } from "./commands/spawn.ts";
import { tailRoute } from "./commands/tail.ts";
import { UntilTimeoutError } from "./core/generated/until-engine.ts";
import { UsageError } from "./core/generated/util.ts";
import { VERSION } from "./core/generated/version.ts";
import { waitRoute } from "./commands/wait.ts";

const routes = {
  ...spawnRoute,
  ...listRoute,
  ...statusRoute,
  ...lifecycleRoutes,
  ...gcRoute,
  ...sdkRoutes,
  ...promptRoute,
  ...attachRoute,
  ...tailRoute,
  ...waitRoute,
  ...formatRoute,
  ...completionRoute(() => app),
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

export const app: Application<CommandContext> = buildApplication(root, {
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
  determineExitCode: (error) =>
    error instanceof UsageError
      ? 2
      : error instanceof UntilTimeoutError
        ? 3
        : 1,
});
