# Phase 4: `observeEvent` — protocol.ts as the source of truth for the merge

> Follow-up to phase 3.5 (docs/specs/query-pending-list/phase-3.5-uuid-less-events.md),
> from Anton's review round (commit 83641a3, `// TDC:` comments in
> agent-state.ts `foldEvent`, observe-on.ts `observeOn`, protocol.ts
> `eventUuid`). Status: **implemented and committed 2026-09-22** (reviews
> a7a11df0 and 16099e0 addressed; the `expectsSdkMessage` rename is in
> docs/thoughts/session-tracker-follow-ups.md).

## Problem

docs/protocol.md and protocol.ts promise that every event is a node of
exactly one stream (`eventUuid`, `eventStream`). Nothing enforces it: the
fold's per-kind helpers under src/core/agent-state/ each hand `observeOn`
their own stream literal, uuid expression, class name, session choice and
exclusion flag. `eventStream` is consulted by the TUI alone. The two
protocol functions can drift from what the fold does, silently.

The fold should be unable to observe an event anywhere but on
`eventStream(event)` under `eventNodes(event)`, in the session the
protocol implies, with the exclusion the classification table gives — one
function does all of that, and the helpers cannot bypass it.

## Success criteria

1. The merge is touched only inside the barrel
   `src/core/agent-state/observe-event/`, whose `index.ts` exports
   `observeEvent` (the one observation of an event), `observedSessions`,
   and the two non-event observations as named operations,
   `rescanSession` and `excludeResetPrompt`. The primitives
   `observeOn`/`excludeOn` are barrel-private; eslint enforces the
   boundary (docs/thoughts/barrel-boundary-eslint-generator-spec.md
   semantics, written by hand until the generator exists).
2. Stream, nodes and class of an observation come from protocol.ts
   (`eventStream`, `eventNodes`, `eventClass`); the session from
   `observedSessions`; the exclusion from `excludedFromOther` in
   classification.ts. No fold helper names a `MergeStream` literal for an
   event.
3. A `SessionState` is created by the two start events only
   (`querySessionChanged`, `sessionFileChanged`); every other kind on a
   missing session is a `merge-error` anomaly and is not observed. No
   `?? freshSessionState()` fallback remains outside the start folds.
4. The TUI's pending-list bookkeeping (`SessionModels.recordObserved`)
   derives sessions and nodes from `observedSessions` and `eventNodes`;
   it holds no copy of the session-selection rule.
5. A table-driven test folds one well-formed event of every kind
   (`Record<AgentEvent["kind"], …>`, so a new kind fails to compile until
   covered) and asserts its `eventUuid` was observed on `eventStream` in
   every `observedSessions` session.
6. The three `// TDC:` comments are gone; suite green; the phase 3.5 LIVE
   sdk tests unaffected (no protocol wire change).

## Examples

- `sessionEntry` whose entry is a `queued_command` attachment with
  `source_uuid = S`: `eventNodes` = `[S, entry.uuid]`; both observed on
  `session` of `fileSessionId`, in that order. `entry.uuid` is excluded
  from `query` (an `attachment` entry is `excludedFromQuery`, so the
  tracker publishes `expectsSdkMessage: false`) but resolves only behind
  `S`, its `session` predecessor; `S` excluded from `query` iff no queued
  message still awaits its dequeue under `S` (first observation only).
- `sdkMessage` whose `message.session_id ≠ querySessionId`: anomaly
  `merge-error: assistant <uuid> on query: session <id> not announced`;
  no observation, state otherwise unchanged.
- `userMessageDequeued` before any `querySessionChanged` (impossible from
  the daemon, possible from a hand-built stream): anomaly
  `merge-error: prompt <runKey> on query: no session`; the queue is
  still drained.
- `shutdown`: observed on `query` of every session in `state.sessions`,
  excluded from `session`; an empty `sessions` is not an anomaly.
