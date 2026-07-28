/**
 * `clauctl tail` — the raw sdk.sock stream watcher: subscribes, prints the
 * snapshot record, then each SdkEventRecord line until the daemon closes the
 * socket, the user interrupts, or (with `--until`) the condition is met.
 *
 * TODO: Raw JSONL is the only mode in this phase; when the formatted tail lands
 * (Phase 3+) this behavior moves behind `tail --raw`.
 *
 * tail never revives: watching an agent must not restart it, so it checks the
 * daemon pid itself instead of going through ensureAgentRunning.
 */

import {
  commandOneTarget,
  completeChoices,
  parsedFlag,
  secondsFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { oneTarget, type CommandContext } from "./generated/targets.ts";
import { fileExists, UsageError } from "./generated/util.ts";
import { archivedPath, isPidAlive, sdkSocketPath } from "./registry.ts";
import { connectWithRetry } from "./sdk-socket.ts";
import { runStream } from "./generated/streaming/driver.ts";
import {
  parseUntilCondition,
  secondsToTimerMs,
  UNTIL_COMPLETIONS,
  UNTIL_USAGE,
} from "./generated/until-engine.ts";
import { untilMetAtSeed, untilMetByEvent, untilQuietMs } from "./until.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

const tailFlags = {
  until: parsedFlag(
    `Stream until ${UNTIL_USAGE}`,
    parseUntilCondition,
    "cond",
    completeChoices(UNTIL_COMPLETIONS),
  ),
  timeout: secondsFlag(),
};

type TailFlags = InferFlags<typeof tailFlags>;

async function tail(this: CommandContext, flags: TailFlags): Promise<void> {
  const condition = flags.until;
  if (flags.timeout !== undefined && condition === undefined) {
    // --timeout bounds the wait for a condition; without --until there is no
    // condition and it would silently truncate an endless stream.
    throw new UsageError("--timeout requires --until");
  }
  // Validated before the dormancy check and connection: a malformed flag is
  // a usage error regardless of the agent's state.
  const timeoutMs =
    flags.timeout === undefined ? undefined : secondsToTimerMs(flags.timeout);
  const agent = oneTarget(this);
  if (!isPidAlive(agent.daemonPid)) {
    const state = (await fileExists(archivedPath(agent.agentDir)))
      ? "archived"
      : "dormant";
    throw new Error(
      `agent '${agent.id}' is ${state}; tail never revives — send it a ` +
        `command (e.g. \`clauctl query\`) to revive it first`,
    );
  }
  const client = await connectWithRetry(
    sdkSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  const print = (record: unknown): void => {
    this.process.stdout.write(`${JSON.stringify(record)}\n`);
  };
  try {
    const { outcome } = await runStream(
      client,
      {
        onSeed: (snapshot) => {
          print({ snapshot });
          return condition !== undefined && untilMetAtSeed(condition, snapshot);
        },
        onEvent: (event, state) => {
          print({ event });
          return (
            condition !== undefined && untilMetByEvent(condition, event, state)
          );
        },
        quietMs: condition === undefined ? undefined : untilQuietMs(condition),
      },
      timeoutMs,
    );
    // Without --until, following until close is the command's whole job;
    // with it, close before the condition is a failure. A timeout is not:
    // tail was asked to watch for a bounded time, and it did.
    if (outcome === "closed" && condition !== undefined) {
      throw new Error("sdk socket closed before condition met");
    }
  } finally {
    client.close();
  }
}

export const tailRoute = {
  tail: commandOneTarget<TailFlags>({
    common: true,
    docs: { brief: "watch the agent's raw event stream" },
    parameters: { flags: tailFlags },
    func: tail,
  }),
} as const;
