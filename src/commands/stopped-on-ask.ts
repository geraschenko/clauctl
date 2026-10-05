import { isStoppedOnAsk } from "../core/agent-state/index.ts";
import type { AgentState } from "../core/protocol/index.ts";
import { ExitCodeError } from "../core/generated/util.ts";
import { pendingAskLines } from "../format/events.ts";

/** Why an `--until` wait stops on an observation, if it does. A pending
 *  ask wins over every condition: exit 0 means "prompt next", exit 4
 *  means "answer with permission-response next". */
export type UntilStopReason = "met" | "stoppedOnAsk" | undefined;

export const untilStopReason = (
  met: boolean,
  state: AgentState,
): UntilStopReason =>
  isStoppedOnAsk(state) ? "stoppedOnAsk" : met ? "met" : undefined;

/** An `--until` wait stopped because the agent is stopped on an ask
 *  (`isStoppedOnAsk`): exit 4. Answer with `clauctl permission-response`. */
export class StoppedOnAskError extends ExitCodeError {
  readonly exitCode: number = 4;
  constructor(state: AgentState, header = "stopped on a permission ask:") {
    super([header, ...pendingAskLines(state)].join("\n"));
    this.name = "StoppedOnAskError";
  }
}

/** `prompt` stopped on an ask after queueing its prompt, which runs once
 *  the ask is answered: exit 5. */
export class QueuedBehindAskError extends StoppedOnAskError {
  override readonly exitCode = 5;
  constructor(state: AgentState) {
    super(state, "prompt queued; stopped on a permission ask:");
    this.name = "QueuedBehindAskError";
  }
}
