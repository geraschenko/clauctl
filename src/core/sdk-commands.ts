/**
 * The minimal Phase-1 SDK command channel: `query`, `interrupt`, `set-model`,
 * `set-permission-mode` — just enough to exercise the Phase-1 success
 * criteria over sdk.sock. The analog of pictl's rpc-commands.ts; fleshed out
 * to the full `Query` surface in Phase 2.
 *
 * Every subcommand takes the agent as --target (reviving a dormant agent
 * transparently), sends one request over the agent's sdk.sock, and prints the
 * response data as JSON if there is any.
 */

import {
  commandOneTarget,
  completeChoices,
  enumFlag,
  stringArg,
  stringFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { oneTarget, type CommandContext } from "./generated/targets.ts";
import { ensureAgentRunning } from "./lifecycle.ts";
import { sdkSocketPath } from "./registry.ts";
import { connectWithRetry, type SdkRequest } from "./sdk-socket.ts";
import { oneOf } from "./generated/util.ts";

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

async function sendRequest(
  context: CommandContext,
  request: SdkRequest,
): Promise<void> {
  const agent = await ensureAgentRunning(oneTarget(context).id);
  const client = await connectWithRetry(
    sdkSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  try {
    const data = await client.request(request);
    if (data !== undefined) {
      context.process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }
  } finally {
    client.close();
  }
}

const queryFlags = {
  priority: enumFlag("Echo placement (now|next|later)", PRIORITIES),
};

type QueryFlags = InferFlags<typeof queryFlags>;

async function queryCommand(
  this: CommandContext,
  flags: QueryFlags,
  text: string,
): Promise<void> {
  await sendRequest(this, {
    type: "query",
    text,
    ...(flags.priority !== undefined && { priority: flags.priority }),
  });
}

async function interrupt(this: CommandContext): Promise<void> {
  await sendRequest(this, { type: "interrupt" });
}

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
    func: queryCommand,
  }),
  interrupt: commandOneTarget({
    docs: { brief: "interrupt the current turn" },
    func: interrupt,
  }),
  "set-model": commandOneTarget<SetModelFlags>({
    docs: { brief: "change the agent's model" },
    parameters: { flags: setModelFlags },
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
    func: setPermissionMode,
  }),
} as const;
