# Async-Iterable Stream Driver Handoff

## Status

Follow-up required after pictl implements
`docs/specs/format-messages-from-entries.md`. This document records the
cross-repository consequences; it is not part of that pictl implementation.

# SPEC

## Problem

Clauctl synchronizes pictl's generic `stream-driver.ts` and its tests into
`src/core/generated/`. Pictl is moving that driver to
`src/core/streaming/driver.ts` and changing the client/driver seam from a
subscription callback to an atomic seed plus an `AsyncIterable` of events
already paired with their post-fold state. The handler remains push-shaped:
the driver serially invokes `onEvent` and adds `onEnd` for buffered-output
flush.

Clauctl's checked-in generated copy continues to work until the next sync, but
`scripts/sync-from-pictl.mjs` will become stale: its old source path disappears,
and clauctl's `SdkSocketClient` still implements callback subscription. Tail,
wait, and lifecycle use the handler interface that remains push-shaped, but
their generated-driver import paths and callback-queue comments become stale.

## Upstream interface to adopt

The canonical interface is specified in pictl's
`docs/specs/format-messages-from-entries.md`. In summary:

```ts
export interface StreamEvent<TEvent, TState> {
  readonly event: TEvent;
  readonly state: TState;
}

export interface StreamSubscription<TEvent, TState> {
  readonly seed: TState;
  readonly events: AsyncIterable<StreamEvent<TEvent, TState>>;
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
  readonly onEnd?: () => void | Promise<void>;
  readonly quietMs?: number;
}

export interface StreamResult<TState> {
  readonly outcome: "done" | "closed";
  readonly state: TState;
}

export function runStream<TEvent, TState>(
  client: StreamClient<TEvent, TState>,
  handler: StreamHandler<TEvent, TState>,
  timeoutMs: number | undefined,
): Promise<StreamResult<TState>>;
```

This block is copied verbatim from the approved pictl spec. The client owns the
single queue and pairs each event with its state snapshot at dispatch. The
generic driver is the sole async-iterator consumer and serially invokes the
push handler.

## Required clauctl changes

### Sync configuration

Update `scripts/sync-from-pictl.mjs` so the driver and driver test come from
pictl's `src/core/streaming/` directory rather than `src/core/`. Preserve the
generated-file warning and import rewriting.

The destination should keep the driver's relative import of the generated
`until-engine.ts` valid. One expected layout is:

```text
src/core/generated/
  until-engine.ts
  streaming/
    driver.ts
    driver.test.ts
```

Callers would then import `./generated/streaming/driver.ts`. Confirm the final
layout against pictl's implemented relative imports before changing the sync
set; do not guess ahead of the upstream implementation.

### `src/core/sdk-socket.ts`

Replace callback subscription with an atomic subscription result:

```ts
export type SdkEventSubscription = StreamSubscription<
  SdkEvent,
  AgentState
>;

export class SdkSocketClient {
  subscribe(): Promise<SdkEventSubscription>;
  waitClosed(): Promise<void>;
}
```

Clauctl's wire ordering is favorable: the daemon writes the subscribe response
before attaching the event sink. Install the client-side event queue before
sending the subscribe request and capture the response's `AgentState` as the
seed. Fold each later event synchronously through `nextAgentState`, enqueue
`{ event, state }` with that post-fold snapshot, and yield pairs FIFO.

On socket close after seeding, stop accepting events, drain the already queued
pairs, then end the iterable. Returning the iterator for condition, quiet,
deadline, or error settlement drops the remaining queue without closing the
socket. Preserve one-subscription-per-client and allow requests on a subscribed
connection. Do not pause the shared socket for backpressure: responses and
events use the same transport.

Close before the subscribe response makes `subscribe` reject with
`Error("sdk socket closed before the subscribe seed")`; the driver propagates
that client-owned error. A seed established before close yields its queue and
then ends normally.

`waitClosed` remains on the concrete client for interactive mode, but leaves
the generic `StreamClient` interface. The existing `foldedState` remains the
source of post-fold snapshots; ownership comments must change from callback
delivery to queued pair delivery.

### Callers

Update these known callers:

- `src/core/tail.ts`
- `src/core/wait.ts`
- `src/core/lifecycle.ts`

Their existing `runStream(client, handler, timeoutMs)` calls and push-shaped
`onSeed`/`onEvent` handlers remain valid; update only generated-driver import
paths and any comments tied to callback subscription or the driver's old
promise-chain queue.

