# Async-Queue Stream Driver Handoff

## Status

Implemented; see the work log. Pictl landed the upstream change in `fe2e4c2`; its
canonical spec is pictl's `docs/specs/format-messages-from-entries.md`. The
interface below is transcribed from the landed
`pictl/src/core/streaming/driver.ts` and `async-queue.ts`, not from the
pre-implementation agreement — the two differ, and the code is authoritative.

# SPEC

## Problem

Clauctl synchronizes pictl's generic `stream-driver.ts` and its tests into
`src/core/generated/`. Pictl moved that driver to `src/core/streaming/`, split
a new `AsyncQueue` bridge out of it, and reworked the client/driver seam from a
subscription callback to a queue of events already paired with their post-fold
state.

Clauctl's checked-in generated copy keeps working until the next sync, but
`scripts/sync-from-pictl.mjs` is stale: the old source path is gone, the sync
set is missing `async-queue.ts`, and `SdkSocketClient` still implements
callback subscription. The handler stays push-shaped, so `tail`, `wait`, and
`lifecycle` keep their `onSeed`/`onEvent` bodies — but the driver no longer
throws on timeout, so every caller's settlement handling changes.

## Upstream interface to adopt

Transcribed from pictl `fe2e4c2`.

```ts
// src/core/streaming/async-queue.ts — deliberately has no imports at all
export class AsyncQueue<T> implements AsyncIterable<T> {
  push(value: T): void; // ignored once closed or cancelled
  onPush(handler: () => void): () => void; // observe arrivals; returns unsubscriber
  close(): boolean; // source cutoff; accepted values still drain
  cancel(): void; // consumer done; queued values dropped
  [Symbol.asyncIterator](): AsyncIterator<T>; // its return() calls cancel()
}

// src/core/streaming/driver.ts — imports only ./async-queue.ts
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

`AsyncQueue` names the distinction the design rests on: `close()` is the
producer saying "no more values", and everything already queued still drains;
`cancel()` is the consumer saying "I'm done", and queued values are dropped.
The client pushes; the driver is the sole consumer.

## Behavior changes to absorb

These differ from clauctl's current generated driver. Each generates test work,
so they precede the implementation steps rather than hiding in the behavior
list.

1. **Timeout is an outcome, not an exception.** `runStream` resolves
   `{ outcome: "timeout" }` instead of rejecting with `UntilTimeoutError`.
   Callers decide whether that is a failure (see "Timeout policy").
2. **Quiet timing is based on arrival, not processing.** The driver subscribes
   via `events.onPush(...)` and resets the quiet timer when an event is
   _enqueued_; previously it reset when a handler call completed. So
   `--until no-activity:<secs>` now means "nothing arrived for N seconds", and
   a handler slower than `quietMs` no longer postpones quiet completion.
3. **A cutoff drains rather than stops.** Quiet and timeout call
   `events.close()`, which rejects new events but leaves the backlog to drain
   through `onEvent`. A queued event that satisfies the condition overrides a
   pending cutoff and produces `done`. The deadline therefore bounds when event
   _acceptance_ stops, not when `runStream` returns.
4. **Socket close drains its queue.** Close after seeding calls
   `events.close()`, so already-received events are still processed and can
   satisfy the condition. Previously they were dropped and the stream reported
   `closed` — a latent bug, since a queued event can be the one that satisfies
   `--until`, making a condition met on the wire report as failure.
5. **`onStop` exists** — invoked once, immediately at the first cutoff, and
   awaited before `onEnd`. Pictl uses it to start a final `get_entries`
   snapshot while draining continues. Clauctl has no cursor concept and needs
   neither hook today.

## Timeout policy

Anton's criterion: a timeout is a failure only when the requested work was not
accomplished.

- **`tail` — success (exit 0).** `tail --timeout <secs>` asks to observe the
  stream for a bounded period; reaching the bound delivered that observation.
  This also removes tail's `--timeout requires --until` usage error: that
  restriction existed because the old driver made a bare deadline a silent
  exit-3 sleep. With timeout as a success outcome, a bare `--timeout` is just
  a bounded tail.
- **`wait` — failure (exit 3).** `wait --until <cond>` asks to block until the
  condition holds; a timeout means it never held. Construct
  ``new UntilTimeoutError(`condition not met within ${flags.timeout}s`)``,
  matching pictl's `wait`.
- **`lifecycle` (`archive`/`stop`) — failure.** Timing out means the agent
  never went idle and was not archived. Keep the existing `UntilTimeoutError`
  catch at `lifecycle.ts:257` producing `still busy after <secs>s; not
  archived`.

`app.ts:94` keeps mapping `UntilTimeoutError` to exit 3 unchanged; what changes
is that callers construct that error instead of receiving it from the driver.

`clauctl query` is unaffected: it posts a request via `sendRequest` and has no
`--until`/`--timeout`, so it is not a `runStream` caller (unlike pictl's
streaming `prompt`/`query`).

## Required clauctl changes

### Sync configuration

Add a second sync set to `scripts/sync-from-pictl.mjs`:

```text
sourceDir: <pictl>/src/core/streaming
outDir:    src/core/generated/streaming
files:     async-queue.ts, async-queue.test.ts, driver.ts, driver.test.ts
```

Pictl's other `src/core/streaming/` files (`stream.ts`, `types.ts`,
`message-records.ts` and their tests) are pictl-specific and are **not**
synced.

The nested layout works with the existing rewriter, but confirm it with an
early sync run rather than assuming:

- `driver.ts` imports only `./async-queue.ts`, which is in the set, so the
  rewriter leaves it `./` — correct inside `generated/streaming/`.
- `driver.test.ts` imports `./async-queue.ts` and `./driver.ts`, both in the
  set; `async-queue.test.ts` imports only `./async-queue.ts` plus node
  builtins.
- The driver no longer imports `until-engine.ts` at all, so the previous
  cross-directory concern is moot. `until-engine.ts` stays in the existing flat
  `src/core` → `src/core/generated` set.

The rewriter turns any `./` import of a file outside the set into `../`. That is
correct only for the flat set; under `generated/streaming/` it would point one
level too high. Add the sibling to the set or generalize the rewriter before a
synced file gains such an import.

Delete `src/core/generated/stream-driver.ts` and
`src/core/generated/stream-driver.test.ts`, and drop them from the flat set.

### `src/core/sdk-socket.ts`

```ts
export type SdkEventSubscription = StreamSubscription<SdkEvent, AgentState>;

