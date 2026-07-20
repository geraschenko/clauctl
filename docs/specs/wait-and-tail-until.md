# wait and tail --until

# SPEC

## Problem

clauctl has no way to block until an agent reaches a state ("run this prompt,
then wait until the agent is idle") and no way to bound `tail` ("stream events
until the turn ends, then exit"). pictl solves both with a shared `--until`
condition engine (`until.ts`) consumed by `wait`, `tail --until`, and streaming
`prompt --until`. Port that capability to clauctl:

- a new `wait` subcommand: block until the agent meets a condition;
- `--until`/`--timeout` flags on `tail`: stream events until a condition
  holds, then exit;
- archive's polite stop reimplemented on the same engine, deleting the
  `wait-idle` protocol request and its daemon-side machinery — one waiting
  mechanism, not two.

The port is a redesign, not a copy: pictl's streaming engine runs the stop
condition as a separate listener racing the printer, coordinated with a
hand-rolled scheduler (`wakeArrived`/`notifyWake`/`stopRequested`). clauctl
instead models streaming as a fold — each event updates state, emits output,
and decides whether to stop, in one step — matching the `nextAgentState` fold
architecture. The fold design is intended to be handed off to a later pictl
spec (see Non-goals).

## Conditions

Grammar and semantics (same surface as pictl):

- `turn-end` — the next `sdkMessage` event whose message is a `result`.
  A compaction's terminating `result` counts: compacting is a kind of working,
  and completing it is a turn end. Met immediately at the seed only when the
  agent is fully idle (`!isBusy(seed)`): a pending queued querying message
  counts as a turn that must end, which keeps sequential `query; wait`
  race-free. With multiple turns queued, `turn-end` fires at the *first*
  result, not when the queue drains (that is `idle`).
- `idle` — `!isBusy(state)`: activity is `idle` and no querying messages are
  queued. Met immediately at the seed when it already holds.
- `no-activity:<secs>` — no `SdkEvent` of any kind for N seconds (fractional
  allowed, e.g. `no-activity:0.5`), regardless of activity state; catches turns
  stalled on human-facing UI, which `idle` never reports. Never met at the
  seed; the quiet timer arms once the seed is processed. Partial-message
  `stream_event`s are
  on the stream (`includePartialMessages` is an invariant), so the timer has
  fine granularity mid-turn.

`--timeout <secs>`: give up with exit code 3 if the condition is not met in
time.

## Commands

`clauctl wait --target <agent> --until <cond> [--timeout <secs>]`

- Blocks until the condition holds. Exit codes: 0 condition met, 1 runtime
  error (including socket closed while waiting), 2 usage error, 3 timeout.
- A dormant or archived agent meets any condition immediately (its process is
  doing nothing): exit 0 without connecting. Never revives — a revived agent
  is guaranteed idle anyway. This deliberately overrides `no-activity`'s
  never-met-at-seed rule: process absence is conclusive inactivity. The pid
  check is moment-in-time; a concurrent revival racing the check is accepted
  (same as pictl).

`clauctl tail --target <agent> [--until <cond>] [--timeout <secs>]`

- Without `--until`: unchanged — print `{snapshot}` then `{event}` lines until
  the daemon closes the socket (exit 0) or the user interrupts.
- With `--until`: same output, but exit 0 when the condition is met. No final
  cursor record: the raw stream already carries the resume point (the
  `{snapshot}` line includes `leafTreeNodeRef`; stream user/assistant
  `sdkMessage`s carry their transcript uuid; `contextChanged` events carry the
  post-change leaf). pictl's `pictl_cursor` compensated for uuid-less RPC
  message records; a printed cursor only becomes necessary when formatted
  output omits uuids (the later `--type` spec).
- With `--until`, the daemon closing the socket before the condition is met is
  an error (exit 1). `--timeout` expiring is exit 3.
- `--timeout` requires `--until` (a bare timeout on an endless stream would be
  a silent exit-3 sleep); reject the combination with a usage error.
- Dormant/archived handling is unchanged: `tail` errors and never revives.

`clauctl archive` (behavior unchanged, mechanism replaced)

- The polite stop waits for `idle` via `runStream` instead of the daemon's
  `wait-idle` request. On timeout it keeps its current surface: "still busy
  after Ns; not archived", exit 1 (the `UntilTimeoutError` is wrapped in a
  plain Error, so the exit-3 mapping does not apply).
