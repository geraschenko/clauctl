/*
 * The fold driver for sdk.sock stream consumers: streaming is intrinsically a
 * fold — each event updates state, emits output, and decides whether to stop,
 * in one step — matching the nextAgentState architecture. This replaces
 * pictl's listener-racing design and is intended for a later pictl handoff
 * (docs/specs/wait-and-tail-until.md, Non-goals).
 */

import { nextAgentState, type AgentState } from "./agent-state.ts";
import { UntilTimeoutError } from "./until.ts";
import type { SdkEvent } from "./sdk-socket.ts";

/** The slice of SdkSocketClient the driver needs; a narrow interface so
 *  tests can drive runStream with a fake (the concrete class has private
 *  members, so no structural fake could satisfy it). */
export interface StreamClient {
  subscribe(onEvent: (event: SdkEvent) => void): Promise<AgentState>;
  waitClosed(): Promise<void>;
}

/**
 * A stream consumer as a fold step: each hook may emit output and returns
 * whether to stop. Consumer-specific state (e.g. a formatted printer's
 * pending tool calls, later spec) lives in the handler's closure.
 */
export interface StreamHandler {
  /** Called once with the subscribe seed; return true to stop before any
   *  event. */
  onSeed(seed: AgentState): boolean;
  /** Called per event with the post-fold state; return true to stop. */
  onEvent(event: SdkEvent, state: AgentState): boolean;
  /** Stop successfully after this much event silence; undefined = never. */
  quietMs?: number;
}

/** "done" = handler or quiet-timer stop; "closed" = socket closed (callers
 *  needing an error produce e.g. "sdk socket closed before condition met"). */
export type StreamOutcome = "done" | "closed";

/**
 * Subscribe on `client`, fold `nextAgentState` over the pushed events, and
 * drive `handler`. Contract:
 * - `onSeed` runs exactly once, before any `onEvent`; events dispatched
 *   before the subscribe promise settles are buffered and processed after it.
 * - Per event, in order: fold state, call `onEvent` (which prints), then act
 *   on its stop decision — so a satisfying event is always emitted before
 *   the stream stops.
 * - First settlement wins; after it, later event callbacks are ignored (the
 *   client has no unsubscribe, and one socket chunk can dispatch several
 *   event lines synchronously) and both timers are cleared on every path — a
 *   pending timer is an active handle that keeps node's event loop (and thus
 *   the CLI process) alive until it fires, even though the losing promise is
 *   discarded.
 * - Both timers arm after `onSeed` returns false — seed satisfaction takes
 *   precedence, and connection/subscribe latency never counts against the
 *   deadline. The quiet timer resets as each event is processed. Deadline
 *   expiry rejects with UntilTimeoutError, taking precedence on ties.
 * - Exceptions thrown by hooks or the fold reject the returned promise; they
 *   must not escape into the socket's data listener.
 */
export function runStream(
  client: StreamClient,
  handler: StreamHandler,
  timeoutMs: number | undefined,
): Promise<StreamOutcome> {
  return new Promise<StreamOutcome>((resolve, reject) => {
    let settled = false;
    let quietTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const settle = (finish: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(deadlineTimer);
      finish();
    };
    const settleWithError = (error: unknown): void => {
      settle(() =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
    };
    const resetQuietTimer = (): void => {
      // The settled guard covers a reentrant handler settling the stream
      // mid-onEvent: nothing may re-arm a timer after settlement.
      if (settled || handler.quietMs === undefined) {
        return;
      }
      clearTimeout(quietTimer);
      quietTimer = setTimeout(
        () => settle(() => resolve("done")),
        handler.quietMs,
      );
    };

    // undefined until the seed is processed; pre-seed arrivals are buffered.
    let state: AgentState | undefined;
    const preSeedEvents: SdkEvent[] = [];
    const processEvent = (event: SdkEvent): void => {
      state = nextAgentState(state!, event);
      if (handler.onEvent(event, state)) {
        settle(() => resolve("done"));
      } else {
        resetQuietTimer();
      }
    };

    client
      .subscribe((event) => {
        if (settled) {
          return;
        }
        if (state === undefined) {
          preSeedEvents.push(event);
          return;
        }
        try {
          processEvent(event);
        } catch (error) {
          settleWithError(error);
        }
      })
      .then(
        (seed) => {
          if (settled) {
            return;
          }
          try {
            if (handler.onSeed(seed)) {
              settle(() => resolve("done"));
              return;
            }
            state = seed;
            // Deadline before quiet timer: with equal delays, node fires the
            // earlier registration first, so the deadline wins ties.
            if (timeoutMs !== undefined) {
              deadlineTimer = setTimeout(
                () =>
                  settle(() =>
                    reject(
                      new UntilTimeoutError(
                        `condition not met within ${timeoutMs / 1000}s`,
                      ),
                    ),
                  ),
                timeoutMs,
              );
            }
            resetQuietTimer();
            for (const event of preSeedEvents.splice(0)) {
              if (settled) {
                return;
              }
              processEvent(event);
            }
          } catch (error) {
            settleWithError(error);
          }
        },
        (error: unknown) => settleWithError(error),
      );
    void client.waitClosed().then(() => settle(() => resolve("closed")));
  });
}