Tail's seed output remains in `onSeed`, before queued events are processed. Its
`onEvent` continues printing before returning whether the condition is met, so
the satisfying event precedes settlement. It does not need `onEnd` until it
introduces buffered formatting.

Search for all imports of `generated/stream-driver.ts`, `StreamClient`,
`StreamHandler`, and `runStream`; the list above is evidence from the current
tree, not a substitute for that search during implementation.

## Stream behavior

- Subscribe seed prints/checks before any queued live event.
- Event processing is FIFO and asynchronous `onEvent` calls are serialized.
- Every event is evaluated against its own post-fold `AgentState` snapshot.
- The event satisfying an until condition is printed before `onEnd` and
  settlement.
- Seed satisfaction precedes timer setup.
- Subscribe latency does not count toward deadline or quiet timeout.
- Deadline wins an equal-delay tie with the quiet timer.
- Quiet timeout is armed only while no handler is in flight and resets after
  processing, not merely receipt.
- Condition, quiet, and deadline settlement return the iterator and drop its
  queued events without closing the socket. First settlement wins; `onEnd`
  runs at most once after the source is stopped or exhausted.
- Deadline expiry starts no new event, awaits the one in-flight `onEvent`, runs
  `onEnd`, then rejects. A hung handler can therefore delay timeout settlement.
- Socket close after seed drains queued events before iterable exhaustion. A
  queued satisfying event produces `done`; otherwise the driver runs `onEnd`
  and reports `closed`.
- Bare `clauctl tail | slow-consumer` therefore waits for stdout processing and
  emits every received event before successful close settlement.
- Socket close before seed is the client-owned subscription error
  `sdk socket closed before the subscribe seed`.
- `onSeed`/`onEvent` failure rejects without `onEnd`; `onEnd` failure rejects a
  logically successful, closed, or timed-out path.
- Requests remain possible while subscribed.

## Tests

- Sync script copies the new canonical driver and test from pictl.
- Generated driver tests pass unchanged in semantics after adapting their fake
  client to async iteration.
- `sdk-socket.test.ts` covers atomic seed ordering, post-fold state pairing,
  events queued around seed resolution, FIFO iteration, iterator return,
  close-queue draining, close-before-seed, and duplicate subscription.
- Tail tests prove snapshot-before-events ordering, satisfying-event output,
  complete queued output after close, and a queued satisfying event winning
  over close.
- Wait and lifecycle tests preserve timeout behavior and cover queued condition
  satisfaction after close.
- Full clauctl presubmit passes after running the sync script.

## Cost

- Event queues consume `O(burst)` memory when producers outrun handlers.
- Close drain performs `O(queue length)` residual handler work. Bare tail has no
  deadline; an until stream keeps its deadline armed during the drain.
- Each event is folded once client-side before its pair is queued; the driver
  does not duplicate that fold.
- Deadline cleanup awaits at most one in-flight handler plus `onEnd`; a hung
  handler can delay rejection.
- Migration churn concentrates in the generated-driver sync path and
  `SdkSocketClient`; caller code changes are mostly import/comment updates.

## Non-goals

- Do not modify pictl from this handoff.
- Do not add message-record conversion or formatting behavior to clauctl.
- Do not pause sdk.sock for backpressure.
- Do not preserve the old callback driver interface alongside the new one.

# IMPLEMENTATION IDEAS

- Land this only after the pictl driver interface and final relative imports
  exist; then sync the actual source rather than reproducing a draft.
- Adapt the existing generated driver tests first. They encode subtle timer,
  close, FIFO, and seed-ordering behavior and should remain the migration's
  primary regression surface.
- Keep the socket adapter narrow: it owns transport classification, state
  snapshot pairing, and queueing; the generic driver owns serialized handler
  invocation, condition limiting, timing, and flush ordering.
- Iterable exhaustion means the producer ran out and therefore drains; iterator
  return means the consumer chose to stop and therefore drops. Keep that
  distinction explicit in implementation comments.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Record why pictl's streaming refactor makes clauctl's sync set stale.
- [x] Identify current generated-driver callers and the sdk.sock subscription seam.
- [x] Incorporate the final shared interface and settlement semantics agreed with pictl.
- [ ] Wait for pictl's async-iterable driver implementation to land.
- [ ] Update sync paths and regenerate the driver/tests.
- [ ] Adapt `SdkSocketClient` to atomic seed plus async events.
- [ ] Adapt tail, wait, and lifecycle callers.
- [ ] Run focused tests and full presubmit.