- `trackerAnomaly` whose own observation raises a head-mismatch: the
  fold's `anomaly` names both (`withAnomalies` accumulates).

## Type Design

### protocol.ts

```ts
export function eventStream(event: AgentEvent): MergeStream; // unchanged

/** The event's merge nodes in stream order, `eventUuid` last; a
 *  `queued_command` attachment entry first observes the steered prompt's
 *  `source_uuid` (the dequeue's `query` node it meets). */
export function eventNodes(event: AgentEvent): readonly [UUID, ...UUID[]];

/** The event's identity: the last of `eventNodes(event)`. */
export function eventUuid(event: AgentEvent): UUID;

/** For anomaly details: `classOf` of the SDK message or entry the event
 *  carries, `"prompt"` for a dequeue, the kind otherwise. */
export function eventClass(event: AgentEvent): string;
```

`eventNodes` imports `queuedCommandSourceUuid` from session/file.ts;
`eventClass` imports `classOf` from agent-state (already an import
source of protocol.ts). Exhaustive switches, no default arm.

### src/core/agent-state/classification.ts

`isSubagentTraffic` moves here from fold-query-message.ts (it is a
classification). New:

```ts
/** The classification table's answer for a FIRST observation of `node`
 *  of `event` on `eventStream(event)`: does the other stream never carry
 *  it? (`observeEvent` asks only when the node does not exist yet.) */
export function excludedFromOther(
  event: AgentEvent,
  node: UUID,
  state: AgentState,
  session: SessionState,
): boolean;
```

