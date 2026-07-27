# Async-Iterable Stream Driver Handoff

## Status

Follow-up required after pictl implements
`docs/specs/format-messages-from-entries.md`. This document records the
cross-repository consequences; it is not part of that pictl implementation.

# SPEC

## Problem

Clauctl synchronizes pictl's generic `stream-driver.ts` and its tests into
`src/core/generated/`. Pictl is moving that driver to
`src/core/streaming/driver.ts` and changing its interface from pushed
`(event, postFoldState)` callbacks to an atomic seed plus
`AsyncIterable<TEvent>`.

Clauctl's checked-in generated copy continues to work until the next sync, but
`scripts/sync-from-pictl.mjs` will become stale: its old source path disappears,
and clauctl's `SdkSocketClient`, `tail`, `wait`, and lifecycle callers still
implement the callback interface.

## Upstream interface to adopt

The canonical interface is specified in pictl's
`docs/specs/format-messages-from-entries.md`. In summary:

```ts
export interface StreamSubscription<TEvent, TState> {
  readonly seed: TState;
  readonly events: AsyncIterable<TEvent>;
}

export interface StreamClient<TEvent, TState> {
  subscribe(): Promise<StreamSubscription<TEvent, TState>>;
}

export interface StreamEvent<TEvent, TState> {
  readonly event: TEvent;
  readonly state: TState;
}

export interface StreamHandler<TEvent, TState> {
  readonly onSeed: (seed: TState) => boolean | Promise<boolean>;
  readonly isDone: (
    event: TEvent,
    state: TState,
  ) => boolean | Promise<boolean>;
  readonly consume?: (
    events: AsyncIterable<StreamEvent<TEvent, TState>>,
  ) => Promise<void>;
  readonly quietMs?: number;
}

export function runStream<TEvent, TState>(
  client: StreamClient<TEvent, TState>,
  advanceState: (state: TState, event: TEvent) => TState,
  handler: StreamHandler<TEvent, TState>,
  timeoutMs: number | undefined,
): Promise<StreamResult<TState>>;
```

The generic driver folds raw events from the atomic seed, gives consumers the
post-fold state paired with each event, and ends its condition-limited iterable
only after the satisfying event has been consumed.

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
export interface SdkEventSubscription {
  readonly seed: AgentState;
  readonly events: AsyncIterable<SdkEvent>;
}

export class SdkSocketClient {
  subscribe(): Promise<SdkEventSubscription>;
}
```

Clauctl's wire ordering is favorable: the daemon writes the subscribe response
before attaching the event sink. Install the client-side event queue before
sending the subscribe request, capture the response's `AgentState` as the seed,
and yield later event records FIFO.

The iterable must stop retaining events when returned, end on socket close, and
preserve the one-subscription-per-client invariant. Requests must remain usable
on the subscribed connection. Do not pause the shared socket for backpressure:
responses and events use the same transport.

The generic driver, not `SdkSocketClient`, folds each yielded event through
`nextAgentState` for the consuming stream. Reassess whether the client's current
`foldedState` remains necessary after this change; remove it only if all of its
ownership and protocol-ordering comments are updated and tests prove no other
caller reads that live fold.

### Callers

Update these known callers:

- `src/core/tail.ts`
- `src/core/wait.ts`
- `src/core/lifecycle.ts`

All pass `nextAgentState` as `advanceState` and rename `onEvent` to `isDone`.
`wait` and lifecycle omit `consume`, using the driver's default drain.

`tail` supplies a consumer that writes each paired event. Seed output remains in
`onSeed`, before queued events are consumed. The event satisfying `--until`
must still be printed before tail exits.

Search for all imports of `generated/stream-driver.ts`, `StreamClient`,
`StreamHandler`, and `runStream`; the list above is evidence from the current
tree, not a substitute for that search during implementation.

## Behavior to preserve

- Subscribe seed prints/checks before any queued live event.
- Event processing is FIFO and asynchronous consumers are serialized.
- Every event is evaluated against its own post-fold `AgentState`.
- The event satisfying an until condition is printed before settlement.
- Seed satisfaction precedes timer setup.
- Subscribe latency does not count toward deadline or quiet timeout.
- Deadline wins an equal-delay tie with the quiet timer.
- Quiet timeout resets after processing, not merely receipt.
- Socket close before seed is an error; close afterward reports `closed` after
  the in-flight event and drops queued events.
- Consumer/fold/condition exceptions reject without escaping into the socket
  data listener.
- Requests remain possible while subscribed.

## Tests

- Sync script copies the new canonical driver and test from pictl.
- Generated driver tests pass unchanged in semantics after adapting their fake
  client to async iteration.
- `sdk-socket.test.ts` covers atomic seed ordering, events queued around seed
  resolution, FIFO iteration, iterator return, socket close, subscribe failure,
  and duplicate subscription.
- Tail tests prove snapshot-before-events ordering and satisfying-event output.
- Wait and lifecycle tests preserve timeout and close behavior.
- Full clauctl presubmit passes after running the sync script.

## Cost

- Event queues consume `O(burst)` memory when producers outrun consumers.
- Each command folds its event stream once in addition to any daemon-owned
  state fold.
- Migration churn concentrates in the generated-driver sync path,
  `SdkSocketClient`, and three callers.

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
- Keep the socket adapter narrow: it owns transport classification and queueing;
  the generic driver owns per-consumer state folding and condition limiting.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Record why pictl's streaming refactor makes clauctl's sync set stale.
- [x] Identify current generated-driver callers and the sdk.sock subscription seam.
- [ ] Wait for pictl's async-iterable driver implementation to land.
- [ ] Update sync paths and regenerate the driver/tests.
- [ ] Adapt `SdkSocketClient` to atomic seed plus async events.
- [ ] Adapt tail, wait, and lifecycle callers.
- [ ] Run focused tests and full presubmit.