- Deleted with it: client-side `waitIdle` and `IdleTimeoutError`
  (sdk-socket.ts), the `wait-idle` request type, the daemon's handler case,
  and `EventHub.whenIdle` + its waiter machinery — the handler was its only
  production consumer (set-context only *mentions* wait-idle in a comment,
  which gets updated to point at `clauctl wait`).
- The daemon must actively reject unknown request types with `{ok: false}`.
  Today an unrecognized type falls through the dispatch switch into
  `runRead`, whose switch has no default, so the daemon would answer
  `ok: true` — an old CLI's `archive` would take that as "idle" and SIGTERM
  a busy agent. With the rejection in place, `SDK_SOCKET_VERSION` stays at 1:
  a new CLI never sends `wait-idle`, and an old CLI archiving against a new
  daemon gets a clean error instead of a false acknowledgement.

## Success criteria

1. On an idle agent, `clauctl query -t <agent> "..." && clauctl wait -t
   <agent> --until turn-end` returns after that turn's `result`, never
   before, and never hangs when the turn already finished before `wait`
   subscribed. (On an already-busy agent, `turn-end` means the first `result`
   after the seed — possibly an earlier turn's; waiting out the whole queue
   is `idle`.)
2. `clauctl wait -t <agent> --until idle` on an idle agent exits 0
   immediately; on a busy agent it exits 0 only once activity is `idle` with
   no querying messages queued.
3. `clauctl wait -t <agent> --until no-activity:1 --timeout 5` exits 0 after
   the first 1s event gap, or exits 3 after 5s of continuous activity.
4. `clauctl wait -t <dormant-agent> --until idle` exits 0 immediately and does
   not revive the agent.
5. `clauctl tail -t <agent> --until turn-end` prints the snapshot and the
   turn's events, then exits 0 at the turn's `result`.
6. `clauctl tail -t <agent> --until idle --timeout 2` against a long-running
   turn exits 3.
7. `clauctl archive -t <busy-agent> --timeout 1` exits 1 with "still busy
   after 1s; not archived"; without `--timeout` it archives once the agent
   goes idle. `waitIdle`, `IdleTimeoutError`, the `wait-idle` request, and
   `EventHub.whenIdle` no longer exist.
8. A daemon test proves an unknown request type (e.g. legacy `wait-idle`)
   is answered `{ok: false}`, not acknowledged.
9. Unit tests cover: condition parsing (valid + malformed, including
   zero, huge, and non-finite durations), met-at-seed and met-by-event for
   each condition, and the driver's quiet-timer, deadline, closed-socket,
   post-settlement-suppression, and hook-exception behavior. `clauctl wait
   --help` works (route is registered).
10. `npm run presubmit` passes.

## Type design

New file `src/core/until.ts` — condition grammar and fold checkers
(clauctl-local; grammar layer is a candidate for a later pictl sync):

```ts
import { isBusy, type AgentState } from "./agent-state.ts";
import type { SdkEvent } from "./sdk-socket.ts";
import { UsageError } from "./generated/util.ts";

/** app.ts maps this to exit code 3. */
export class UntilTimeoutError extends Error {}

export type UntilCondition =
  | { kind: "turn-end" }
  | { kind: "idle" }
  | { kind: "no-activity"; idleMs: number };

export const UNTIL_USAGE = "turn-end|idle|no-activity:<secs>";
export const UNTIL_COMPLETIONS = ["turn-end", "idle", "no-activity:"] as const;

export function parseUntilCondition(value: string): UntilCondition;

/** Seconds → ms for Node timers. Rejects with a UsageError anything whose
 *  ms value is not finite or exceeds 2**31-1 (Node's timer max, above which
 *  setTimeout fires ~immediately). 0 is valid and fires immediately. Used by
 *  parseUntilCondition for no-activity and by the commands for --timeout. */
export function secondsToTimerMs(seconds: number): number;

/** Quiet-timer duration the stream driver must enforce for this condition;
 *  undefined for event-driven conditions. */
export function untilQuietMs(condition: UntilCondition): number | undefined;

/** Whether the condition already holds at the subscribe seed. */
export function untilMetAtSeed(
  condition: UntilCondition,
  seed: AgentState,
): boolean;

/** Whether this event satisfies the condition; `state` is post-fold. */
export function untilMetByEvent(
  condition: UntilCondition,
  event: SdkEvent,
  state: AgentState,
): boolean;
```

