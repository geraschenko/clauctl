# Adopt the shared stream engine from pictl

# SPEC

## Problem

clauctl's fold-based streaming (`docs/specs/wait-and-tail-until.md`) was
designed for hand-off to pictl. pictl's `docs/specs/fold-streaming.md`
(commit 5cdfc01) completed that hand-off and, in doing so, extracted the
repo-agnostic parts into two sync-clean files written explicitly for
clauctl's `scripts/sync-from-pictl.mjs`:

- `until-engine.ts` — the `--until` grammar (`parseUntilCondition`,
  `secondsToTimerMs`, `UNTIL_USAGE`, `UNTIL_COMPLETIONS`,
  `UntilTimeoutError`) plus `makeUntilCheckers<TEvent, TState>` over an
  `UntilPredicates` parameter (`isIdle`, `isTurnEnd`);
- `stream-driver.ts` — the generic `runStream<TEvent, TState>` driver with
  async FIFO handler dispatch, returning `StreamResult<TState>`.

Both import only each other and `util.ts` (already in the sync set). pictl's
spec defers the clauctl adoption to "a clauctl spec/commit" — this is that
spec: add the engine files (and their tests) to the sync set and rewrite
clauctl's local `until.ts`/`streaming.ts` onto them, deleting the duplicated
grammar and driver.

The pictl driver does not fold — it requires the socket client to deliver
`(event, post-fold state)` pairs (pictl's v2 design: the pairing keeps a
consumer's view aligned with the event it is processing even under async
handlers). So `SdkSocketClient` takes fold ownership, mirroring pictl's
`PiSocketClient`. This is sound because the daemon's subscribe handler
writes the seed response and attaches the event sink in one synchronous
section (request-handlers.ts): on the wire, every event on a subscribed
connection is strictly after the seed response, so the client can seed its
fold from the response line and fold every subsequent event line.

## Changes

