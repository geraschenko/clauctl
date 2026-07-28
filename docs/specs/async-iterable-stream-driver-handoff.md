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

export function runStream<TEvent, TState>(
  client: StreamClient<TEvent, TState>,
  handler: StreamHandler<TEvent, TState>,
  timeoutMs: number | undefined,
): Promise<StreamResult<TState>>;
```

The client owns one `AsyncQueue` and pairs each event with its state snapshot at dispatch. The generic driver is the sole async-iterator consumer and serially invokes the push handler. `AsyncQueue.push` exposes synchronous activity notification; its first successful `close` establishes a source cutoff and drains accepted values, while `cancel` drops queued values for consumer settlement.

## Required clauctl changes

### Sync configuration

Update `scripts/sync-from-pictl.mjs` so `async-queue.ts`, `async-queue.test.ts`, `driver.ts`, and `driver.test.ts` come from pictl's `src/core/streaming/` directory rather than the old `src/core/` driver paths. Preserve the generated-file warning and import rewriting.

Keep the queue and driver sibling imports valid in the generated tree. One expected layout is:

```text
src/core/generated/
  until-engine.ts
  streaming/
    async-queue.ts
    async-queue.test.ts
    driver.ts
    driver.test.ts
```

Callers would then import `./generated/streaming/driver.ts`. Confirm the final
layout against pictl's implemented relative imports before changing the sync
set; do not guess ahead of the upstream implementation.

The current sync rewriter only rewrites `./` imports and operates over one flat file list. Keep `async-queue.ts`, `driver.ts`, and their tests together under `generated/streaming/` so the driver's `./async-queue.ts` sibling import and test imports remain valid. Verify the nested sync set with an early sync test rather than relying on the old flat rewrite assumptions.

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
seed. Events cannot precede that response by daemon protocol. An event line
observed before the seed is dropped rather than folded into nothing; it signals
a daemon protocol violation, not a client race. Preserve this explicit pre-seed
guard when changing the role of `foldedState`. Fold each event after seeding
synchronously through `nextAgentState`, enqueue `{ event, state }` with that
post-fold snapshot, and yield pairs FIFO.

On socket close after seeding, close the queue so accepted pairs drain before iteration ends. Condition satisfaction and errors cancel the queue; quiet and timeout close it as source cutoffs and drain accepted pairs. Preserve one-subscription-per-client and allow requests on a subscribed connection. Do not pause the shared socket for backpressure: responses and
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

Their existing push-shaped `onSeed`/`onEvent` handlers remain valid. Update generated-driver import paths and explicitly interpret the new `timeout` result according to each command's requested operation; do not rely on the old driver throwing `UntilTimeoutError`.

Tail's seed output remains in `onSeed`, before queued events are processed. Its
`onEvent` continues printing before returning whether the condition is met, so
the satisfying event precedes settlement. It does not need `onEnd` until it
introduces buffered formatting.

Search for all imports of `generated/stream-driver.ts`, `StreamClient`,
`StreamHandler`, and `runStream`; the list above is evidence from the current
tree, not a substitute for that search during implementation.

## Stream behavior

The migration deliberately changes settlement around source cutoffs. Transport close, quiet completion, and timeout reject later pushes but drain accepted events; consumer satisfaction and hook failure cancel queued events. Timeout is a distinct driver outcome interpreted by each caller.

- Subscribe seed prints/checks before any queued live event.
- Event processing is FIFO and asynchronous `onEvent` calls are serialized.
- Every event is evaluated against its own post-fold `AgentState` snapshot.
- The event satisfying an until condition is printed before `onEnd` and
  settlement.
- Seed satisfaction precedes timer setup.
- Subscribe latency does not count toward deadline or quiet timeout.
- Timeout wins an equal-delay tie with the quiet timer.
- Every accepted queue push resets quiet timing synchronously, including events arriving while a handler runs. No-activity is therefore source-timed rather than consumer-timed.
- The first transport/quiet/timeout queue close establishes the source cutoff. Accepted events drain even if processing runs past a later timer, so handler throughput cannot change the cutoff outcome.
- Seed satisfaction, handler satisfaction, quiet, and timeout invoke optional `onStop` immediately when event acceptance ends. Draining continues concurrently; settlement awaits `onStop` before `onEnd`. A queued event satisfying the condition while a cutoff drains cancels the remainder and produces `done` without invoking `onStop` twice.
- If no event satisfies, exhaustion runs `onEnd` and reports `closed`, `done`, or `timeout` according to the first source cutoff.
- Condition satisfaction and hook failure cancel queued events without closing the socket. `onEnd` runs at most once after cancellation or exhaustion.
- Bare `clauctl tail | slow-consumer` hands every received event to Node stdout
  before successful close settlement. Because writes do not await backpressure,
  the process may remain alive afterward while Node flushes buffered output.
- Socket close before seed is the client-owned subscription error
  `sdk socket closed before the subscribe seed`.
- `onSeed`/`onEvent`/`onStop` failure rejects without `onEnd`; `onEnd` failure rejects any logically successful driver outcome.
- The generic driver does not throw on timeout. Clauctl callers must explicitly map `timeout` to success or `UntilTimeoutError` according to the operation requested.
- Requests remain possible while subscribed.

## Tests

- Sync script copies the new canonical driver and test from pictl.
- Pictl's canonical queue/driver tests cover paired async iteration, first-cutoff draining, source-timed quiet activity, timeout outcomes, consumer cancellation, and `onEnd` ordering; clauctl syncs those tests verbatim rather than adapting them locally.
- `sdk-socket.test.ts` covers atomic seed ordering, post-fold state pairing,
  events queued around seed resolution, FIFO iteration, iterator return,
  close-queue draining, close-before-seed, and duplicate subscription.
- Clauctl's own tail tests prove snapshot-before-events ordering, satisfying-event
  output, complete queued output after close, and a queued satisfying event
  winning over close.
- Clauctl's own sdk-socket, wait, and lifecycle tests are updated where their close and timer assertions encode the old semantics; they cover queued condition satisfaction after source cutoff, source-timed quiet activity, and caller-specific timeout interpretation.
- Full clauctl presubmit passes after running the sync script.

## Cost

- Event queues consume `O(burst)` memory when producers outrun handlers.
- Source-cutoff drain performs `O(queue length)` residual handler work. Later timers cannot change the first cutoff outcome.
- Tail writes do not await Node stdout backpressure. With a stalled pipe reader,
  queue draining can shift data into Node's writable buffer, grow memory, and
  leave process completion waiting indefinitely for stdout to flush. This is
  the chosen Unix-pipe behavior; a dead reader is handled separately by the
  normal broken-pipe path.
- Each event is folded once client-side before its pair is queued; the driver
  does not duplicate that fold.
- Cutoff cleanup drains all accepted events plus `onEnd`; a hung handler can delay settlement.
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
- Queue close means a source cutoff and drains; queue cancellation means the consumer chose to stop and drops. Keep that distinction explicit in implementation comments.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Record why pictl's streaming refactor makes clauctl's sync set stale.
- [x] Identify current generated-driver callers and the sdk.sock subscription seam.
- [x] Incorporate the final shared interface and settlement semantics agreed with pictl.
- [x] Record pre-seed protocol handling, quiet-timer change, revised test ownership, stalled-pipe cost, and nested sync constraints.
- [x] Revise the handoff for the shared `AsyncQueue`, source-timed quiet cutoff, first-cutoff draining, and caller-interpreted timeout outcomes.
- [ ] Wait for pictl's async-iterable driver implementation to land.
- [ ] Update sync paths and regenerate the driver/tests.
- [ ] Adapt `SdkSocketClient` to atomic seed plus async events.
- [ ] Adapt tail, wait, and lifecycle callers.
- [ ] Run focused tests and full presubmit.
