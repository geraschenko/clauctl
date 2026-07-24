// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/*
 * The generic driver for socket stream consumers: streaming is intrinsically
 * a fold — each event updates state, emits output, and decides whether to
 * stop, in one step. The fold itself lives in the socket client, which
 * delivers each event paired with its post-fold state; the pairing is
 * load-bearing — with async handlers the client's live state can run ahead
 * of the event being processed, so handlers must judge each event against
 * the state snapshot taken when it was dispatched, not the current one.
 *
 * This file is repo-agnostic and consumed verbatim by the consuming repo's
 * sync script: it may import only other synced files (until-engine.ts). The
 * event type `TEvent` and session-state type `TState` are parameters,
 * instantiated over the consuming repo's socket event and session state.
 */

import { UntilTimeoutError } from "./until-engine.ts";

/** The slice of the socket client the driver needs; a narrow interface so
 *  tests can drive runStream with a fake (the concrete class has private
 *  members, so no structural fake could satisfy it). */
export interface StreamClient<TEvent, TState> {
  subscribe(onEvent: (event: TEvent, state: TState) => void): Promise<TState>;
  waitClosed(): Promise<void>;
}

/**
 * A stream consumer: each hook may emit output (possibly via RPCs — hence
 * async) and returns whether to stop. Consumer-specific state (e.g. an
 * entries cursor) lives in the handler's closure.
 */
export interface StreamHandler<TEvent, TState> {
  /** Called once with the subscribe seed; return true to stop before any
   *  event. */
  onSeed(seed: TState): boolean | Promise<boolean>;
  /** Called per event with the post-fold state; return true to stop. */
  onEvent(event: TEvent, state: TState): boolean | Promise<boolean>;
  /** Stop successfully after this much event silence; undefined = never. */
  quietMs?: number;
}

export interface StreamResult<TState> {
  /** "done" = handler or quiet-timer stop; "closed" = socket closed (callers
   *  needing an error produce e.g. "socket closed before condition met"). */
  outcome: "done" | "closed";
  /** State delivered with the last processed event (the seed if none) —
   *  callers read stream-end facts like sessionId from here. */
  state: TState;
}

/**
 * Subscribe on `client` and drive `handler` over the pushed (event, state)
 * pairs. Contract:
 * - `onSeed` runs exactly once, before any `onEvent`; pairs dispatched
 *   before the subscribe promise settles are queued and processed after it.
 * - Events are queued FIFO and processed strictly one handler call at a time
 *   (handlers may issue RPCs; a second event must not start processing while
 *   one is in flight). Each is judged against its own state snapshot, and a
 *   satisfying event is always emitted before the stream stops.
 * - First settlement wins; after it, queued and later events are dropped and
 *   both timers are cleared on every path — a pending timer is an active
 *   handle that keeps node's event loop (and thus the CLI process) alive
 *   until it fires, even though the losing promise is discarded.
 * - Both timers arm after `onSeed` resolves false — seed satisfaction takes
 *   precedence, and connection/subscribe latency never counts against the
 *   deadline. The quiet timer resets as each handler call completes.
 *   Deadline expiry rejects with UntilTimeoutError, taking precedence on
 *   ties.
 * - Exceptions thrown by hooks reject the returned promise; they must not
 *   escape into the socket's data listener.
 * - Socket close settles "closed" once the in-flight handler call (if any)
 *   completes; queued events behind it are dropped. Close before the seed
 *   rejects — there is no state to resolve with.
 */
export function runStream<TEvent, TState>(
  client: StreamClient<TEvent, TState>,
  handler: StreamHandler<TEvent, TState>,
  timeoutMs: number | undefined,
): Promise<StreamResult<TState>> {
  return new Promise<StreamResult<TState>>((resolve, reject) => {
    let settled = false;
    let closed = false;
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
        () => settle(() => resolve({ outcome: "done", state: lastState! })),
        handler.quietMs,
      );
    };

    // State delivered with the most recently processed event; the seed once
    // onSeed resolves false — so undefined doubles as "still pre-seed".
    // Pairs dispatched during the subscribe/onSeed window are queued until
    // then: at most that window's events, never history.
    let lastState: TState | undefined;
    const preSeedPairs: Array<[TEvent, TState]> = [];
    // The FIFO pump: each event chains one handler call; the settled/closed
    // check at the head of every link drops events queued behind a
    // settlement or a socket close.
    let processing: Promise<void> = Promise.resolve();
    const enqueue = (event: TEvent, state: TState): void => {
      processing = processing
        .then(async () => {
          if (settled || closed) {
            return;
          }
          lastState = state;
          const stop = await handler.onEvent(event, state);
          if (stop) {
            settle(() => resolve({ outcome: "done", state }));
          } else {
            resetQuietTimer();
          }
        })
        .catch(settleWithError);
    };

    client
      .subscribe((event, state) => {
        if (settled) {
          return;
        }
        if (lastState === undefined) {
          preSeedPairs.push([event, state]);
          return;
        }
        enqueue(event, state);
      })
      .then(
        async (seed) => {
          if (settled) {
            return;
          }
          try {
            if (await handler.onSeed(seed)) {
              settle(() => resolve({ outcome: "done", state: seed }));
              return;
            }
            if (settled) {
              return;
            }
            lastState = seed;
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
            for (const [event, state] of preSeedPairs.splice(0)) {
              enqueue(event, state);
            }
          } catch (error) {
            settleWithError(error);
          }
        },
        (error: unknown) => settleWithError(error),
      );
    void client.waitClosed().then(() => {
      closed = true;
      // Settle behind the pump so an in-flight handler call finishes first.
      processing = processing.then(() => {
        if (lastState === undefined) {
          settleWithError(new Error("socket closed before the subscribe seed"));
        } else {
          const state = lastState;
          settle(() => resolve({ outcome: "closed", state }));
        }
      });
    });
  });
}