New file `src/core/streaming.ts` — the fold driver:

```ts
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
 *   before the subscribe promise settles are buffered and processed after it
 *   (the pre-snapshot buffering currently in tail.ts, moved into the driver).
 * - Per event, in order: fold state, call `onEvent` (which prints), then act
 *   on its stop decision — so a satisfying event is always emitted before
 *   the stream stops.
 * - First settlement wins; after it, later event callbacks are ignored (the
 *   client has no unsubscribe, and one socket chunk can dispatch several
 *   event lines synchronously) and both timers are cleared on every path.
 * - Both timers arm after `onSeed` returns false — seed satisfaction takes
 *   precedence, and connection/subscribe latency never counts against the
 *   deadline. The quiet timer resets as each event is processed. Deadline
 *   expiry throws UntilTimeoutError, taking precedence on ties.
 * - Exceptions thrown by hooks or the fold reject the returned promise; they
 *   must not escape into the socket's data listener.
 */
export function runStream(
  client: StreamClient,
  handler: StreamHandler,
  timeoutMs: number | undefined,
): Promise<StreamOutcome>;
```

New file `src/core/wait.ts` — the command (mirrors pictl's `wait.ts` shape):

```ts
/** Handler = until checkers, no output. Dormant/archived: return before
 *  connecting. reason "closed" → throw. Calls isPidAlive, connectWithRetry,
 *  runStream, untilMetAtSeed/untilMetByEvent/untilQuietMs. */
export async function wait(
  this: CommandContext,
  flags: WaitFlags, // { until: UntilCondition; timeout: number | undefined }
): Promise<void>;

export const waitRoute: { wait: /* commandOneTarget */ };
```

Changed `src/core/tail.ts`:

```ts
const tailFlags = {
  until: parsedFlag(
    `Stream until ${UNTIL_USAGE}`,
    parseUntilCondition,
    "cond",
    completeChoices(UNTIL_COMPLETIONS),
  ),
  timeout: secondsFlag(),
};

/** Rewritten on runStream: handler prints `{event}` lines and (when --until
 *  is given) applies the until checkers; prints `{snapshot}` from onSeed.
 *  On "closed": exit 0 without --until, throw with it. */
async function tail(this: CommandContext, flags: TailFlags): Promise<void>;
```

Changed `src/core/app.ts`:

```ts
import { waitRoute } from "./wait.ts";
// routes: ...waitRoute,

determineExitCode: (error) =>
  error instanceof UsageError ? 2 : error instanceof UntilTimeoutError ? 3 : 1;
```

Changed `src/core/lifecycle.ts`:

```ts
/** The waitIdle call becomes: connect, runStream with an idle handler
 *  (untilMetAtSeed/untilMetByEvent for { kind: "idle" }), close. "closed"
 *  → throw. archive's catch matches UntilTimeoutError instead of
 *  IdleTimeoutError; its error message and exit code are unchanged. */
async function stopRunningAgent(
  agent: AgentRecord,
  timeoutMs: number | undefined,
): Promise<void>;
```

Deleted from `src/core/sdk-socket.ts`: `waitIdle`, `IdleTimeoutError`, and the
`{ type: "wait-idle" }` member of `SdkRequest`. Deleted from
`src/core/daemon/request-handlers.ts`: the `"wait-idle"` dispatch case.
Deleted from `src/core/daemon/event-hub.ts`: `whenIdle` and its
`idleWaiters` machinery (+ their tests) — the dispatch case was the only
production consumer. Updated: set-context's "callers can wait-idle first"
comment (→ `clauctl wait`), and the dispatch comment citing "a pending
wait-idle" as the concurrency rationale (interrupt-vs-pending-request still
justifies it; reword to a live example).