export class SdkSocketClient {
  subscribe(): Promise<SdkEventSubscription>;
  waitClosed(): Promise<void>;
}
```

`subscribe` creates the `AsyncQueue`, sends the subscribe request, and resolves
with the response's `AgentState` as the seed plus that queue. Clauctl's wire
ordering is favorable: the daemon writes the subscribe response before
attaching the event sink.

- **Pre-seed events cannot occur by daemon protocol.** An event line seen
  before the subscribe response is dropped rather than folded into nothing; it
  signals a daemon protocol violation, not a client race. Today `foldedState`'s
  `undefined` doubles as that guard (`dispatchLine`) — keep the guard explicit
  when `foldedState`'s role changes.
- After seeding, `dispatchLine` folds each event synchronously through
  `nextAgentState` and pushes `{ event, state }` with that post-fold snapshot.
  The driver never re-folds.
- On socket close after seeding, call `events.close()` so the backlog drains
  and iteration then ends. Do **not** `cancel()` — that reintroduces change 4's
  bug.
- Close before the subscribe response makes `subscribe` reject with
  `Error("sdk socket closed before the subscribe seed")`. This message is now
  client-owned; the driver no longer produces it.
- Preserve one-subscription-per-client, and keep `request()` working on a
  subscribed connection. Do not pause the shared socket for backpressure:
  responses and events share the transport.
- `waitClosed` stays on the concrete client (interactive mode uses it) but is
  not part of `StreamClient`.

Pictl's `src/core/pi-socket-client.ts` is the reference for the seed/queue
handshake, including closing the queue from the socket's `close` listener and
rejecting a pending seed waiter.

### Callers

`src/core/tail.ts`, `src/core/wait.ts`, `src/core/lifecycle.ts` keep their
push-shaped `onSeed`/`onEvent` handlers. Each needs:

- the import path `./generated/streaming/driver.ts`;
- explicit handling of all three outcomes, per "Timeout policy";
- comments updated where they describe callback subscription, the driver's
  promise-chain pump, its pre-seed queue, or quiet-after-processing.

`tail` keeps printing the snapshot in `onSeed` and each event in `onEvent`
before returning whether the condition is met, so a satisfying event still
precedes settlement. It needs neither `onStop` nor `onEnd` until it grows
buffered formatting. Its `closed` handling is unchanged: success without
`--until`, `sdk socket closed before condition met` with one.

`src/tui/interactive-mode.ts` subscribes without the driver: it is the fourth
caller, and the only one that used the callback directly. Its buffer-then-swap
trick (collect events into an array until `InteractiveMode` exists, then
re-point the callback) exists only because a callback cannot wait; the queue
buffers by construction, so the whole dance collapses into starting a pump
loop once the UI is built.

Search for all imports of `generated/stream-driver.ts`, `StreamClient`,
`StreamHandler`, `StreamResult`, and `runStream`, and for `.subscribe(`; the
files above are evidence from the current tree, not a substitute for that
search.

## Stream behavior

- The subscribe seed prints/checks before any queued live event.
- Event processing is FIFO and asynchronous `onEvent` calls are serialized.
- Every event is judged against its own post-fold `AgentState` snapshot.
- The event satisfying an until condition is emitted before settlement.
- Seed satisfaction precedes timer setup and returns `done` with the seed.
- Subscribe latency counts against neither timer.
- Timeout wins an equal-delay tie with the quiet timer (registered first).
- Quiet timing resets on event arrival (change 2).
- Quiet and timeout establish a source cutoff: no new events are accepted, the
  backlog drains, and the recorded outcome is returned unless a drained event
  satisfies the condition first, which yields `done`.
- Socket close after seed drains the queue; a queued satisfying event yields
  `done`, otherwise `closed`.
- Condition satisfaction cancels the queue, dropping anything still queued.
- `onSeed`/`onEvent` failure rejects without running `onEnd`.
- `StreamResult.state` is the state paired with the last _completed_ event, or
  the seed if none completed.
- Socket close before seed is the client-owned subscription error.
- Requests remain possible while subscribed.

## Tests

- The sync script copies `async-queue.ts`, `driver.ts`, and both tests from
  pictl, and `--check` passes immediately after a sync.
- The synced driver/queue tests carry pictl's semantics; clauctl does not adapt
  them locally.
- `sdk-socket.test.ts`: atomic seed ordering, post-fold state pairing, FIFO
  iteration, close draining a genuine backlog (the close is awaited before the
  first pull — see "Problems Encountered"), close-before-seed rejection, and
  duplicate subscription.
- `stream-commands.test.ts` (new): `tail` snapshot-before-events ordering and
  satisfying-event output; an event delivered as the daemon hangs up still
  satisfying `--until`; a close with nothing to satisfy it failing; expired
  `--timeout` exiting 0 for `tail` and 3 for `wait`; `tail --timeout` without
  `--until` as a bounded watch; `tail --timeout 0` as a snapshot-only watch.
- Any test asserting quiet timing across a slow handler moves to the
  arrival-based semantics.
- Full presubmit passes after running the sync script.

Not covered: `archive`'s timeout path and `runInteractive`'s pump. The first
would SIGTERM the test process (see "Implementation-Time Decisions"); the
second needs a TTY and had no coverage under the callback either.

## Cost

- The event queue consumes `O(burst)` memory when the daemon outruns the
  handler. The socket cannot be paused: responses share the transport.
- Close and cutoff drains perform `O(queue length)` residual handler work
  before settlement; a hung handler delays settlement.
- `tail` writes do not await Node stdout backpressure. With a stalled pipe
  reader, draining shifts data into Node's writable buffer, grows memory, and
  leaves process completion waiting on stdout. This is the chosen Unix-pipe
  behavior; a dead reader is handled by the normal broken-pipe path.
- Each event is folded once client-side; the driver does not duplicate it.
- Migration churn concentrates in the sync script and `SdkSocketClient`; caller
  changes are outcome handling, imports, and comments.

## Non-goals

- Do not modify pictl from this handoff.
- Do not sync pictl's `stream.ts`, `types.ts`, or `message-records.ts`.
- Do not add message-record conversion, coalescing, or formatting to clauctl.
- Do not add `onStop`/`onEnd` handlers before there is buffered output to
  flush.
- Do not pause sdk.sock for backpressure.
- Do not preserve the old callback driver interface alongside the new one.

# IMPLEMENTATION IDEAS

- Sync first and let the compiler enumerate the work: deleting the old
  generated driver turns every stale caller into a type error.
- `AsyncQueue`'s doc comment records why an async generator and a `node:stream`
  Readable were both rejected by experiment — `return()` on a generator parked
  at an `await` queues behind the pending `next()` and never settles. Do not
  "simplify" the generated file toward either.
- Keep the socket adapter narrow: it owns transport classification, folding,
  and pushing; the driver owns pulling, settlement, and cancellation.
- Producer close drains, consumer cancel drops. Keep that distinction explicit
  in `SdkSocketClient`'s comments.
- `--timeout 0` falls out of the driver for `tail` as an immediate cutoff:
  snapshot plus whatever is already queued, exit 0. Asserted rather than
  specified separately.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Record why pictl's streaming refactor makes clauctl's sync set stale.
- [x] Identify current generated-driver callers and the sdk.sock subscription seam.
- [x] Agree the shared interface and settlement semantics with pictl.
- [x] Retranscribe this handoff from the landed pictl implementation (`fe2e4c2`)
      after it diverged from the pre-implementation agreement: timeout became an
      outcome, quiet timing moved to arrival, cutoffs drain, `onStop` was added,
      and `AsyncQueue` replaced a bare `AsyncIterable`.
- [x] Settle the timeout policy per caller: `tail` succeeds, `wait` and
      `lifecycle` fail. `query` is not a `runStream` caller.
- [x] Update sync paths, add the streaming set, delete the old generated driver.
- [x] Adapt `SdkSocketClient` to seed plus `AsyncQueue`.
- [x] Adapt tail, wait, and lifecycle outcome handling.
- [x] Adapt the TUI's direct subscription (not anticipated by the spec).
- [x] Drop tail's `--timeout requires --until` guard, which the new timeout
      semantics made obsolete (review comment).
- [x] Run focused tests and full presubmit (478 tests, green).

## Implementation-Time Decisions

**The sync rewriter now rejects an unrepresentable import rather than
mis-rewriting it.** Each sync set carries an `outsidePrefix`; the two flat sets
set it to `"../"`, and the nested `streaming` set leaves it undefined, so a
`./` import of a file outside that set throws during sync. The spec only asked
that this be verified by an early sync run, but "verify once" does not survive
the next pictl refactor: the failure mode is a silently wrong relative path in
generated code. Alternative considered: computing the prefix from directory
depth. Rejected — depth is not the problem. `src/core/streaming`'s parent
(`src/core`) has no counterpart reachable from `generated/streaming` at all,
so there is no correct rewrite to compute.

**`stopRunningAgent` still signals with `UntilTimeoutError`.** It converts
`outcome === "timeout"` into the same exception `archive` already catches and
rewords, rather than returning the outcome to its caller. The throw/catch round
trip is slightly indirect, but `archive` owns the "not archived" wording and
`stopRunningAgent` owns the idle wait; moving the decision would have pushed
archive-specific phrasing down into the stop routine.

**The TUI drives its queue with a pump promise included in the shutdown race.**
`runInteractive` starts `for await (...) interactiveMode.handleEvent(...)`
after constructing the mode and races that promise alongside
`interactiveMode.done` and `client.waitClosed()`. Racing it is what keeps a
handler failure from becoming an unhandled rejection — under the old callback
it threw synchronously into the socket data listener. `finally` cancels the
queue before disposing the mode, so a drain cannot deliver events to a disposed
UI.

**Command-level settlement tests run the real `app`.** `stream-commands.test.ts`
stands up a temp registry plus a fake sdk.sock server and invokes
`runCliApp(app, ...)`, because the outcome→exit-code mapping under test lives in
`app.ts`'s `determineExitCode`, not in the commands. `archive` is deliberately
not covered there: its success path SIGTERMs the recorded daemon pid, which in
this harness is the test process itself. Covering it needs a real subprocess.

## Problems Encountered

**The first two drain tests were vacuous.** Both the sdk-socket test and the
command-level test passed unchanged when `close()` was swapped for `cancel()`
in the socket's close handler. Consuming immediately after the daemon's `end()`
never produces a backlog: the queued value is handed to a pending `next()`
within microtasks, while `close` on the socket is a macrotask behind it. The
sdk-socket test now awaits `client.waitClosed()` before iterating, which does
fail under `cancel()`. The command-level case cannot manufacture a backlog at
all — `tail`'s handler is a synchronous write — so it is documented as covering
the hand-up ordering only, with the backlog case owned by the socket test.
