/*
 * `clauctl wait --target <agent> --until turn-end|idle|no-activity:<secs>` —
 * block until the agent meets a condition. Exit codes: 0 condition met,
 * 1 runtime error (including socket closed while waiting), 2 usage error,
 * 3 `--timeout` expired.
 *
 * A dormant or archived agent is reported as having met any of these
 * conditions immediately — its process is doing nothing, which is conclusive
 * inactivity (deliberately overriding no-activity's never-met-at-seed rule).
 * Never revives: a revived agent is guaranteed idle anyway. The pid check is
 * moment-in-time; a concurrent revival racing it is accepted.
 */

import {
  commandOneTarget,
  completeChoices,
  requiredParsedFlag,
  secondsFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { oneTarget, type CommandContext } from "./generated/targets.ts";
import { isPidAlive, sdkSocketPath } from "./registry.ts";
import { connectWithRetry } from "./sdk-socket.ts";
import { runStream } from "./generated/streaming/driver.ts";
import {
  parseUntilCondition,
  secondsToTimerMs,
  UNTIL_COMPLETIONS,
  UNTIL_USAGE,
  UntilTimeoutError,
} from "./generated/until-engine.ts";
import { untilMetAtSeed, untilMetByEvent, untilQuietMs } from "./until.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

const waitFlags = {
  until: requiredParsedFlag(
    `Wait condition (${UNTIL_USAGE})`,
    parseUntilCondition,
    "cond",
    completeChoices(UNTIL_COMPLETIONS),
  ),
  timeout: secondsFlag(),
};

type WaitFlags = InferFlags<typeof waitFlags>;

export async function wait(
  this: CommandContext,
  flags: WaitFlags,
): Promise<void> {
  // Validated before the dormancy fast path: a malformed flag is a usage
  // error regardless of the agent's state.
  const timeoutMs =
    flags.timeout === undefined ? undefined : secondsToTimerMs(flags.timeout);
  const agent = oneTarget(this);
  if (!isPidAlive(agent.daemonPid)) {
    return;
  }
  const condition = flags.until;
  const client = await connectWithRetry(
    sdkSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  try {
    const { outcome } = await runStream(
      client,
      {
        onSeed: (seed) => untilMetAtSeed(condition, seed),
        onEvent: (event, state) => untilMetByEvent(condition, event, state),
        quietMs: untilQuietMs(condition),
      },
      timeoutMs,
    );
    if (outcome === "closed") {
      throw new Error("sdk socket closed before condition met");
    }
    // wait's whole job is the condition holding, so running out of time is a
    // failure — the exit-3 path.
    if (outcome === "timeout") {
      throw new UntilTimeoutError(`condition not met within ${flags.timeout}s`);
    }
  } finally {
    client.close();
  }
}

export const waitRoute = {
  wait: commandOneTarget<WaitFlags>({
    docs: { brief: "block until the agent meets a condition" },
    parameters: { flags: waitFlags },
    func: wait,
  }),
} as const;
