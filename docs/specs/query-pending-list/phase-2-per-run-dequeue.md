# Phase 2: queue model per-run dequeue

> Work log for phase 2 of docs/specs/query-pending-list.md (Type Design,
> "Phase 2 — queue model per-run dequeue"; Data Flow, "Phase 2";
> Decisions, "Steers"). Status: **implemented, awaiting Anton's review**.

## Scope

Two daemon-side ordering fixes, both invisible to the fold's types:

1. **One dequeue per run.** `queue-model.ts` drains the whole
   top-priority bucket at a `result` as one `userMessageDequeued`. The CLI
   dequeues one _run_ per `result` (docs/claude-agent-sdk.md "Queued
   prompts coalesce by run", pinned by `tests/sdk/queued-batches.test.ts`):
   a maximal prefix of consecutive querying members merges into one
   turn; an append (`shouldQuery: false`) is always its own run. So
   `[Q, Q, A, Q]` in one bucket is `turn [1,2]`, `append [3]`, `turn [4]`
   over three `result`s, where today it is one `turn [1,2,3,4]`.
2. **Steer dequeues precede their trigger.** `event-hub.ts` emits every
   dequeue after the `sdkMessage` that triggered it. For a steer the
   trigger is the first assistant activity after the tool result, and the
   file's order is `tool_result` → `queued_command` attachment →
   `assistant`; phase 3 observes the steer on `query` at its dequeue, so
   the dequeue has to sit where the attachment sits: before the
   assistant frame. Turn/append dequeues keep following their `result`
   (Decisions, Steers; Non-goals: "the only ordering change").

No protocol type changes; ids stay numeric until phase 3. No fold
change: the remaining querying members keep `activity: "pending"` through
`queryingCount` (Data Flow, Phase 2).

Out of scope: identity (stamped uuids, `joinedPrompt`, `deliveredMessages`
removal) — phase 3. The TUI's `userMessageDequeued` rendering (one
`append` per id) is untouched: a run's ids still arrive in one event.

## Definitions

- **Bucket**: the queued messages of the highest priority rank present,
  in acceptance order (`state.queued` order filtered by rank — as today).
- **Run**: the bucket's head alone when `!isQuerying(head)`; otherwise
  the bucket's maximal prefix of querying members. The run is what one
  `result` dequeues; the rest of the bucket stays queued.
- **Re-ranking between results**: the bucket is recomputed at every
  `result`, so a `now` accepted while a `later` bucket is mid-drain cuts
  ahead of the remaining `later` runs (priority still wins between
  results — IMPLEMENTATION IDEAS of the main spec).

## Type Design

No signature changes (main spec, Type Design Phase 2). Internals:

```ts
// queue-model.ts, observeSdkMessage, `result` branch
const bucket = state.queued.filter(
  (entry) => priorityRank(entry.message) === topRank,
);
const firstAppend = bucket.findIndex((entry) => !isQuerying(entry.message));
const run =
  firstAppend === 0
    ? [bucket[0]!] // an append is its own run
    : firstAppend === -1
      ? bucket // all querying: one turn
      : bucket.slice(0, firstAppend); // the querying prefix
// events: [dequeued(isQuerying(run[0]!.message) ? "turn" : "append", run.map((entry) => entry.id))]
// state.queued: minus `run`

// event-hub.ts, observeSdkMessage (after the dedup return)
const transition = QueueModel.observeSdkMessage(this.queueModel, message);
// A transition carries at most one dequeue; a steer is applied before the
// message's own sdkMessage event, a turn/append after it.
```

The hub decides placement from the event's `delivery` — `QueueTransition`
does not grow a placement field (the queue model states _what_ was
dequeued; where the hub writes it relative to the trigger is the hub's
protocol commitment, already documented in `protocol.ts`).

## Data Flow