| kind                                                                                                                  | excluded from the other stream                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| userMessageQueued, compactSent, interruptSent, controlApplied, scanComplete, contextChanged, trackerAnomaly, shutdown | true                                                                                     |
| userMessageDequeued, querySessionChanged, sessionAppended                                                             | false                                                                                    |
| sessionFileChanged                                                                                                    | `event.uuid !== undefined` (a rescan's own node)                                         |
| sdkMessage                                                                                                            | `message.uuid === undefined ∨ isSubagentTraffic(message) ∨ excludedFromSession(message)` |
| sessionEntry, node = stamp (entry has no uuid)                                                                        | true                                                                                     |
| sessionEntry, node = `entry.uuid`                                                                                     | `¬awaitsDequeue(node) ∧ (¬event.expectsSdkMessage ∨ session.scanExcluded)`               |
| sessionEntry, node = attachment `source_uuid`                                                                         | `¬awaitsDequeue(node)`                                                                   |

`awaitsDequeue(node)` = `state.queuedMessages.some(m => m.uuid === node)`.

### src/core/agent-state/observe-event/ (new barrel)

Files: `index.ts` (the barrel; re-exports only what is listed below),
`observe-event.ts` (`observeEvent`, `observedSessions`), `observe-on.ts`
(moved from the parent directory: `Observation`, `observeOn`,
`excludeOn`, `applyMergeStep`), `rescan-session.ts`,
`exclude-reset-prompt.ts`. The barrel imports classification.ts,
session-state.ts and tracker-anomaly.ts from the parent directory;
nothing in the parent directory imports a barrel file other than
`index.ts`.

```ts
// index.ts
export { observeEvent, observedSessions } from "./observe-event.ts";
export { rescanSession } from "./rescan-session.ts";
export { excludeResetPrompt } from "./exclude-reset-prompt.ts";
export type { Observation } from "./observe-on.ts";

// rescan-session.ts — the replay from fold-session-file-changed.ts
/** The tracked file's session rebuilt for a same-file rescan: fresh
 *  merge, the old session's pending query ids re-observed on `query`
 *  with their `session` exclusions, `pendingLeaf` and usage/model
 *  evidence kept; everything the log told us forgotten. */
export function rescanSession(old: SessionState): Observation;

// exclude-reset-prompt.ts — the rule from fold-sdk-message.ts
/** `conversation_reset`: the last pending query observation not already
 *  excluded from `session` — the reset command's prompt, filed under the
 *  next session — is excluded from this file's `session`. Identity when
 *  nothing is pending. */
export function excludeResetPrompt(session: SessionState): Observation;
```

eslint.config.js gains two `no-restricted-imports` entries mirroring the
generator's boundary semantics: for all files, the pattern
`**/agent-state/observe-event/*` except `**/agent-state/observe-event/index.ts`
("import the barrel"); for `files: ["src/core/agent-state/observe-event/**"]`,
the pattern `**/observe-event/index.ts` ("inside the barrel, import
siblings"). The existing `**/agent-state/*` rule is unchanged (it also
matches the nested path; a deep import gets both messages).

```ts
// observe-event.ts
/** The sessions the event is observed on: both start events their own
 *  `sessionId`, `shutdown` every session, otherwise the session of
 *  `eventStream(event)` (`querySessionId` / `fileSessionId`) — empty
 *  while that is undefined. */
export function observedSessions(
  state: AgentState,
  event: AgentEvent,
): readonly UUID[];

/** The one merge call site for events: every node of `eventNodes(event)`
 *  observed on `eventStream(event)` in every `observedSessions` session,
 *  a first observation excluded from the other stream per
 *  `excludedFromOther`. Anomalies (`merge-error`, no observation): no
 *  session for the stream; a session id in `observedSessions` without a
 *  `SessionState`; an `sdkMessage` whose `session_id` is not
 *  `querySessionId`. */
export function observeEvent(state: AgentState, event: AgentEvent): AgentState;
```

Calls: `eventStream`, `eventNodes`, `eventClass` (protocol.ts),
`observedSessions`, `excludedFromOther` (classification.ts), `observeOn`
(barrel-private), `withSession`, `withAnomalies`. agent-state.ts
re-exports `observedSessions` for the TUI; the folds import the barrel.

`observeOn` and `excludeOn` keep their signatures; the TDC comment is
removed.

### tracker-anomaly.ts

```ts
/** At most one anomaly per fold: accumulates onto `state.anomaly` (this
 *  fold's earlier anomalies — `clearedForFold` runs first), kind by
 *  precedence over all, details joined. */
export function withAnomalies(
  state: AgentState,
  anomalies: readonly TrackerAnomaly[],
): AgentState;
```

Needed because `observeEvent` returns an `AgentState` (its anomalies are
already folded in) and a helper may add more in the same step
(`trackerAnomaly`'s own, the reset exclusion's). Today the second call
overwrites the first.

### Folds

`foldEvent` is `observeEvent`'s only caller (eslint: `importNames:
["observeEvent"]` restricted for every agent-state sibling but
agent-state.ts). A kind's own effects are `with<Effect>(state, event)`
helpers applied before the observation and `fold<Kind>(state, event)`
helpers applied after it:

- Deleted: fold-stamped.ts, fold-shutdown.ts, fold-session-appended.ts
  (`sessionAppended` is a pure observation; the daemon stamps
  `message.uuid`, `eventNodes` relies on it). `trackerAnomaly` is
  `withAnomalies(observeEvent(state, event), [event.anomaly])`.
- Before: `withQueuedMessage` (was foldUserMessageQueued),
  `withQueueDrained` (drains `queuedMessages`, sets `pendingLeaf` for a
  turn/append on the query session when it exists; no session creation),
  `withQuerySessionAnnounced` / `withTrackedFile` (create the
  `SessionState` when absent, set `querySessionId`/`fileSessionId`; the
  rescan branch stores `rescanSession(trackedSession)`), `withScanEnded`
  (was foldScanComplete), `withControlApplied`, `withScanExclusionEnded`
  (fold-session-entry.ts: clears `scanExcluded` when the entry's uuid
  already exists on `query` — `excludedFromOther` reads it),
  `withPendingLeaf` (query-message.ts: a leaf-eligible top-level message
  on the announced session; the observation may resolve that node and
  clear it again).
- After: `foldSessionEntry` (`treeLeaf`/`awaitingAnchors`, the
  settled-gated evidence), `foldSdkMessage` (`withQueryEvidence` —
  usage/model/post-tokens on the announced session, query-message.ts —
  then activity, settings, the reset branch's `excludeResetPrompt`). A
  message whose `session_id` is not `querySessionId` changes nothing but
  `observeEvent`'s anomaly (`announcedSession` is undefined for it).

### TUI — src/tui/session-models.ts

`recordObserved(event, state)`: skip a `sessionEntry` whose entry has a
uuid (its nodes are `queuedEntries` business); otherwise for every
session of `observedSessions(state, event)` and every node of
`eventNodes(event)`, `recordIfObserved(sessionId, node, frame, state,
eventStream(event))` where `frame` is the SDK message for an
`sdkMessage`/`sessionAppended` with a payload uuid, else undefined.
`recordDequeued` unchanged.

## Data Flow

Per event, daemon and subscriber alike: `nextAgentState` →
`clearedForFold` → `foldEvent` switch → the kind's side effects →
`observeEvent(state, event)` → protocol.ts answers stream/nodes/class,
`observedSessions` the sessions, `excludedFromOther` the exclusion of each
node not yet in the merge → `observeOn` per (session, node) →
`withSession` + `withAnomalies` → the kind's post-observation effects.
The TUI reads the same three protocol/state functions to place the
event's nodes in pending lists.

## Cost

Compute only: three exhaustive switches over `kind` per event plus one
`observedSessions` lookup; `eventNodes` allocates a one- or two-element
array per event. No new state; `shutdown` still touches every session.

## Edge cases

- `sessionAppended` carries `message.session_id` too; it is not checked
  against `querySessionId` (the daemon writes the query file itself).
  Its `message.uuid` is the daemon's stamp and always present;
  `eventNodes` casts rather than checks, as `eventUuid` does today.
- `trackerAnomaly`'s own anomaly is no longer copied verbatim into
  `state.anomaly`: it goes through `withAnomalies`, so its detail gains
  the `kind:` prefix like every other anomaly (AnomalyRecorder and the
  TUI render `detail` as opaque text).
- The rescan branch of `foldSessionFileChanged` stores `rescanSession(old)`
  with `withSession` before `observeEvent` observes the rescan node.
- The agent-state barrel itself stays `agent-state.ts` (its move to
  `index.ts` belongs to the generator change).
- A `sessionFileChanged` start whose session already exists (announced by
  `querySessionChanged`, the normal case) does not recreate it; a start
  arriving first creates it, as today.
- `withoutFile` still drops the old file's session at a switch;
  `observedSessions` for `shutdown` sees only live sessions.
- `sessionSettled`, `settled`, the selectors, the merge primitives and
  the wire format are untouched.

## Non-goals

No protocol change (event shapes, uuids, stamping); no change to what the
TUI renders; no change to the rescan replay or the reset exclusion rules.

# IMPLEMENTATION IDEAS

- Order: protocol.ts (`eventNodes`, `eventClass`) → classification.ts →
  the observe-event barrel (move observe-on.ts, add the four files,
  eslint entries) → folds one file at a time, suite green after each →
  delete fold-stamped/fold-shutdown → `withAnomalies` accumulation → TUI
  → table-driven kind test → docs/protocol.md sentence → TDC removal.
- Existing anomaly-detail assertions in agent-state.test.ts and
  tail/prompt tests will change wording where `eventClass` differs from
  the hand-written class (dequeue "prompt" is kept; stamped kinds keep
  the kind).
- The table-driven test's per-kind fixtures need an announced and
  followed session (`querySessionChanged` + `sessionFileChanged`), and a
  queued message for the dequeue fixture.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- 2026-09-22 — derisk with Anton: (1) only start events create a
  SessionState, others anomaly; (2) `eventNodes` as a protocol fact;
  (3) helpers call `observeEvent` at their own point (no pre/post split
  in `foldEvent`) — reversed in review round 2, see below; (4)
  `excludedFromOther` lives in classification.ts. Spec written.
- 2026-09-22 — review (f162b5c): the observation code becomes a barrel
  `agent-state/observe-event/` (index.ts) exposing `observeEvent`,
  `observedSessions`, `rescanSession`, `excludeResetPrompt`; the
  primitives are private; eslint entries by hand until the generator.
  The agent-state barrel stays `agent-state.ts`. TDC answered: a
  `queued_command` attachment's own uuid is excluded from `query`.
- [x] Implement per the order above.
- 2026-09-22 — implemented. Findings:
  - The existing `**/agent-state/*` eslint pattern DOES match the nested
    barrel path (gitignore semantics; probed): an outsider deep-importing
    `observe-event/observe-event.ts` gets both messages. Harmless; the
    Type Design note that `*` does not match the nested path was wrong.
    The barrel-internal rule uses `["./index.ts", "**/observe-event/index.ts"]`
    (the sibling-relative specifier is what a sibling would write).
  - `observeEvent` checks the `sdkMessage` "not announced" condition
    before "no session" so a message before any `querySessionChanged`
    keeps the more specific detail (existing test).
  - src/tui/session-models.test.ts fed a same-file rescan WITHOUT a uuid;
    the old fold masked it by hardcoding the rescan node's exclusion, the
    table derives it from `event.uuid`. Fixture given a uuid, as the
    protocol requires.
  - `trackerAnomaly` test expectation updated for the `kind:` prefix.
  - Not done here: the phase-3.5 LIVE sdk tests were not rerun (no wire
    change; unit suite covers the fold).
- 2026-09-22 — review (a7a11df0). Fixed: `foldQueryMessage` applied
  leaf/usage/model to a retained session whose id was not
  `querySessionId` although `observeEvent` reported it (Examples: "state
  otherwise unchanged"); side effects now gated on
  `sessionId === querySessionId`, regression test added. The
  `sessionEntry` arm of `excludedFromOther` tested the entry's uuid before
  the `source_uuid` node, so a uuid-less attachment would have excluded
  its source unconditionally; the `source_uuid` arm is now checked first,
  matching the table. Prose: the barrel comment no longer claims more than
  the lint enforces (a helper could still import `observe` from
  stream-merge.ts directly — not enforced, proposed to Anton); the TUI
  header routes a query message via `querySessionId`. The table-driven
  test asserts each fixture's `kind` matches its key at runtime (the
  helpers return the wide `AgentEvent`, so a mapped fixture type would
  need casts).
- 2026-09-22 — Anton's review (16099e0). Decision (3) reversed:
  `observeEvent` is hoisted into `foldEvent` for every kind and eslint
  restricts its import to agent-state.ts; the helpers split into
  before-observation `with<Effect>` and after-observation `fold<Kind>`
  (Type Design, Folds). The split was clean everywhere: the two
  genuinely order-dependent effects are `scanExcluded` clearing
  (`excludedFromOther` reads it) and `pendingLeaf` setting (the
  observation may resolve and clear it). Naming audit over the fold
  helpers, observe-on.ts, rescan-session.ts and the new tests (`before`,
  `observed`, `withLeaf`, `old`, `next`, `dropped`, `drained`, `base`…
  → role names). The `!Object.hasOwn` guard in `observeEvent` stays: the
  table is a first-observation predicate and a prompt entry or steer
  `source_uuid` after its dequeue legitimately has exists ∧ table=true
  (the merge does not record that a `query` node came from a dequeue).
  `expectsSdkMessage` is literally named (the SDK emits no message for a
  prompt; its `query` node is the dequeue) — renaming it to
  `expectsQueryMessage` with "excluded from query" semantics would move
  the dequeue knowledge into the tracker; deferred.
