# Daemon Architecture: Unified AgentState Fold + Directory Restructure

# SPEC

## Problem

Two related defects, found during the post-attach architecture review of
`src/core/daemon/`:

1. **The observable-state type surface is wrong.** `sdk-socket.ts` claims
   "daemon state is always reconstructible by an observer folding the emitted
   stream," but that is only enforced for `AssistantState` (the 4-state
   activity model). Every other `StateSnapshot` field is maintained by two
   independent hand-rolled implementations: the daemon's `trackedState` +
   `deliveredPending` closures in `daemon/daemon.ts`, and the tui's
   `notePermissionMode` / ad-hoc `footer.setModel` calls in
   `interactive-mode.ts`. The prompt-visibility invariant is upheld by three
   cooperating code sites that reference each other through comments.

2. **`daemon/daemon.ts` (~646 lines) is a bag of responsibilities** held
   together by shared closures: request semantics, observable-state tracking,
   stream reading, tty/tui wiring, record persistence, and lifecycle. Four
   review comments (TDCs) all point at unclear file responsibilities.

## What we want

One `AgentState` type and one pure fold `nextAgentState(state, event)`,
defined in `src/core/agent-state.ts`, maintained identically by the daemon
and every stateful in-repo subscriber (`tail.ts` subscribes but deliberately
does not fold state; external clients can reconstruct state from the seed and
stream but are not forced to). `AssistantState`, `StateSnapshot`, and
`QueuedEntry` are deleted — not aliased, not wrapped. The daemon directory is
restructured so each file has one stated responsibility and `daemon.ts` reads
as a composition root: startup, wiring, teardown.

## Success criteria

- `AgentState` is the only observable-state type; `rg 'AssistantState|StateSnapshot|QueuedEntry' src/` returns nothing.
- The daemon and the tui maintain their state exclusively via `nextAgentState`; the tui's hand-tracking (`notePermissionMode`, scattered `footer.set*` event cases) is deleted.
- `trackedState`, `deliveredPending`, `observePermissionMode`, and `queue-model.ts`'s `deliveredMessages()` no longer exist — the fold subsumes them.
- The prompt-visibility bookkeeping is enforced in one place (the fold) and tested at the fold's interface (see "Fold tests" for the honest scope of what those tests can prove).
- `daemon/daemon.ts` contains only: CLI entry, startup classification, record ownership + serialized writes, the stream read loop (see "Stream reader" below), module wiring, teardown, signals.
- The four TDC comments in `daemon/daemon.ts` are resolved and removed.
- Each new module carries a header comment stating its responsibility and the design rationale (why the seam is where it is).
- Living docs (`docs/overview.md`, `docs/user-message-tracking.md`, `docs/implementation-plan.md`) are audited and updated to the new names/architecture. Historical phase/feature specs are left untouched.
- Presubmit green after every implementation step (each step lands independently; see the restructured step list in IMPLEMENTATION IDEAS).

## Type design

### `src/core/agent-state.ts` (replaces `assistant-state.ts`)

Protocol layer, shared by daemon and clients (same role `assistant-state.ts`
has today, including the type-only import cycle with `sdk-socket.ts`).
`nextAgentState` is a free function, not a method: `AgentState` is a wire
type (the subscribe response), and a method-bearing class would not survive
JSON serialization — daemon-side and client-side values must be the same
kind of thing. All fields are readonly — shallowly: the fold never mutates
its input and returns a new value when state changes; nested SDK payloads
(`SDKUserMessage`) are treated as immutable by convention, since the EventHub
hands out its internal object and callers must not be able to change state
without an event.

```ts
export type AgentActivity = "idle" | "pending" | "working" | "compacting";

/**
 * The observable state of an agent as seen over sdk.sock: a pure fold over
 * the emitted SdkEvent stream from a seed. The daemon and every stateful
 * subscriber maintain it with the same fold, so any observer's state always
 * matches the daemon's. Excluded by design: rendering state, queue-model
 * inference state (daemon-internal), the persisted AgentRecord, and tty
 * attachment state. Arrays are always present (empty, not absent); optional
 * scalars mean "not yet observed".
 */
export interface AgentState {
  readonly activity: AgentActivity;
  readonly sessionId?: string;
  readonly model?: string;
  readonly permissionMode?: PermissionMode;
  /** Every mode observed this daemon lifetime, in first-observed order. */
  readonly observedPermissionModes: readonly PermissionMode[];
  readonly cwd?: string;
  /** Accepted, not yet consumed by the CLI. */
  readonly queuedMessages: readonly { id: number; message: SDKUserMessage }[];
  /** Consumed as turn/append, not yet confirmed by a later stream emission. */
  readonly deliveredMessages: readonly SDKUserMessage[];
  /** The attach boundary: uuid of the last user/assistant message emitted. */
  readonly lastTranscriptUuid?: string;
}

export const INITIAL_AGENT_STATE: AgentState;

export function nextAgentState(state: AgentState, event: SdkEvent): AgentState;

export function isBusy(state: AgentState): boolean;
```

