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
and every subscriber. `AssistantState`, `StateSnapshot`, and `QueuedEntry`
are deleted — not aliased, not wrapped. The daemon directory is restructured
so each file has one stated responsibility and `daemon.ts` reads as a
composition root: startup, wiring, teardown.

## Success criteria

- `AgentState` is the only observable-state type; `rg 'AssistantState|StateSnapshot|QueuedEntry' src/` returns nothing.
- The daemon and the tui maintain their state exclusively via `nextAgentState`; the tui's hand-tracking (`notePermissionMode`, scattered `footer.set*` event cases) is deleted.
- `trackedState`, `deliveredPending`, `observePermissionMode`, and `queue-model.ts`'s `deliveredMessages()` no longer exist — the fold subsumes them.
- The prompt-visibility invariant is enforced in one place (the fold) and tested at the fold's interface.
- `daemon/daemon.ts` contains only: CLI entry, startup classification, record ownership + serialized writes, module wiring, teardown, signals.
- The four TDC comments in `daemon/daemon.ts` are resolved and removed.
- Each new module carries a header comment stating its responsibility and the design rationale (why the seam is where it is).
- Living docs (`docs/overview.md`, `docs/user-message-tracking.md`, `docs/implementation-plan.md`) are audited and updated to the new names/architecture. Historical phase/feature specs are left untouched.
- Presubmit green after every implementation step (each step lands independently).

## Type design

### `src/core/agent-state.ts` (replaces `assistant-state.ts`)

Protocol layer, shared by daemon and clients (same role `assistant-state.ts`
has today, including the type-only import cycle with `sdk-socket.ts`).

```ts
export type AgentActivity = "idle" | "pending" | "working" | "compacting";

/**
 * The complete observable state of an agent: a pure fold over the emitted
 * SdkEvent stream from a seed. The daemon and every subscriber maintain it
 * with the same fold, so any observer's state always matches the daemon's.
 * Arrays are always present (empty, not absent); optional scalars mean
 * "not yet observed".
 */
export interface AgentState {
  activity: AgentActivity;
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Every mode observed this daemon lifetime, in first-observed order. */
  observedPermissionModes: PermissionMode[];
  cwd?: string;
  /** Accepted, not yet consumed by the CLI. */
  queuedMessages: { id: number; message: SDKUserMessage }[];
  /** Consumed as turn/append, not yet confirmed by a later stream emission. */
  deliveredMessages: SDKUserMessage[];
  /** The attach boundary: uuid of the last user/assistant message emitted. */
  lastTranscriptUuid?: string;
}

export const INITIAL_AGENT_STATE: AgentState;

export function nextAgentState(state: AgentState, event: SdkEvent): AgentState;

export function isBusy(state: AgentState): boolean;
```

Notes:

- The old `assistantState.queued` (`QueuedEntry`: id + shouldQuery) was a
  projection of `queuedMessages`; the merged fold keeps one queued list and
  derives `shouldQuery` from the message where the activity logic needs it.
- `deliveredMessages` is computed by the fold itself: a turn/append
  `userMessageDequeued` moves the referenced messages from `queuedMessages`
  to `deliveredMessages` (steer dequeues are dropped); the next uuid-carrying
  user/assistant `sdkMessage` advances `lastTranscriptUuid` and clears
  `deliveredMessages` in the same fold step. This subsumes the daemon's
  `deliveredPending` and `queue-model.ts`'s `deliveredMessages()`.
- On the wire, the `subscribe` response `data` is the daemon's current
  `AgentState`, serialized as-is (empty arrays present). No backward
  compatibility with the old optional-when-nonempty `StateSnapshot` shape.

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

```ts
export class EventHub {
  /** Seeded, not always INITIAL_AGENT_STATE — see seeding note below. */
  constructor(initialState: AgentState);

  get agentState(): AgentState;

  /** Attach a subscriber sink; returns the unsubscribe function. */
  subscribe(sink: (serializedEventRecord: string) => void): () => void;

  /** Simple events: interruptSent, compactSent, controlApplied. */
  emit(event: SdkEvent): void;

  /**
   * Advance the queue model (busy computed from own state) and emit the
   * queued/dequeued events; returns the message for the TurnQueue push, so
   * the call site is `turnQueue.push(events.acceptUserMessage(message))` —
   * the model/queue lockstep invariant lives on one line.
   */
  acceptUserMessage(message: SDKUserMessage): SDKUserMessage;

  /** Emit the sdkMessage event plus any dequeues the queue model implies. */
  observeSdkMessage(message: SDKMessage): void;

  /** Resolves once activity is idle (immediately if it already is). */
  whenIdle(): Promise<void>;
}
```

Seeding: the daemon constructs it with
`{ ...INITIAL_AGENT_STATE, cwd: record.cwd, sessionId: <last recorded session, on revival> }`
so `cwd` and `sessionId` are meaningful before the first init — exactly the
seed-then-fold contract subscribers already follow.

