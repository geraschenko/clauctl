# wait and tail --until

# SPEC

## Problem

clauctl has no way to block until an agent reaches a state ("run this prompt,
then wait until the agent is idle") and no way to bound `tail` ("stream events
until the turn ends, then exit"). pictl solves both with a shared `--until`
condition engine (`until.ts`) consumed by `wait`, `tail --until`, and streaming
`prompt --until`. Port that capability to clauctl:

- a new `wait` subcommand: block until the agent meets a condition;
- `--until`/`--timeout` flags on `tail`: stream events until a condition holds,
  then emit a final cursor record and exit.

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
  seed; the timer starts at subscription. Partial-message `stream_event`s are
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
  is guaranteed idle anyway.

`clauctl tail --target <agent> [--until <cond>] [--timeout <secs>]`

- Without `--until`: unchanged — print `{snapshot}` then `{event}` lines until
  the daemon closes the socket (exit 0) or the user interrupts.
- With `--until`: same output, but when the condition is met, print a final
  cursor record and exit 0:

  ```
  {"cursor": "<uuid>"} or {"cursor": "<uuid>@<boundary-uuid>"} or {"cursor": null}
  ```

  The cursor is the final folded state's `leafTreeNodeRef` via
  `formatTreeNodeRef`; `null` when unset. Always emitted on condition-met, so
  scripted consumers get a definite final line. No cursor on timeout or close.
  TDC: actually, don't the messages themselves already have the cursor information in the form of the uuid of the last entry? pictl included the cursor just because the messages streamed through the RPC interface don't include the entry uuids, but clauctl doesn't have that problem. This means that we only need to show the cursor information when text formatting omits the uuid. So I think we can omit cursor from this spec.
- With `--until`, the daemon closing the socket before the condition is met is
  an error (exit 1). `--timeout` expiring is exit 3.
- `--timeout` requires `--until` (a bare timeout on an endless stream would be
  a silent exit-3 sleep); reject the combination with a usage error.
- Dormant/archived handling is unchanged: `tail` errors and never revives.

## Success criteria

1. `clauctl query -t <agent> "..." && clauctl wait -t <agent> --until
   turn-end` returns after that turn's `result`, never before the turn ends,
   and never hangs when the queued turn already finished before `wait`
   connected.
2. `clauctl wait -t <agent> --until idle` on an idle agent exits 0
   immediately; on a busy agent it exits 0 only once activity is `idle` with
   no querying messages queued.
3. `clauctl wait -t <agent> --until no-activity:1 --timeout 5` exits 0 after
   the first 1s event gap, or exits 3 after 5s of continuous activity.
4. `clauctl wait -t <dormant-agent> --until idle` exits 0 immediately and does
   not revive the agent.
5. `clauctl tail -t <agent> --until turn-end` prints the snapshot, the turn's
   events, then exactly one `{"cursor": ...}` line, and exits 0.
6. `clauctl tail -t <agent> --until idle --timeout 2` against a long-running
   turn exits 3 with no cursor line.
7. Unit tests cover: condition parsing (valid + malformed), met-at-seed and
   met-by-event for each condition, and the driver's quiet-timer, deadline,
   and closed-socket behavior.
8. `npm run presubmit` passes.

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
import type { SdkEvent, SdkSocketClient } from "./sdk-socket.ts";

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

export interface StreamOutcome {
  /** "done" = handler or quiet-timer stop; "closed" = socket closed. */
  reason: "done" | "closed";
  /** The final folded state (cursor source). */
  state: AgentState;
}

/**
 * Subscribe on `client`, fold `nextAgentState` over the pushed events, and
 * drive `handler`. Owns the quiet timer and the deadline timer; throws
 * UntilTimeoutError when `timeoutMs` expires first. Calls `runStream` →
 * `client.subscribe`, `nextAgentState`.
 */
export function runStream(
  client: SdkSocketClient,
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
 *  On reason "done" with --until: print `{cursor: string | null}`. On reason
 *  "closed": exit 0 without --until, throw with it. */
async function tail(this: CommandContext, flags: TailFlags): Promise<void>;
```

Changed `src/core/app.ts`:

```ts
determineExitCode: (error) =>
  error instanceof UsageError ? 2 : error instanceof UntilTimeoutError ? 3 : 1;
```

Flag helpers (`parsedFlag`, `requiredParsedFlag`, `secondsFlag`,
`completeChoices`) already exist in `src/core/generated/cli.ts`.

## Edge cases

- `wait --until idle` does not use the daemon's `wait-idle` request: the
  subscribe seed is atomically ordered before all pushed events, so
  seed-check + fold is race-free without daemon delegation. `wait-idle`
  remains for its existing consumers (archive's polite stop).
  TDC: Should archive's polite stop be reimplemented with this new approach?
- Condition met at seed: `wait` exits 0 without waiting for events; `tail
  --until` prints the snapshot and cursor with no event lines.
- Socket events racing the subscribe response: `runStream` gates event
  processing on the seed (the pre-snapshot buffering currently in tail.ts
  moves into the driver), so `onSeed` always runs before any `onEvent` and
  tail's output ordering is preserved.
- Timers must be cleared after settling: a pending timer keeps node's event
  loop alive (see the existing comment in `sdk-socket.ts` `waitIdle`).
- `no-activity` with `--timeout` where timeout < quiet window: exit 3.
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
  limit. The `{cursor}` record emitted by this spec is the value a future
  `--since` consumes.
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
  `SdkSocketClient` or the daemon test harness used by `sdk-socket.test.ts`.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

*Work log entries go here*