#### Fold transition table (complete; migrated behavior, no new rules)

For `sdkMessage` events, the uuid/boundary step applies first, then the
subtype step.

| Event                                               | Effect                                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userMessageQueued {id, message}`                   | Append `{id, message}` to `queuedMessages`. Activity: `pending` if `message.shouldQuery !== false` and activity is `idle`; else unchanged.                                                                                              |
| `userMessageDequeued {delivery: turn\|append, ids}` | Remove matching entries from `queuedMessages`, append their messages to `deliveredMessages` in `ids` order. Unknown ids are ignored. Activity unchanged (the dequeue follows a `result` that already decided it).                       |
| `userMessageDequeued {delivery: steer, ids}`        | Remove matching entries from `queuedMessages` only — steered messages never get transcript turns, so they must not enter `deliveredMessages`.                                                                                           |
| `compactSent`                                       | Activity → `compacting`.                                                                                                                                                                                                                |
| `interruptSent`                                     | No change (the transition happens at the terminating `result`).                                                                                                                                                                         |
| `controlApplied {set-model}`                        | `model` ← `request.model` (undefined means the SDK default; tracked as unset).                                                                                                                                                          |
| `controlApplied {set-permission-mode}`              | `permissionMode` ← mode; append to `observedPermissionModes` if not present.                                                                                                                                                            |
| `controlApplied {other mutations}`                  | No change.                                                                                                                                                                                                                              |
| `sdkMessage`, `user`/`assistant` with `uuid`        | `lastTranscriptUuid` ← uuid; `deliveredMessages` ← `[]` (same fold step — this is the prompt-visibility bookkeeping). Then the subtype steps below also apply.                                                                          |
| `sdkMessage system/init`                            | `sessionId` ← `session_id`; `model` ← `model`; `cwd` ← `cwd`; permission mode observed (as in set-permission-mode).                                                                                                                     |
| `sdkMessage system/status` with `permissionMode`    | Permission mode observed.                                                                                                                                                                                                               |
| `sdkMessage assistant`, activity ≠ `compacting`     | Activity → `working`.                                                                                                                                                                                                                   |
| `sdkMessage result`                                 | Activity → `pending` if any queued message has `shouldQuery !== false`, else `idle`. (The about-to-run bucket is still in `queuedMessages` — its dequeue event follows the result — so the fold never passes through a transient idle.) |
| `sdkMessage` (anything else)                        | No change.                                                                                                                                                                                                                              |

### `src/core/daemon/event-hub.ts` — EventHub (renamed from EventBus) absorbs the queue model

Responsibility (this sentence goes in the class docstring): the daemon's only
mutable object for observable state — the single point where every occurrence
becomes an ordered event and its effects (broadcast, state fold, queue model,
waiter wakeup) are applied in one synchronous step. "Hub" not "bus": a bus is
domain-blind transport; this is the central attachment point that also folds
state and originates queue events. The heavy logic lives in pure modules
(`agent-state.ts`, `queue-model.ts`); the hub is the atomic composition point.
Broadcast sinks and idle waiters stay as internal fields (a Set and an array),
not extracted classes — one caller each, no variation across the seam.

Interface discipline: the hub's public surface makes invariant violations
unrepresentable. `emit` is typed to the simple-event subset, so raw
`sdkMessage` or queued/dequeued events cannot bypass the queue model; the
constructor takes a narrow seed, so the state and the fresh queue model
cannot start in disagreement; the `deliver` callback lives inside
`deliverUserMessage`, so a delivered-but-unmodeled (or modeled-but-
undelivered) message cannot exist.

```ts
export interface EventHubOptions {
  /** Pre-init values meaningful before the first system/init — the same
   *  seed-then-fold contract subscribers follow. On revival, sessionId is
   *  the last recorded session. */
  seed: { cwd: string; sessionId?: string };
  /** Hands an accepted message to the SDK (wired to turnQueue.push).
   *  Called by deliverUserMessage before the queued events are emitted,
   *  preserving today's push-before-emit order. */
  deliver: (message: SDKUserMessage) => void;
}