Changed `src/core/daemon/request-handlers.ts`: the dispatch falls through to
`runRead` for passthrough reads; add an explicit unknown-type rejection so
unrecognized requests (e.g. legacy `wait-idle`) answer `{ok: false, error:
"unknown request type: ..."}` instead of `runRead`'s undefined → `ok: true`.

Flag helpers (`parsedFlag`, `requiredParsedFlag`, `secondsFlag`,
`completeChoices`) already exist in `src/core/generated/cli.ts`.

## Edge cases

- Idle waits do not go through the daemon: the subscribe seed is atomically
  ordered before all pushed events, so seed-check + fold is race-free without
  daemon delegation — the rationale that justified `wait-idle` (atomic
  check-or-enqueue on the daemon's fold) applies equally to a subscribed
  client, which is why the request can be deleted rather than kept alongside.
- Condition met at seed: `wait` exits 0 without waiting for events; `tail
  --until` prints the snapshot line and exits with no event lines.
- Socket events racing the subscribe response: `runStream` gates event
  processing on the seed (the pre-snapshot buffering currently in tail.ts
  moves into the driver), so `onSeed` always runs before any `onEvent` and
  tail's output ordering is preserved.
- Timers must be cleared after settling: a pending timer keeps node's event
  loop alive (the rationale currently documented in `sdk-socket.ts` `waitIdle`
  — that comment moves into `runStream` when `waitIdle` is deleted).
- `no-activity` with `--timeout` where timeout < quiet window: exit 3 (the
  deadline takes precedence on ties).
- `--timeout` covers only the wait itself: the deadline arms after the seed
  is processed, so connection establishment (its own existing 5s deadline,
  `SOCKET_CONNECT_DEADLINE_MS`) and subscribe latency never count against it.
- Zero durations are valid and coherent because timers are seed-relative:
  `--timeout 0` exits 0 when the condition is met at the seed, else exits 3
  immediately; `no-activity:0` is met at the first quiet check after the
  seed. Durations whose ms value is non-finite or exceeds Node's timer max
  (2**31-1) are usage errors (`secondsToTimerMs`).
- Malformed `--until` (unknown word, `no-activity:` without a number,
  negative/garbage seconds): usage error, exit 2.

## Non-goals (deferred)

- **`tail --since <node-ref>` and `-n`** — the append-only history read
  (everything the session file gained since a previous cursor, including
  boundaries and superseded rewind tails) followed by the live stream.
  Deferred because two design problems need their own spec:
  1. *Truncation point.* To avoid duplicating or losing records at the
     history/live seam, the file read must stop at the last entry already on
     disk that the live stream will never re-deliver: `viaBoundary ?? uuid` of
     the seed's `leafTreeNodeRef` normally (a boundary-relinked leaf's newest
     file record is the boundary entry, not the leaf uuid), and the
     file-order-latest of `droppedUuids` when a `filterTail` override is
     active (a no-write rewind's dropped tail is on disk but never re-streamed;
     truncating at the leaf uuid would silently lose it). But
     `GetMessagesOverride`/`droppedUuids` are daemon-internal and a no-write
     rewind leaves no file record, so the client cannot compute this point —
     the daemon must expose the override (new `AgentState` field or request),
     a protocol change.
  2. *Record shape.* History is `SessionEntry`s, the live stream is
     `SdkEvent`s; converting entries to event-shaped records is nontrivial,
     and emitting `{entry}` lines next to `{event}` lines needs a decision.

  `-n` goes with `--since` because tail has no other historical output to
  limit. No printed cursor is needed to feed a future `--since`: the raw
  stream already carries the resume point (uuids on user/assistant events,
  `leafTreeNodeRef` in the snapshot, post-change leaves on `contextChanged`).
  A cursor record becomes necessary only alongside formatted output that
  omits uuids (the `--type` spec).
