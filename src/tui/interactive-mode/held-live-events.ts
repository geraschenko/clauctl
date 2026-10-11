import type { AgentEvent, AgentState } from "../../core/protocol/index.ts";

/** Live events held back while history replays, so live output cannot
 *  interleave with or precede the replayed transcript. */
export class HeldLiveEvents {
  private readonly held: Array<readonly [AgentEvent, AgentState]> = [];
  private cutAwaiter: { position: number; resolve: () => void } | undefined;

  hold(event: AgentEvent, state: AgentState): void {
    this.held.push([event, state]);
    if (
      this.cutAwaiter !== undefined &&
      this.held.length >= this.cutAwaiter.position
    ) {
      this.cutAwaiter.resolve();
      this.cutAwaiter = undefined;
    }
  }

  /** Once `position` events are held: the state they folded to (`seed`
   *  when position is 0). One wait at a time. `position` counts events
   *  pushed to the subscription, which runs ahead of the pump that holds
   *  them here; a shutdown inside the cut is never held, so the wait then
   *  stays pending — moot, the mode is finishing. */
  stateAtCut(position: number, seed: AgentState): Promise<AgentState> {
    const cutState = (): AgentState =>
      position === 0 ? seed : this.held[position - 1]![1];
    return this.held.length >= position
      ? Promise.resolve(cutState())
      : new Promise((resolve) => {
          this.cutAwaiter = { position, resolve: () => resolve(cutState()) };
        });
  }

  /** Everything held, in arrival order. */
  get events(): readonly (readonly [AgentEvent, AgentState])[] {
    return this.held;
  }
}