export class EventHub {
  constructor(options: EventHubOptions);

  get agentState(): AgentState;

  /** Attach a subscriber sink; returns the unsubscribe function. Sinks must
   *  not throw (interface requirement, as today: the only production sink is
   *  sdk-server's guarded connection.write) — a throwing sink would starve
   *  later sinks and idle waiters after the state has already folded. */
  subscribe(sink: (serializedEventRecord: string) => void): () => void;

  /** Events with no queue-model involvement. Anything else must go through
   *  deliverUserMessage/observeSdkMessage. */
  emit(
    event: Extract<
      SdkEvent,
      { kind: "interruptSent" | "compactSent" | "controlApplied" }
    >,
  ): void;

  /**
   * Deliver a user message to the SDK (via the deliver callback) and advance
   * the queue model (queue-model's acceptUserMessage; busy computed from own
   * state), emitting the queued/dequeued events — one atomic step, so the
   * model/queue lockstep is owned here, not by calling convention.
   */
  deliverUserMessage(message: SDKUserMessage): void;

  /** Emit the sdkMessage event plus any dequeues the queue model implies. */
  observeSdkMessage(message: SDKMessage): void;

  /** Resolves once activity is idle (immediately if it already is). */
  whenIdle(): Promise<void>;
}
```

Per-occurrence ordering (applies to all three mutation methods): fold state
first, then write sinks, then wake idle waiters — so any synchronous observer
(a sink, a woken waiter) sees post-event state. Within
`deliverUserMessage`: `deliver()` first, then the fold/broadcast of its
events.

The `/compact`-requires-idle check stays in the request dispatcher (request
semantics), reading `events.agentState`; the compact message is pushed to the
TurnQueue directly by the dispatcher (compaction deliberately bypasses the
queue model) and announced via `emit({kind: "compactSent", ...})`.

### `src/core/daemon/request-handlers.ts` (new)

Extraction rationale: this is deliberately a relocation of the dispatch
switch, not a deep module — the leverage is that `daemon.ts` becomes readable
as a composition root, and request semantics become testable through fake
deps without a real daemon.

```ts
export interface RequestHandlerDeps {
  claudeQuery: Query;
  events: EventHub;
  /** Compact-path pushes only; ordinary messages go through
   *  events.deliverUserMessage. */
  turnQueue: TurnQueue;
  /** getSessionMessages dir. */
  cwd: string;
  /** Mutation persistence; the write itself is queued by daemon.ts. */
  getPersistedOptions(): PersistedOptions;
  setPersistedOptions(options: PersistedOptions): void;
}

export function createRequestHandler(
  deps: RequestHandlerDeps,
): (request: SdkRequestRecord, connection: SdkConnection) => Promise<unknown>;
```

- The mutation serialization chain lives inside as closure state.
- `get-messages` and `subscribe` read `sessionId` from `events.agentState`
  (valid before first init because of seeding); the record never crosses
  this seam.
- `subscribe` keeps its write-own-response `RESPONSE_SENT` behavior; its
  response `data` is `events.agentState`, serialized as-is.

### `src/core/daemon/tty-service.ts` (new)

TuiHost and TtyServer become internal to this module; daemon.ts sees neither.

```ts
export interface TtyServiceOptions {
  agentDir: string;
  cwd: string;
  env: Record<string, string>;
  sdkSocket: string;
  /** Evaluated once by daemon.ts. */
  auditEnabled: boolean;
  onAttachmentsChanged(attachments: AttachmentInfo[]): void;
  onTuiFailedChanged(failedAt: string | undefined): void;
  log(message: string): void;
}

export interface TtyService {
  /** Teardown phase 1: stop respawning, SIGTERM the tui. */
  stopTui(): void;
  /** Teardown phase 2: exit frames to attachers + close, after stream end. */
  shutdown(reason: string): Promise<void>;
}