- **`--type` / `--json` formatted output** — later spec; the raw JSONL stream
  is tail's only mode here. `StreamHandler` accommodates a stateful formatted
  printer without interface changes.
- **`prompt` (rename of `query`) with `--until` streaming** — follow-up spec;
  it will reuse `runStream` and the until checkers. The `killed` pseudo-
  condition (pictl's `StreamUntil` extension) is not ported until a consumer
  needs it: bare `tail` already follows until close.
- **pictl changes** — none. The fold streaming design and the shared grammar
  layer (`parseUntilCondition` etc. via `scripts/sync-from-pictl.mjs`) are
  intended for a later pictl spec.

# IMPLEMENTATION IDEAS

- Condition mapping from pi to the SDK stream (derisk findings):
  - pi `agent_end` + `willRetry !== true` → `sdkMessage` `result`; the SDK
    stream has no retry-continuation analogue.
  - pi `get_state` (`isStreaming`, `pendingMessageCount`) → the subscribe seed
    + `isBusy`. clauctl's subscribe is strictly better here: pi must register
    the listener before `get_state` to avoid a gap; clauctl's seed response is
    ordered before all pushed events by protocol.
  - pi counts every socket event for `no-activity`; clauctl counts every
    `SdkEvent`.
- Driver internals: single promise raced among handler-stop, quiet-timer,
  deadline-timer, and `waitClosed`. Events are processed synchronously
  (print + fold), so no queueing is needed; the pictl port will need async
  handlers with an event queue for its entries mode (RPC drain per wake).
- Connection ownership stays with the command (connect before `runStream`,
  close in `finally`), matching the existing `requestData` pattern.
- `tail` keeps its dormant/archived error message; `wait` mirrors pictl's
  dormant fast path (`isPidAlive(agent.daemonPid)`).
- Test seam: `untilMet*` functions are pure (fold-style, like
  `agent-state.test.ts`); `runStream` can be tested against a fake
  `StreamClient` or the daemon test harness used by `sdk-socket.test.ts`.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- 2026-07-19: Spec written and critiqued. Review round 1 (TDC): dropped the
  final `{cursor}` record — the raw stream already carries the resume point,
  so `runStream` returns just `"done" | "closed"`. Decided (Anton): archive's
  polite stop moves onto `runStream` + `idle`; `waitIdle`, `IdleTimeoutError`,
  the `wait-idle` request, and its daemon dispatch case are deleted
  (daemon-internal `whenIdle` stays). Archive's timeout surface is unchanged
  (exit 1, "still busy ...; not archived").
- 2026-07-20: Reviewer round (fresh-context agent). Verified and accepted:
  unknown request types were silently acknowledged `ok: true` (runRead has no
  default) — spec now requires explicit `{ok: false}` rejection, which also
  makes the old-CLI compat claim true; `whenIdle`'s only production consumer
  was the `wait-idle` handler, so it and `idleWaiters` are deleted too
  (set-context only referenced it in a comment); criterion 1 reworded (on a
  busy agent `turn-end` is the first result after the seed, not "that
  turn's"); `runStream` contract made normative (pre-seed buffering,
  fold→print→stop order, post-settlement suppression, hook exceptions reject,
  timer cleanup); `StreamClient` narrow interface added as the test seam;
  `secondsToTimerMs` added (zero valid, non-finite/over-timer-max rejected);
  dormant fast path documented as overriding no-activity seed semantics,
  moment-in-time. app.ts route registration added to the type design.
  Re-review blocker fixed: both driver timers arm after `onSeed` returns
  false (seed satisfaction takes precedence; connect/subscribe latency never
  counts against `--timeout`), making `--timeout 0` coherent. Reviewer
  approves with that edit. (This entry supersedes the round-1 note that
  `whenIdle` would stay.)