- `result` with `[Q1, Q2, A3, Q4]` queued (one rank): `sdkMessage(result)`
  → `dequeued turn [1,2]`; `Q1\nQ2` runs; its `result` → `dequeued append
[3]`; the CLI writes A3's entry and an empty `result` → `dequeued turn
[4]`. Fold: `activity` after each result is `pending` while a querying
  member remains queued, `idle` after the last.
- `tool_result` → (marks) → `stream_event` (first assistant activity):
  hub computes the transition first, emits `dequeued steer [ids]`, then
  `sdkMessage(stream_event)`. Subscribers see `tool_result`, steer,
  assistant — the file's order.

## Tests

`queue-model.test.ts`:

- "mixed bucket with one querying message dequeues as turn" becomes:
  `append [1]` at the first `result`, `turn [2]` at the second.
- New: `[Q, Q, A, Q]` → `turn [1,2]`, `append [3]`, `turn [4]` over three
  `result`s; queue empty after.
- New: `later` bucket `[Q, A, Q]` mid-drain, a default-priority prompt
  accepted after the first `result` → the second `result` dequeues it
  (`turn`), the third the append, the fourth the last `later` (the
  probe's P/N0 case).
- Unchanged: "same-priority merge", "c_perm drain order", "no-query
  bucket dequeues as append", idle accepts.

`event-hub.test.ts`:

- "observeSdkMessage emits the message first, then implied dequeues"
  keeps its `result` case and gains a steer case: prompt queued behind a
  running turn, `tool_result`, then `stream_event` → subscriber sees
  `["userMessageDequeued" (steer), "sdkMessage"]`.

## Plan

Each step ends with `npm run check` and the affected tests green, and
updates this doc and the WORK LOG.

1. `queue-model.ts`: the run rule in the `result` branch; its comment and
   the `observeSdkMessage` doc comment ("dequeues follow their trigger"
   → "a steer precedes its trigger, a turn/append follows it — the hub's
   placement"); tests.
2. `event-hub.ts`: transition computed first, steer before / turn-append
   after; the "Dequeues follow their trigger" comment replaced; test.
3. Docs: `protocol.ts` header (the run rule instead of "the whole
   bucket"; the steer placement); `docs/user-message-tracking.md` l.73
   ("all of the same priority as one entry" → the run rule, pointing at
   docs/claude-agent-sdk.md); `docs/protocol.md` if it repeats the bucket
   sentence. `docs/specs/phase-2-sdk-sock-protocol.md` is historical —
   untouched.
4. Presubmit; main spec WORK LOG phase-2 line checked; file list to
   Anton.

## Implementation-Time Decisions

- The sdk test's mid-drain case uses default priority, not `now`: `now`
  is an interrupt (echoed-message-placement FINDINGS, priority table) —
  the probe's R case shows it aborting the running turn, which still
  ends with a `result`, so one run per `result` holds — and mixing it
  into the file-order assertion would test two behaviors at once.
- `docs/protocol.md` does not repeat the bucket sentence; only
  `protocol.ts`'s header and `docs/user-message-tracking.md` changed.
- Review round (b90f9fb): the run selection moved into `nextRun` with an
  early return for the append-at-head case, in place of stacked
  ternaries.

## Deferred

_(none)_

## Verification

- `npm test`: queue-model, event-hub suites green with the new cases.
- `tests/sdk/queued-batches.test.ts` (LIVE): all five tests pass on SDK
  0.3.258, the mid-drain case with file order run 1 < OMEGA < append <
  last.
- `npm run presubmit` green.

# WORK LOG

- [x] Anton reviews this plan (2026-09-20): hub reads `delivery`; the
      mid-drain assumption gets a probe and an sdk test.
- [x] Probe `docs/derisk/queued-batches/probe-mid-drain.mjs` (2026-09-20,
      LIVE, 10 calls): a default-priority prompt pushed during run 1's
      turn runs before the `later` bucket's remaining runs (P1 → N0 →
      P2 → P3). A `now` prompt _interrupts_ the running turn: R1
      `cancelled`, its user entry in the file with no assistant reply,
      still a `result`; then R0, R2, R3. Findings in the README and
      docs/claude-agent-sdk.md.
- [x] Step 0 sdk test: `midDrain` pushed at the first `stream_event`
      after the sleep turn's `result`; session ends when both it and
      `mixed[3]` complete; asserts file order run 1 < midDrain < append <
      last.
- [x] Step 1 queue model: run rule in the `result` branch; "mixed bucket"
      test split into append-then-turn; `[Q,Q,A,Q]` and mid-drain
      cut-ahead tests added.
- [x] Step 2 hub: transition computed first; steer applied before the
      trigger's `sdkMessage`, turn/append after; steer ordering test.
- [x] Step 3 docs: `protocol.ts` header, `queue-model.ts` and
      `event-hub.ts` comments, `docs/user-message-tracking.md`.
- [x] Step 4 presubmit green (717 tests); sdk test LIVE 5/5; handed to
      Anton for review 2026-09-20.