export function startTtyService(opts: TtyServiceOptions): Promise<TtyService>;
```

Partial-startup cleanup: the tui is spawned before the socket listen; if
`listen` rejects, `startTtyService` kills the spawned tui before rethrowing —
a rejected `startTtyService` leaves no live child behind, since the caller
has no handle to clean up with.

### `src/core/daemon/queue-model.ts` (moved from `src/core/`)

Moves under `daemon/` with its test; `deliveredMessages()` is deleted
(subsumed by the fold). It remains the daemon-only _decider_ of which
queued/dequeued events to synthesize; its internal state (`toolResultSeen`
inference) stays separate from `AgentState.queuedMessages` (the folded
_result_) — merging them would leak daemon inference into the protocol. Its
pure `acceptUserMessage` keeps its name: the hub's `deliverUserMessage`
forwards to it, and the two names describe the two distinct acts.

### `src/core/sdk-socket.ts`

- `StateSnapshot` deleted; the subscribe response documents itself as the
  daemon's current `AgentState`.
- `SdkSocketClient.subscribe(onEvent)` returns `Promise<AgentState>`.
- `SDK_SOCKET_VERSION` stays 1: pre-release, zero users, no compatibility
  obligation — bumping would be ceremony.
- The prompt-visibility invariant documentation moves to `agent-state.ts`
  (it is now a property of the fold).

### `src/tui/components/footer.ts` and `interactive-mode.ts`

The four piecemeal setters (`setAssistantState`, `setModel`,
`setPermissionMode`, `setSessionId`) are replaced by one:

```ts
setState(state: AgentState): void;
```

The footer derives its display fields (model/mode default-display convention
included) internally. In `interactive-mode.ts`:

- One `AgentState` field, seeded from the subscribe response, advanced only
  by `nextAgentState` — on **live** events only. Historical replay renders
  transcript messages but must not fold them (they predate the seed).
- `footer.setState(this.agentState)` once per fold step.
- `notePermissionMode`, the hand-maintained `permissionMode` /
  `observedPermissionModes` fields, and the per-event `footer.set*` cases are
  deleted; `cyclePermissionMode` reads `this.agentState.permissionMode` /
  `.observedPermissionModes` instead.

### Deletions

- `src/core/assistant-state.ts` + `assistant-state.test.ts` (replaced by
  `agent-state.ts` + its tests; assertions migrate — replace, don't layer).
- `StateSnapshot`, `AssistantState`, `AssistantActivity` (renamed
  `AgentActivity`), `QueuedEntry`, `nextAssistantState`,
  `INITIAL_ASSISTANT_STATE`.
- In `daemon/daemon.ts`: `trackedState`, `deliveredPending`,
  `observePermissionMode`, `applyQueueTransition`, `controlApplied`'s state
  tracking (the `controlApplied` event emission moves with the mutation path
  into `request-handlers.ts`).
- In `queue-model.ts`: `deliveredMessages()`.
- In `interactive-mode.ts`: `notePermissionMode`, the per-event
  `footer.set*` cases, the hand-maintained `permissionMode` /
  `observedPermissionModes` fields.

## Stream reader (explicit assignment)

With state tracking gone into the fold, what remains of the reader is record
bookkeeping plus a trivial loop, and it stays in `daemon.ts` deliberately —
it is the record owner's code (E), not a module of its own:

```
for await message:
  on system/init → record bookkeeping (claudeCodeVersion, session rollover
                    via sessionFilePath, queueRecordWrite) — BEFORE the fold,
                    as today
  events.observeSdkMessage(message)
