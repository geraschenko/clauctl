/**
 * `clauctl tail` — the raw sdk.sock stream watcher: subscribes, prints the
 * snapshot record, then each SdkEventRecord line until the daemon closes the
 * socket or the user interrupts.
 * 
 * TODO: Raw JSONL is the only mode in this phase; when the formatted tail lands
 * (Phase 3+) this behavior moves behind `tail --raw`.
 *
 * tail never revives: watching an agent must not restart it, so it checks the
 * daemon pid itself instead of going through ensureAgentRunning.
 */

import { commandOneTarget } from "./generated/cli.ts";
import { oneTarget, type CommandContext } from "./generated/targets.ts";
import { fileExists } from "./generated/util.ts";
import { archivedPath, isPidAlive, sdkSocketPath } from "./registry.ts";
import { connectWithRetry, type SdkEvent } from "./sdk-socket.ts";

const SOCKET_CONNECT_DEADLINE_MS = 5_000;

async function tail(this: CommandContext): Promise<void> {
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
  // onEvent can fire before subscribe() resolves (event lines racing the
  // response's microtask), so gate on the snapshot to keep the output order:
  // snapshot line first, then events in stream order.
  let snapshotPrinted = false;
  const preSnapshot: SdkEvent[] = [];
  const snapshot = await client.subscribe((event) => {
    if (snapshotPrinted) {
      print({ event });
    } else {
      preSnapshot.push(event);
    }
  });
  print({ snapshot });
  snapshotPrinted = true;
  for (const event of preSnapshot.splice(0)) {
    print({ event });
  }
  await client.waitClosed();
}

export const tailRoute = {
  tail: commandOneTarget({
    common: true,
    docs: { brief: "watch the agent's raw event stream" },
    func: tail,
  }),
} as const;
