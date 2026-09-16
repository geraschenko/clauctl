/**
 * `clauctl attach --target <agent>` — run the interactive TUI in this
 * terminal as an socket client: ensure the agent's daemon is running,
 * connect, hand the terminal to runInteractive, and report how the session
 * ended. Each attacher is an independent TUI at its own terminal size.
 */

import { commandOneTarget } from "../core/generated/cli.ts";
import { oneTarget, type CommandContext } from "../core/generated/targets.ts";
import { ensureAgentRunning } from "../core/lifecycle.ts";
import { agentSocketPath } from "../core/registry.ts";
import { ProtocolClient } from "../core/protocol.ts";
import { runInteractive } from "./interactive-mode.ts";

export async function attach(this: CommandContext): Promise<void> {
  const { id: targetId } = oneTarget(this);
  const { id: agentId, agentDir } = await ensureAgentRunning(targetId);
  // The TUI is inherently Node/TTY-specific; Stricli's process type is
  // intentionally minimal, so use the real Node process interface here.
  const nodeProcess = this.process as NodeJS.Process;
  if (!nodeProcess.stdin.isTTY || !nodeProcess.stdout.isTTY) {
    throw new Error("attach requires stdin and stdout to be a terminal");
  }

  const client = await ProtocolClient.connect(agentSocketPath(agentDir));
  const outcome = await runInteractive(client, agentDir);
  switch (outcome.kind) {
    case "detached":
      nodeProcess.stdout.write(`detached from ${agentId}\n`);
      return;
    case "shutdown":
      nodeProcess.stdout.write(`agent ${agentId} ${outcome.reason}\n`);
      return;
    case "connectionLost":
      throw new Error("connection to agent daemon lost");
  }
}

const attachCommand = commandOneTarget({
  common: true,
  docs: { brief: "attach this terminal to an agent" },
  func: attach,
});

export const attachRoute = {
  attach: attachCommand,
} as const;