```

Reader completion/failure handling (`readerDone`, `cleanupAndExit`) is
lifecycle and also stays.

## Edge cases

- **Revival before first init**: `sessionId`/`cwd` come from the seed;
  `get-messages` must behave as today (reads the last recorded session's
  transcript).
- **`observedPermissionModes` spans one daemon lifetime** (seeded empty; a
  subscriber inherits the daemon's accumulated list via its seed). Unchanged
  semantics.
- **Idle accept**: `userMessageQueued` + immediate `userMessageDequeued` in
  one transition; the fold sees both events in order, so the message passes
  through `queuedMessages` into `deliveredMessages` within one
  `deliverUserMessage` call.
- **Session rollover boundary staleness** (pre-existing, unchanged): after a
  rollover init, `lastTranscriptUuid` still points into the previous
  session's transcript until the next uuid-carrying message. Documented, not
  fixed here.
- **Teardown ordering**: `stopTui()` fires at `cleanupAndExit` entry;
  `shutdown(reason)` only after `writeQueue`/`readerDone` settle — same
  ordering as today.

## Non-goals

- No backward compatibility for the sdk.sock wire format or any renamed
  symbol; no protocol version bump (pre-release, zero users).
- No changes to `SdkEvent`, the queue model's inference rules, the
  assistant-activity transition rules, or any runtime behavior other than
  the wire shape of the subscribe response.
- No `RecordStore` abstraction for agent.json (deferred; revisit after the
  restructure).
- Historical spec docs are not rewritten.

# IMPLEMENTATION IDEAS

## Resolved: EventHub name and internal decomposition

The class outgrew "bus" (a bus is domain-blind transport): it folds state,
originates queue events, and answers `whenIdle`. Alternatives considered:
keeping `EventBus` + a defining header comment; `AgentStateHub` (awkward —
subscribers attach for the stream, not the state); `AgentStateStore`
(Redux-familiar but hints at persistence); `AgentStateTracker` (undersells
broadcast). `EventHub` won: events are the currency, the state is a derived
view, and "hub" carries "central attachment point" without the pure-transport
implication.

Internal decomposition probe (resolved): both folds are already pure modules
outside the class (`nextAgentState`, queue-model functions), so the class body
is ~70 lines of glue. `nextAgentState` stays a free function — `AgentState`
is a wire type (the subscribe response), and a method-bearing class would not
survive JSON serialization, forcing rehydration and making daemon-side and
client-side values different kinds of thing. Broadcaster and idle waiters are
not worth extracting (a Set wrapper and a resolver array; one caller each —
hypothetical seams).

Reviewer pushback considered and declined: splitting queue intake into a
separate message-delivery module. Held position: emit/fold atomicity and
model/queue lockstep are exactly why one object owns them; the heavy logic
is already outside the class.

## Implementation order (each step presubmit-green)

Restructured after review: the original steps 1–3 could not each be green
(step 1 deleted `assistant-state.ts` while daemon/tui still imported it).

1. **Add** `agent-state.ts` + full fold + tests. Nothing imports it yet;
   old files untouched. Green trivially.
2. **Atomic cutover** (one landed change, inherently so — the type surface
   is shared): `sdk-socket.ts` (subscribe → `AgentState`), daemon (EventHub
   rename + queue-model absorption + seeding + `trackedState`/
   `deliveredPending` deletion), tui + footer adoption, all old-symbol
   deletions, old test migration.
3. `queue-model.ts` moves under `daemon/`; `deliveredMessages()` removed.
4. Structural splits: `request-handlers.ts`, `tty-service.ts`, daemon.ts
   reduced to composition root; TDC comments removed as each resolves.
5. Documentation audit of the living docs.

## Test plan

**Fold tests (`agent-state.test.ts`)** — migrate old `assistant-state.test.ts`
activity assertions, plus the transition table, plus prompt-visibility
_bookkeeping_ properties (the fold cannot prove transcript presence — that
rests on the documented CLI transcript-ordering assumption, stated in the
fold's comments):

- a turn/append dequeue moves the referenced messages from `queuedMessages`
  to `deliveredMessages` in the same fold step;
- a steer dequeue removes without delivering;
- a uuid-carrying user/assistant message advances `lastTranscriptUuid` and
  clears `deliveredMessages` in the same fold step;
- unrelated events change neither.

**EventHub interface tests** — subscribe sees post-event state (fold-before-
broadcast ordering); `deliverUserMessage` calls `deliver` before its events
reach sinks; `whenIdle` resolves on the idle transition and immediately when
already idle; seeded `cwd`/`sessionId` visible before any event.

**Request-handler interface tests** (with fake deps) — `/compact` rejected
when not idle; mutation serialization (two in-flight mutations don't
interleave persistence); subscribe response equals `events.agentState`.

**Replace, don't layer**: old tests tied to deleted shapes are migrated or
deleted, not kept alongside.

## Review checkpoints

- After step 2: fold behavior equivalence (old assistant-state activity
  assertions pass against `nextAgentState`); manual smoke — attach a tui,
  verify footer model/mode/session display through init, set-model,
  plan-mode transition.
- After step 4: `rg TDC:` returns nothing; smoke spawn → attach → SIGTERM;
  tty-service startup-failure path leaves no orphaned tui.

## Design rationale to preserve in header comments

- `agent-state.ts`: state = fold(events) from a seed; why the daemon and
  clients must share this exact code (two hand-rolled copies had already
  diverged in structure); where the prompt-visibility invariant now lives
  and what part of it rests on the CLI transcript-ordering assumption.
- `event-hub.ts`: the one-sentence responsibility (SPEC section) in the class
  docstring; why broadcast + fold + queue model are one object (the emit/fold
  atomicity and model/queue lockstep invariants need a single owner); why
  `emit` is type-narrowed.
- `request-handlers.ts`: request semantics vs transport (sdk-server.ts)
  vs state (event-hub.ts); why the mutation chain exists.
- `tty-service.ts`: why TuiHost/TtyServer wiring is one unit; two-phase
  teardown rationale; partial-startup cleanup.
- `daemon.ts`: composition root — what it wires and deliberately does not
  contain; why the stream reader's remainder lives here.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Resolve EventHub naming / internal decomposition (see IMPLEMENTATION IDEAS)
- [x] Reviewer critique round 1 (pictl reviewer eae28faf): 10 high-confidence findings; adopted — step restructure (1–3 couldn't be green), full transition table, readonly state, narrowed `emit`/constructor seed, `deliver` callback (renamed `deliverUserMessage`), tty partial-startup cleanup, honest prompt-test scope, explicit stream-reader assignment, `subscribe(): Promise<AgentState>`, interface-level test plan. Declined — protocol version bump (pre-release, stays 1), splitting queue intake out of EventHub (atomicity needs one owner).
- [x] Step 1: add `agent-state.ts` + fold + tests (27 tests: migrated activity assertions, transition-table coverage, prompt-visibility bookkeeping). Presubmit green (153 tests).
- [x] Step 2: atomic cutover (sdk-socket, daemon EventHub, tui, footer, deletions; event-hub interface tests). Presubmit green (146 tests). Live smoke: spawned an agent, verified the subscribe seed is a folded AgentState (pending + deliveredMessages mid-delivery; sessionId/model/cwd/modes from init), archive→wait-idle→whenIdle path works.
- [x] Step 3: `queue-model.ts` + test moved under `daemon/`; `deliveredMessages()` and its tests deleted (fold subsumes them; the steer/queued_command rationale moved into the fold's steer case). Presubmit green (142 tests); `rg 'AssistantState|StateSnapshot|QueuedEntry' src/` now empty.
- [x] Step 4: `request-handlers.ts` (dispatch switch + mutation chain + 7 interface tests with fake deps), `tty-service.ts` (TuiHost + TtyServer internal, two-phase teardown, listen-failure kills the tui), daemon.ts reduced to composition root (~330 lines); `rg TDC:` empty. Presubmit green (149 tests). Smoke: spawn → query → tail → archive all work.
- [x] Implementation review round (reviewer eae28faf): fold, composition root, and live/history separation confirmed correct. Adopted — tty-service listen-failure now also shuts the TtyServer down (listen can reject after binding, at its chmod step); `deliver` documented as must-not-throw; EventHub sinks documented as must-not-reenter; header claim softened from "unrepresentable" to typed-surface-plus-documented-contracts; user-message-tracking.md compaction-race bullet rewritten to the actual replay-all-behind-banner behavior (it described pre-bc33d97 render-nothing); overview.md roadmap/virtual-pty and implementation-plan.md status notes updated (both were materially stale beyond the rename audit). Known gaps, deliberately not closed: no automated tests for tty-service failure cleanup, tui fold adoption, or footer projection — beyond the spec's test plan, and tty-service/tui tests would need injectable process fakes (a scope change); covered by review-checkpoint smokes instead (footer smoke still pending, needs an interactive terminal).
- [x] Reviewer approved the implementation after the fixes above (round 2, no remaining blockers).
- [x] Step 5: documentation audit. user-message-tracking.md retargeted to `AgentState`/`nextAgentState` (invariant maintained by the fold; atomicity argument restated as one-event-one-transition; `deliveredPending`/`applyQueueTransition` references gone). implementation-plan.md superseded-note updated. overview.md document map extended with the missing specs incl. daemon-architecture.md. Historical phase/feature specs untouched. Presubmit green.

_Work log entries go here_