**pictl prerequisite commit** (in the pictl repo, before syncing): reword
the repo-name-bearing comments in `until-engine.ts`, `stream-driver.ts`,
and their tests to repo-neutral phrasing (e.g. "the consuming repo's sync
script" instead of "clauctl's sync-from-pictl script"; drop or generalize
the "see streaming.ts for pictl's instantiation over
RpcSocketBroadcastEvent/RpcSessionState" pointer), so the sync transform's
`pictl → clauctl` rename produces sensible text. Comment-only.

**`scripts/sync-from-pictl.mjs`**: the core sync set gains
`until-engine.ts`, `until-engine.test.ts`, `stream-driver.ts`,
`stream-driver.test.ts`. No transform changes: the files import only each
other and `util.ts`, all in-set, so imports stay `./`.

**Behavior changes** (accepted, match pictl):

- Socket close before the seed **rejects** ("socket closed before the
  subscribe seed") instead of resolving `"closed"`: bare `tail` racing a
  daemon close in the subscribe window exits 1 instead of 0. More correct —
  the snapshot was never printed, so tail produced nothing.
- The quiet timer resets as each handler call _completes_ (async pump)
  rather than as each event is processed — indistinguishable for clauctl's
  synchronous handlers.

Everything else — condition semantics, command surfaces, exit codes,
output — is unchanged.

## Type design

`src/core/agent-state.ts` — rename, matching the engine's grammar-word
terminology (name the condition, not its negation):

```ts
export const isIdle = (state: AgentState): boolean =>
  state.activity === "idle" && queryingCount(state) === 0;
// isBusy deleted; comments referencing it updated.
```

`src/core/daemon/queue-model.ts` — the `busy: boolean` parameter of
`acceptUserMessage` becomes `isIdle: boolean` (sense inverted:
`if (!busy)` → `if (isIdle)`); prose comments reworded. The event-hub call
site passes `isIdle(this.state)`.

`src/core/sdk-socket.ts` — the client owns the fold:

```ts
/** Seeds its internal AgentState at dispatch of the subscribe response and
 *  folds every subsequent event through nextAgentState before delivering
 *  the (event, post-fold state) pair — events cannot precede the seed on
 *  the wire (the daemon sends the seed response before attaching the event
 *  sink). Second subscribe still throws. */
subscribe(
  onEvent: (event: SdkEvent, state: AgentState) => void,
): Promise<AgentState>;
```

`src/core/until.ts` — shrinks to the instantiation; the grammar is deleted
locally (byte-identical to the engine's) and its consumers re-import from
`generated/until-engine.ts`. The condition-semantics doc comment (what
turn-end/idle/no-activity mean in clauctl terms) stays here:

```ts
import { makeUntilCheckers } from "./generated/until-engine.ts";
import { isIdle, type AgentState } from "./agent-state.ts";
import type { SdkEvent } from "./sdk-socket.ts";

export const { untilMetAtSeed, untilMetByEvent, untilQuietMs } =
  makeUntilCheckers<SdkEvent, AgentState>({
    isIdle,
    isTurnEnd: (event) =>
      event.kind === "sdkMessage" && event.message.type === "result",
  });
```

`src/core/streaming.ts` — deleted. `tail.ts`, `wait.ts`, and
`lifecycle.ts` import `runStream` (and `StreamHandler` types as needed)
from `generated/stream-driver.ts` and adapt to `StreamResult<AgentState>`:
`outcome === "closed"` checks become `(await runStream(...)).outcome ===
"closed"`. No clauctl caller reads `result.state` today; the field is
simply available.

`src/core/app.ts` — `UntilTimeoutError` import moves from `./until.ts` to
`./generated/until-engine.ts`; exit-code mapping unchanged.

`src/core/tail.ts`, `src/core/wait.ts`, `src/core/lifecycle.ts` — grammar
imports (`parseUntilCondition`, `UNTIL_USAGE`, `UNTIL_COMPLETIONS`,
`secondsToTimerMs`, `UntilTimeoutError`, `type UntilCondition`, per file's
current usage) move to `generated/until-engine.ts`; checker imports
(`untilMetAtSeed`, `untilMetByEvent`, `untilQuietMs`) stay on `./until.ts`.

Tests:

- `src/core/streaming.test.ts` — deleted, superseded by the synced
  `stream-driver.test.ts` (which additionally covers async-handler
  serialization).
- `src/core/until.test.ts` — grammar and duration cases dropped (covered
  by the synced `until-engine.test.ts`); keeps the clauctl-specific
  checker cases (turn-end = `result` message, compaction result counts,
  idle vs. queued querying messages, met-at-seed variants).
- `src/core/sdk-socket.test.ts` — gains fold-ownership tests against the
  existing daemon test harness: subscribe resolves with the seed, pairs
  carry post-fold state, events dispatched in the same chunk as the
  subscribe response fold correctly, second subscribe throws.

## Data flow

daemon → wire (seed response, then events, totally ordered) → client fold
(`nextAgentState`, one fold per event) → driver FIFO pump → handler
(prints, judges the until checkers against the pair's state snapshot).
The fold relocates from the driver into the client; total per-event work
is unchanged.

## Cost

- Runtime: ~zero delta. Same one fold per event, relocated; the driver's
  async pump adds a promise chain per event over today's synchronous call —
  negligible.
- Review: concentrates in the `sdk-socket.ts` subscribe signature change
  (fold ownership) and the `queue-model.ts` boolean sense inversion
  (`busy` → `isIdle`). These are the places to read carefully.

## Edge cases

- Events racing the subscribe response's microtask: the client has already
  seeded (dispatch is line-ordered and synchronous), so pairs are
  well-formed; the driver queues pairs delivered before `onSeed` completes
  and processes them after, preserving tail's snapshot-first output order.
- Close before the seed: `runStream` rejects (see Behavior changes); bare
  `tail` maps it to exit 1.
- The queue-model inversion must not change behavior: `acceptUserMessage`
  with `isIdle === true` takes the immediate-dequeue branch that
  `busy === false` takes today.

## Success criteria

1. `node scripts/sync-from-pictl.mjs --check` passes with the four new
   files in `src/core/generated/`.
2. `src/core/streaming.ts` is gone; the local `until.ts` contains no
   grammar — `grep -rn "parseUntilCondition\|secondsToTimerMs" src/`
   hits only `generated/` and import sites.
3. `grep -rn "isBusy" src/` has no hits (rename complete, comments
   included).
4. All `wait-and-tail-until.md` success criteria still hold (spot-check:
   `wait --until turn-end` return-at-result, seed-met idle, dormant fast
   path, `tail --until` exit codes, archive's polite stop surface).
5. Unit tests: synced `until-engine.test.ts` / `stream-driver.test.ts`
   pass as-is; trimmed `until.test.ts` covers the clauctl checker
   semantics; `sdk-socket.test.ts` covers fold ownership.
6. `npm run presubmit` passes.

## Non-goals (deferred)

- Consuming `StreamResult.state` in any clauctl command (pictl uses it for
  its final cursor; no clauctl consumer needs it yet).
- Any change to condition semantics, command flags, or output formats.
- Syncing pictl's repo-specific layers (`streaming.ts`, `until.ts`,
  `wait.ts`, `pi-socket-client.ts` are pi-shaped and stay unshared).

# IMPLEMENTATION IDEAS

- Order of work: (1) pictl comment-neutralizing commit; (2) sync-set
  addition + run the script; (3) `isBusy` → `isIdle` rename (agent-state,
  event-hub, queue-model — mechanical, sense inversion only at the
  queue-model parameter); (4) sdk-socket fold ownership; (5) rewrite
  `until.ts` onto `makeUntilCheckers`, retarget grammar imports; (6) delete
  `streaming.ts`, adapt the three `runStream` call sites to `StreamResult`;
  (7) test reshuffle.
- Client fold implementation sketch: `subscribe()` stores the callback and
  marks the pending subscribe request id; the data-dispatch path seeds
  `this.state` from that response's `data` before resolving the request
  promise, and folds subsequent event records through `nextAgentState`
  before invoking the callback with the pair.
- The driver's close-behind-pump semantics ("closed" settles after the
  in-flight handler call) are new to clauctl but only observable with async
  handlers; clauctl's handlers are synchronous, so call sites need no
  changes beyond the `StreamResult` shape.
- clauctl's old driver processed pre-seed buffered events with a
  `settled` re-check inside the drain loop; the synced driver gets the
  same effect from the pump's per-link `settled || closed` check.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-21: Spec written after derisk discussion. Decisions (Anton):
  (1) `isBusy` → `isIdle` everywhere, including event-hub and the
  queue-model parameter; (2) close-before-seed rejects, matching pictl
  (bare-tail exit 0 → 1 in that race accepted); (3) `runStream` returning
  the final state is kept (more correct), though no clauctl caller reads
  it; (4) pictl engine comments made repo-neutral in a pictl prerequisite
  commit rather than accepting mangled sync output. Verified during
  derisk: the daemon's synchronous seed-then-attach subscribe handler
  guarantees the wire ordering the client fold needs; `subscribe`'s only
  production consumer is `runStream`, so the signature change has minimal
  blast radius.
- 2026-07-21: Implemented. pictl 269da9d neutralizes the engine comments
  (`npm run check` there needed an `npm install` first — node_modules was
  stale at 0.80.9-fork.0 vs the committed lockfile's 0.80.10-fork.0, a
  pre-existing condition). Sync set + script run; `isBusy` → `isIdle`
  rename (agent-state, event-hub, queue-model incl. test-boolean
  inversion, until.ts, and `src/tui/interactive-mode.ts` — a use site the
  spec's file list missed); sdk-socket fold ownership; until.ts rewritten
  onto `makeUntilCheckers`; streaming.ts + streaming.test.ts deleted and
  the three call sites moved to `generated/stream-driver.ts` with
  `{ outcome }` destructuring; until.test.ts trimmed; fold-ownership test
  added to sdk-socket.test.ts (real `startSdkServer`, single-chunk
  seed+events write). Syncing also pulled pictl 5cdfc01's cosmetic generic
  renames into `generated/cli.ts`/`flat-tree.ts`/`tree-layout.ts`
  (`F`→`TFlag`/`TFlags`, `T`→`TPayload`) — required to keep `--check`
  green against pictl HEAD. `npm run presubmit` passes (401 tests; the
  usual first-run treefmt reformat). Live smoke test in an isolated
  `CLAUCTL_DIR`: seed-met `wait --until idle` 0 in ~0.6s, `tail --until
  no-activity:1 --timeout 5` exit 0, busy `tail --until idle --timeout
  0.2` exit 3, `query` + `wait --until turn-end` exit 0, polite archive,
  dormant-agent `wait --until no-activity:5` immediate exit 0.

## Implementation-Time Decisions

- **`subscribe` resolves the response's seed, not the live folded state**:
  events dispatched in the same chunk as the subscribe response fold and
  deliver before the promise settles; resolving the live state would
  double-represent them (the driver queues those pairs and replays them
  after `onSeed`, so tail would print a snapshot already containing events
  it then prints again). Pinned by the sdk-socket fold-ownership test.
- **`request()` split into `sendRequest` returning `{id, response}`**:
  the dispatch path seeds the fold when the response with
  `subscribeRequestId` arrives, so subscribe must know its request id
  before awaiting — without duplicating the write/pending bookkeeping.
- **Pre-seed event lines are dropped, not folded**: an event before the
  subscribe response would violate the daemon protocol (the seed response
  is written before the event sink attaches); there is nothing to fold it
  into, and delivering it unfolded would hand consumers a stale state.
- **queue-model test booleans inverted mechanically**: the `accept()`
  helper's third argument flipped at every call site (`busy` → `isIdle`);
  test titles still describe the scenario ("busy accept") and were left
  alone.

- 2026-07-21: Post-implementation review. Fixed: one more repo-specific
  phrase in pictl's stream-driver.ts comment ("pi socket closed" example →
  neutral; pictl 2af38c7, resynced) — plus a housekeeping pictl commit
  (73ea653) isolating the package-lock normalization my `npm install`
  produced. Noted: the presubmit's treefmt pass also reformatted two
  pre-existing unformatted docs (`tui-keybindings.md`, `tui-error.md`) —
  unrelated to this change. **Correction to the derisk note above**:
  `runStream` is not subscribe's only production consumer — the TUI
  (`interactive-mode.ts` line ~131) also subscribes, folding its own
  state via `nextAgentState`. It compiles unchanged against the new
  signature (one-param callback) and its independent fold produces
  identical states, so behavior is unaffected — but the fold is now
  duplicated client-side. Adapting the TUI to consume the delivered
  (event, state) pairs would touch its replay-buffering paths; left out
  of scope, flagged for a decision.
- 2026-07-21: TUI adapted to consume the delivered pairs (approved
  follow-up to the flag above). `handleEvent(event, state)` assigns
  `this.agentState = state` instead of folding; the two deferred-event
  buffers (`runInteractive`'s subscribe-window buffer and
  `liveEventsDuringReplay`) carry `[SdkEvent, AgentState]` pairs so late
  processing still lands the right snapshot; the TUI's `nextAgentState`
  import and fold-referencing comments removed/updated. Smoke-tested by
  running `_tui` directly under a pty against a live agent: history
  replay renders, and a query sent mid-session renders its echo and
  reply through the live pair path (also exercising the replay buffer),
  no exceptions. Note: `attach` under a headless pty (`script`)
  disconnects immediately in this environment — pre-existing harness
  artifact, not this change (the daemon-managed `_tui` process stayed
  alive and subscribed throughout); direct `_tui` was used instead.
  Presubmit green (401 tests). Not committed (Anton commits).