The `/compact`-requires-idle check stays in the request dispatcher (request
semantics), reading `events.agentState`.

### `src/core/daemon/request-handlers.ts` (new)

```ts
export interface RequestHandlerDeps {
  claudeQuery: Query;
  events: EventHub;
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
- `subscribe` keeps its write-own-response `RESPONSE_SENT` behavior.

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

### `src/core/daemon/queue-model.ts` (moved from `src/core/`)

Moves under `daemon/` with its test; `deliveredMessages()` is deleted
(subsumed by the fold). It remains the daemon-only *decider* of which
queued/dequeued events to synthesize; its internal state (`toolResultSeen`
inference) stays separate from `AgentState.queuedMessages` (the folded
*result*) — merging them would leak daemon inference into the protocol.

### `src/tui/components/footer.ts`

The four piecemeal setters (`setAssistantState`, `setModel`,
`setPermissionMode`, `setSessionId`) are replaced by one:

```ts
setState(state: AgentState): void;
```

The footer derives its display fields (model/mode default-display convention
included) internally. `interactive-mode.ts` calls it once per fold step.

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

## Edge cases

- **Revival before first init**: `sessionId`/`cwd` come from the seed;
  `get-messages` must behave as today (reads the last recorded session's
  transcript).
- **`observedPermissionModes` spans one daemon lifetime** (seeded empty; a
  subscriber inherits the daemon's accumulated list via its seed). Unchanged
  semantics.
- **Idle accept**: `userMessageQueued` + immediate `userMessageDequeued` in
  one transition; the fold sees both events in order, so the message passes
  through `queuedMessages` into `deliveredMessages` within one accept call.
- **Teardown ordering**: `stopTui()` fires at `cleanupAndExit` entry;
  `shutdown(reason)` only after `writeQueue`/`readerDone` settle — same
  ordering as today.

## Non-goals

- No backward compatibility for the sdk.sock wire format or any renamed
  symbol.
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

## Implementation order (each step presubmit-green)

1. `agent-state.ts` + full fold + tests (including a prompt-visibility test:
   fold over an event sequence never shows a prompt twice or zero times).
   Old `assistant-state.test.ts` assertions migrate; old files die.
2. Daemon adopts it: EventHub holds `AgentState` (seeded), absorbs the queue
   model; `trackedState`/`deliveredPending` deleted; subscribe returns
   `events.agentState`.
3. Tui adopts it: hand-tracking deleted; footer `setState`; protocol type
   renames complete.
4. `queue-model.ts` moves under `daemon/`; `deliveredMessages()` removed.
5. Structural splits: `request-handlers.ts`, `tty-service.ts`, daemon.ts
   reduced to composition root; TDC comments removed as each resolves.
6. Documentation audit of the living docs.

(Steps 2 and 5 may merge if the dispatcher extraction is what makes step 2
reviewable; decide at implementation time, keeping each landed unit
coherent.)

## Design rationale to preserve in header comments

- `agent-state.ts`: state = fold(events) from a seed; why the daemon and
  clients must share this exact code (two hand-rolled copies had already
  diverged in structure); where the prompt-visibility invariant now lives.
- `event-hub.ts`: the one-sentence responsibility (SPEC section) in the class
  docstring; why broadcast + fold + queue model are one object (the emit/fold
  atomicity and model/queue lockstep invariants need a single owner).
- `request-handlers.ts`: request semantics vs transport (sdk-server.ts)
  vs state (event-hub.ts); why the mutation chain exists.
- `tty-service.ts`: why TuiHost/TtyServer wiring is one unit; two-phase
  teardown rationale.
- `daemon.ts`: composition root — what it wires and deliberately does not
  contain.

## Review checkpoints

- After step 1: fold behavior equivalence (old assistant-state tests must
  pass against the new fold's `activity`).
- After step 3: manual smoke — attach a tui, verify footer
  model/mode/session display through init, set-model, plan-mode transition.
- After step 5: `rg TDC:` returns nothing; smoke spawn → attach → SIGTERM.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Resolve EventHub naming / internal decomposition (see IMPLEMENTATION IDEAS)
- [ ] Step 1: `agent-state.ts` + fold + tests; delete `assistant-state.ts`
- [ ] Step 2: daemon adopts AgentState; rename EventBus → EventHub, absorb queue model
- [ ] Step 3: tui adopts AgentState; footer `setState`
- [ ] Step 4: move `queue-model.ts` under `daemon/`
- [ ] Step 5: `request-handlers.ts`, `tty-service.ts`, composition-root daemon.ts; remove TDCs
- [ ] Step 6: documentation audit (overview.md, user-message-tracking.md, implementation-plan.md)

*Work log entries go here*
