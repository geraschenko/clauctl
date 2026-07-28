// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/*
 * Generic driver for serialized socket stream consumers. Concrete clients own
 * the transport and feed an AsyncQueue with each event paired with its
 * post-fold state; the driver owns pulling, settlement, and cancellation.
 *
 * This file is repo-agnostic and consumed verbatim by clauctl's sync script.
 * It may import only other files included in that sync set.
 */

import type { AsyncQueue } from "./async-queue.ts";

export interface StreamEvent<TEvent, TState> {
  readonly event: TEvent;
  readonly state: TState;
}

export interface StreamSubscription<TEvent, TState> {
  readonly seed: TState;
  readonly events: AsyncQueue<StreamEvent<TEvent, TState>>;
}

export interface StreamClient<TEvent, TState> {
  subscribe(): Promise<StreamSubscription<TEvent, TState>>;
}

export interface StreamHandler<TEvent, TState> {
  readonly onSeed: (seed: TState) => boolean | Promise<boolean>;
  readonly onEvent: (
    event: TEvent,
    state: TState,
  ) => boolean | Promise<boolean>;
  readonly onStop?: () => void | Promise<void>;
  readonly onEnd?: () => void | Promise<void>;
  readonly quietMs?: number;
}

export interface StreamResult<TState> {
  readonly outcome: "done" | "closed" | "timeout";
  readonly state: TState;
}

type Settlement<TState> = StreamResult<TState>["outcome"];

export async function runStream<TEvent, TState>(
  client: StreamClient<TEvent, TState>,
  handler: StreamHandler<TEvent, TState>,
  timeoutMs: number | undefined,
): Promise<StreamResult<TState>> {
  const subscription = await client.subscribe();
  let lastState = subscription.seed;
  let sourceCutoff: Exclude<Settlement<TState>, "closed"> | undefined;
  let timersArmed = false;
  let stopPromise: Promise<void> | undefined;
  let quietTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  const clearTimers = (): void => {
    clearTimeout(quietTimer);
    clearTimeout(timeoutTimer);
    quietTimer = undefined;
    timeoutTimer = undefined;
  };

  const beginStop = (): void => {
    if (stopPromise !== undefined) {
      return;
    }
    try {
      stopPromise = Promise.resolve(handler.onStop?.());
    } catch (error) {
      stopPromise = Promise.reject(error);
    }
    void stopPromise.catch(() => subscription.events.cancel());
  };

  const establishSourceCutoff = (
    outcome: Exclude<Settlement<TState>, "closed">,
  ): void => {
    if (subscription.events.close()) {
      sourceCutoff = outcome;
      clearTimers();
      beginStop();
    }
  };

  const resetQuietTimer = (): void => {
    if (
      !timersArmed ||
      sourceCutoff !== undefined ||
      handler.quietMs === undefined
    ) {
      return;
    }
    clearTimeout(quietTimer);
    quietTimer = setTimeout(
      () => establishSourceCutoff("done"),
      handler.quietMs,
    );
  };

  const unsubscribePush = subscription.events.onPush(resetQuietTimer);
  const cancel = (): void => {
    clearTimers();
    unsubscribePush();
    subscription.events.cancel();
  };
  const finish = async (
    outcome: Settlement<TState>,
  ): Promise<StreamResult<TState>> => {
    clearTimers();
    unsubscribePush();
    await stopPromise;
    await handler.onEnd?.();
    return { outcome, state: lastState };
  };

  try {
    if (await handler.onSeed(subscription.seed)) {
      cancel();
      beginStop();
      return await finish("done");
    }
  } catch (error) {
    cancel();
    throw error instanceof Error ? error : new Error(String(error));
  }

  timersArmed = true;
  // Timeout before quiet: equal-delay timers fire in registration order.
  if (timeoutMs !== undefined) {
    timeoutTimer = setTimeout(
      () => establishSourceCutoff("timeout"),
      timeoutMs,
    );
  }
  resetQuietTimer();

  try {
    for await (const streamEvent of subscription.events) {
      const stop = await handler.onEvent(streamEvent.event, streamEvent.state);
      lastState = streamEvent.state;
      if (stop) {
        cancel();
        beginStop();
        return await finish("done");
      }
    }
    return await finish(sourceCutoff ?? "closed");
  } catch (error) {
    cancel();
    throw error instanceof Error ? error : new Error(String(error));
  }
}
