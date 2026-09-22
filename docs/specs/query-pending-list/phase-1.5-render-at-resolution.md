# Phase 1.5: render at resolution

> Spec for phase 1.5 of docs/specs/query-pending-list.md. Status:
> **implemented 2026-09-20**; the main spec's Decisions "rebuild", Type
> Design "Phase 1" and Data Flow "Phase 1" reflect it.

## Problem

Phase 1 renders file-side content on arrival (`renderEvent`'s
`sessionEntry → appendEntry`) and rebuilds from the display path minus the
merge's unresolved ids. Two reviewer findings against that:

1. An entry the rebuild omitted (unresolved at rebuild time) is never
   re-delivered: `onResolved` can only replace an item, not insert one.
2. "Path minus unresolved" is not a prefix of the path under a relink: a
   boundary entry that is still pending has already reshaped the tree the
   path is read from.

Both come from one mismatch: the trees and the transcript consume entries
at _arrival_ while the merge places them at _resolution_.

## The rule

**The boundary between resolved and unresolved is where everything
changes.** An entry reaches the trees and the transcript only when the
merge resolves its id; a query message renders on arrival into a pending
part of the transcript and moves into the resolved part when its id
resolves. Resolution order is the one order every consumer follows.

### Definitions

- **Resolution order**: the order of `SessionState.resolved` across fold
  steps and within one (topological, stream-merge.ts). Among ids seen on
  `session` it is file order.
- **Entry queue** (`SessionModel.queuedEntries`): the session's
  uuid-bearing entries in file order that the trees do not hold yet — the
  file-side counterpart of the query-side `queryMessages`. Uuid-less
  entries never enter it (`SessionTreeBuilder.push` ignores them; the
  merge never names them).
- **Resolving an id on a session model**: if the queue head carries the
  id, it leaves the queue and joins the trees. If the id is deeper in the
  queue, the prefix through it leaves and joins the trees in file order,
  and the session model reports an anomaly through `onInvalid` —
  resolution order is file order among session ids, so this cannot happen
  without a merge anomaly (Anton, 2026-09-19: an `excluded-observed` needs
  a skipped expected id _and_ an unexpected one). An id that is not
  queued is query-only (`queryMessages`) or already in the trees
  (`byUuid`: a snapshot entry resolving after the cut); one that is none
  of these is unknown — the session model reports it through `onInvalid`
  (a debug banner; the TUI keeps running).
- **Keyed item**: a transcript item carrying the uuid it rendered under
  (`renderedUuids`' key). **Run of items**: every message has exactly one
  uuid and (assistant messages) one content block — the CLI emits one
  `assistant` frame/entry per block, verified 2026-09-20 on three
  parallel tool_uses — but the _transcript_ makes more than one item out
  of some messages, all tagged with that message's uuid: a tool_use
  assistant message yields an `AssistantItem` (`attachAssistant`, always)
  plus a top-level `ToolItem` (folded/expanded on its own; the tool
  result, own uuid, updates it via `toolItems` and adds no item), and a
  user message yields one item per `userTurnViews` view (text, command,
  output). So a uuid keys a contiguous run of one or more items — a
  property of the transcript's item layout, not of the streams.
  **Unkeyed**: banners, a stream still open (no uuid until finalized),
  the phase-1 dequeue echo.
- **Resolved part / pending part**: the transcript's two item lists,
  rendered in that order. Invariant: the pending part is empty or starts
  with a keyed item or an open stream's item.
- **Open stream's item**: the `AssistantItem` a `message_start` creates,
  unkeyed until its `assistant` frame. Conceptually it is keyed by the
  uuid of that frame, which nothing carries ahead of time (the
  `message_start` carries only the API `message.id`, shared by every
  block of the response; stream_event uuids appear nowhere in the file),
  so it is pending-only and blocks the prefix move as a workaround.
- "The trees hold resolved entries only" has one exception: the attach
  snapshot pushes its session-pending tail entries ahead of their
  resolution (`settled` rules out query-pending ids only; see
  `applySnapshot`). They are the file prefix, so the order is the same.

### Transcript rules

- `append(message)` (query side) appends to the pending part.
- `appendEntry(entry)` (file side) appends to the resolved part. It is
  called only by `resolve` and by the rebuild.
- An unkeyed item appends to the pending part iff that part is non-empty,
  else to the resolved part (a banner is conceptually query-side: it
  resolves as soon as nothing unresolved precedes it). Exception: an open
  stream's item always appends to the pending part.
- `resolve(uuid, entry)`: move the pending prefix through the last item
  keyed `uuid` (its run; see Definitions) and every unkeyed item after
  it, stopping at the next keyed item or open stream's item (no keyed
  item → nothing moves). Then, if `entry` is defined: an assistant item keyed `uuid`
  (`itemsByUuid`, wherever it sits) → `replaceContent(uuid, entry)`;
  else → `appendEntry(entry)`, whose render-once guard skips what the
  frame rendered while the entry's tool results still apply (the file's
  `toolUseResult` is not on the frame). User turns in phase 3.
- Rebuild: `resetTranscript()`, then the query session's `pathToLeaf()`
  entries via `appendEntry` — no filter, the trees hold resolved entries
  only — then its `queryMessages` and the `deliveredMessages` tail via
  `append`.

## Success criteria

- A user prompt's entry (session-only) pending at a `contextChanged`
  rebuild appears in the transcript when it resolves, at the end of the
  resolved part, before every pending query item.
- An assistant frame rendered live, then its entry resolving, yields one
  item, in the resolved part, re-rendered from the entry.
- A live "interrupted" banner while a stream is open stays after that
  stream's item after the stream's message resolves.
- The welcome line heads the transcript after a rebuild (resolved part).
- `/tree` after a rewind shows the tree over resolved entries; the
  relinked boundary is in it once its entry resolved.
- `renderHistory` reads no merge state.

## Type Design

```ts
// tui/session-model.ts
class SessionModel {
  readonly byUuid: Map<UUID, SessionEntry>;        // unchanged (retention, first-wins)
  /** undefined: pending on `query` in the seed state at attach, frame never seen here. */
  readonly queryMessages: Map<UUID, SDKMessage | undefined>;
  recordPending(uuid: UUID, message: SDKMessage | undefined): void;
  /** Uuid-bearing entries in file order not yet in the trees; an entry is
   *  flagged when a contextChanged followed it in the file stream — the
   *  rebuild belongs to that entry's resolution (the daemon emits the
   *  contextChanged after the entry that completed the boundary: the
   *  boundary, or the anchor a deferred boundary waited for). */
  private readonly queuedEntries: { entry: SessionEntry; contextChangedAfter: boolean }[];
  /** Retain (`byUuid`, attachment) and enqueue; the trees are untouched
   *  until the id resolves. */
  enqueueEntry(entry: SessionEntry): void;
  /** A contextChanged arrived: flag the queue's tail; true when nothing is
   *  queued (its entry resolved already — the rebuild is due now). */
  enqueueContextChange(): boolean;
  /** Retire `uuid` from the pending list; push the queue prefix through
   *  its entry into the trees (see "Resolving an id"); `entry` is what
   *  renders `uuid` (`entryFor`), undefined for a query-only id;
   *  `contextChanged` iff a pushed entry carried the flag. */
  resolve(uuid: UUID): { entry: SessionEntry | undefined; contextChanged: boolean };
  resetTrees(): void;                              // also clears `queuedEntries` (flags with it): the rescan re-emits every uuid
  entryFor(uuid: UUID): SessionEntry | undefined;  // unchanged: own entry, else the attachment under source_uuid
  get leaf(): TreeNodeRef | null;                  // unchanged: contextTree.leaf, now over resolved entries
  pathToLeaf(): TreeNodeRef[];                     // unchanged
  // retire() removed (folded into resolve)
}

// tui/session-models.ts
/** A step resolved `uuid` on `sessionId`, reported in resolution order
 *  after the session model pushed its entry; `entry` is what renders
 *  `uuid` (`entryFor`), undefined for a query-only id. */
type OnResolved = (sessionId: UUID, uuid: UUID, entry: SessionEntry | undefined) => void;
/** A contextChanged on `sessionId` resolved: the entry it followed is in
 *  the trees (or was already when it arrived). */
type OnContextChanged = (sessionId: UUID) => void;
class SessionModels {
  constructor(onInvalid: OnInvalid, onResolved: OnResolved, onContextChanged: OnContextChanged);
  /** The seed state's query-pending ids → recordPending(id, undefined) on
   *  their session models, so their resolution is not "never observed"
   *  (attaching mid-turn: stream events, a result, pending at the seed). */
  seedPending(state: AgentState): void;
  /** observe(event, state) does four things per event, in this order:
   *  (1) sdkMessageOf(event) → recordPending (store rule unchanged);
   *  (2) a sessionEntry → enqueueEntry on the session model of
   *      state.fileSessionId, a contextChanged → enqueueContextChange on
   *      it (true → onContextChanged now), a sessionFileChanged →
   *      resetTrees on its session model;
   *  (3) per session, per node of `resolved` in order:
   *      sessionModel.resolve(uuid) → onResolved(sessionId, uuid, entry),
   *      then onContextChanged(sessionId) if the resolution crossed a flag;
   *  (4) prune session models absent from state.sessions.
   *  (2) and (3) are one block, held until the snapshot; (1) and (4) run
   *  as the event arrives. ((1) and (2) never both apply to one event:
   *  the entry kinds and the message-carrying kinds are disjoint.) */
  observe(event: AgentEvent, state: AgentState): void;
  /** Snapshot entries, in order, → enqueueEntry + resolve on the session
   *  model of stateAtCut.fileSessionId: the snapshot is the file prefix,
   *  and file order is resolution order among session ids. (`settled`
   *  rules out query-pending ids, not session-pending ones: a tail entry
   *  whose echo has not arrived is pushed now, and its later resolution
   *  finds it retained, nothing queued.) Then every held event replays
   *  (3) — ids recorded before the cut must still retire — and post-cut
   *  events replay (2) too, in order with their own states; onResolved
   *  calls fire here, gated by the caller. */
  applySnapshot(entries, eventsBefore, stateAtCut): void;
}

// tui/transcript.ts
// TranscriptItem gains `uuid?: UUID`; `items` becomes `resolvedItems` and
// `pendingItems`; `rebuild` walks both in order. Every add site passes the
// key it renders under (a tool item: its tool_use frame's uuid).
resolve(uuid: UUID, entry: SessionEntry | undefined): void;   // Transcript rules
// append, appendEntry, addBanner, replaceContent: signatures unchanged;
// placement per Transcript rules.

// tui/interactive-mode.ts
// renderEvent: the `sessionEntry` and `contextChanged` cases render
// nothing (applyState keeps the tree-selector warning on the event).
// onResolved(sessionId, uuid, entry) → transcript.resolve(uuid, entry) and
// onContextChanged(sessionId) → rebuildTranscript(), both for the query
// session only, gated as today (attach buffering, scan window).
// renderHistory(): pathToLeaf() → appendEntry, no merge read; then
// queryMessages (defined values) and deliveredMessages → append.
// seedPending(seedState) right after the SessionModels construction.
```

## Data Flow

1. `sessionEntry` → `enqueueEntry` (retain + enqueue). The fold's `resolved`
   for the step → `resolve(uuid)` per id in order: the entry leaves the
   queue into the trees; `onResolved(sessionId, uuid, entry)` →
   `transcript.resolve(uuid, entry)` (the query session's only).
   Same-step resolution (session-only class): (2) and (3) of one
   `observe` call.
2. `sdkMessage`/`sessionAppended` → `transcript.append` (pending part) and
   `recordPending`; its resolution later moves the item into the resolved
   part and re-renders it from the entry.
3. Query-only id (stream events, results, `local_command_output`) →
   `onResolved(…, undefined)` → prefix move only.
4. `sessionFileChanged` → `resetTrees` (trees and queue restart; the
   rescan re-emits and re-resolves every entry, session-only under
   `scanExcluded` until it meets a query-reported id) and
   `resetTranscript()`; `scanComplete` → rebuild.
5. `contextChanged` → `enqueueContextChange` on the file session's model:
   the rebuild runs when the entry it followed resolves (`resolve` reports
   the crossed flag → `onContextChanged` → `rebuildTranscript`), or at
   once when nothing is queued. Rendering the path at that moment is what
   makes a relink show correctly: the trees hold the boundary (and its
   anchor) by then. The `onResolved` for the same id fires first and is
   subsumed by the rebuild.
6. Attach: the snapshot's entries are enqueued and resolved in order;
   every held event replays (3), post-cut ones (2) as well; `onResolved`
   during the replay is ignored (the rebuild that follows renders the
   path); then `renderHistory()`.

## Cost

- One entry queue per session model, bounded by the merge's session lag
  (normally the query-file flush window); one scan of it per resolution
  (the anomaly check needs the position, not just the head).
- One `uuid` per transcript item; a linear scan of the pending part per
  resolution (its length is the query lag). The move itself costs no
  container rebuild: the container is the concatenation of the two parts,
  which a move leaves unchanged — so a query-only resolution (every
  stream event resolves as one) is a scan and nothing else. Rendering an
  entry rebuilds the container once, as any append does today.
- The rebuild replays the whole path, as today.

## Edge cases

- Frame after resolution: cannot happen for a shared class (resolution
  needs the frame); a skipped frame never arrives.
- A stream still open when an earlier id resolves stays in the pending
  part and stops the prefix move there; a file-only entry resolving
  meanwhile (a steer's attachment) appends to the resolved part, i.e.
  above the stream — file order, the stream moves down.
- A frame the pending list never recorded (store rule: node lacks `query`)
  but rendered stays keyed at the pending head until a later resolution's
  prefix carries it — the prefix rule is deliberately "through the item",
  not "if at head".
- `resolve(uuid)` for an id neither queued, retained nor pending (a
  re-observed, already-forgotten id): `onInvalid` (debug banner), no
  entry, no item.
- A same-file rescan begins with `sessionFileChanged` (`TrackedSessionLog.open`
  emits it for rescans too): `resetTrees` clears trees and queue, and the
  rescan re-enqueues and re-resolves every entry in file order — nothing
  is ever pushed twice. The old query-pending ids it re-observes are in
  `queryMessages` and retire normally.

## Tests

- `session-model.test.ts`: `enqueueEntry` leaves the trees empty;
  `resolve` of the head pushes it and returns it; `resolve` of a deeper
  id pushes the prefix and reports through `onInvalid`; `resolve` of a
  pending id retires it and returns undefined; `resolve` of a retained,
  unqueued id returns the entry and pushes nothing; `resolve` of an
  unknown id reports through `onInvalid`; `resetTrees` clears the queue;
  `leaf` follows resolved entries only; `enqueueContextChange` on an
  empty queue returns true, on a non-empty one flags the tail and the
  resolution that pushes it reports `contextChanged`; a seeded id
  (`recordPending(id, undefined)`) resolves without a report.
- `session-models.test.ts`: `onResolved` carries the entry for a
  session-seen id and undefined for a query-only one, in resolution
  order; the snapshot's entries are in the trees; a held post-cut entry
  and its resolution replay after `applySnapshot` (its `onResolved` fires
  then, with the entry); a query-only id recorded and resolved before the
  cut is not pending after `applySnapshot`; a `sessionFileChanged` held
  pre-cut does not reset the snapshot's trees; a `contextChanged` after a
  pending entry fires `onContextChanged` at that entry's resolution, one
  after a resolved entry fires at once; `seedPending` makes the seed's
  query-pending ids resolve without `onInvalid`.
- `transcript.test.ts`: `append` then `resolve(uuid, entry)` → one item,
  resolved part, entry content; `resolve(uuid, entry)` with no item →
  appended to the resolved part before pending items; unkeyed banner
  placement (empty vs non-empty pending part); prefix move carries
  unkeyed followers and stops at the next keyed item; a tool item moves
  at its own frame's resolution, its result's resolution moves nothing
  new; the rebuild order (path, pending, delivered); an open stream stays
  pending when an earlier id resolves and a file-only entry appends above
  it; a banner after an open stream moves with the stream's resolution.

## Plan

Each step ends by updating this doc (and the main spec where its
sections are affected) and the WORK LOG before the next step begins.

1. `SessionModel`: `queuedEntries`, `enqueueEntry`, `resolve` (with the
   unknown-id `onInvalid`), `resetTrees` clears; `pushEntry` and `retire`
   removed; tests.
2. `SessionModels`: `OnResolved` with entry; (2)+(3) held as one block,
   `applySnapshot` replay rule; tests.
3. `TranscriptRenderer`: two parts, item uuids, `resolve`, unkeyed
   placement; tests.
4. `interactive-mode.ts`: `renderEvent` drop `sessionEntry`; `onResolved`
   → `transcript.resolve`; `renderHistory` without the merge read.
5. Presubmit; final pass over the main spec's sections.
6. Review round 4ca5e0f (Anton, 2026-09-20), one change per sub-step:
   (a) `SessionModel`: `contextChangedAfter` flag, `enqueueContextChange`,
   `resolve` returns `{entry, contextChanged}`; `SessionModels`:
   `OnContextChanged`; `interactive-mode`: rebuild on it; tests.
   (b) `TranscriptRenderer`: open stream pending-only, blocks the prefix
   move; tests. (c) `queryMessages` optional values, `seedPending`;
   tests. (d) Comments: run of items at `TranscriptItem.uuid`,
   `streaming.delete` early for multi-block responses. Presubmit; specs.

## IMPLEMENTATION IDEAS

- Anton's framing (2026-09-19): resolution order is _the_ order; the
  entry queue exists only so that the entry reaching the trees is looked
  up by position, not by state. Any design that consults `merge.nodes`
  reintroduces a second order and is wrong — including at the snapshot,
  which is the file prefix and so already in resolution order.
- `itemsByUuid` (discussed 2026-09-20, unchanged this phase): holds every
  assistant item since the last `conversation_reset`; after this phase
  its lookups (stream finalize, `resolve`) only touch the pending part,
  so it could be replaced by a scan of that part. Whether phase 3's
  attachment lookup by `source_uuid` needs a _resolved_ item depends on
  whether the CLI writes the attachment before or after the stream
  echoes the source — derisk there.
- Post-implementation review findings (2026-09-20), decided in round
  4ca5e0f:
  - A relinking boundary resolving after its `contextChanged`: the daemon
    emits the `contextChanged` right after the entry that completed the
    boundary (the boundary itself, or the anchor a deferred boundary
    waited for — session-tracker.ts `push`). Rendering at arrival rebuilt
    from trees that lacked that entry when its echo lagged; the later
    resolution only appended the banner. Decision (Anton): the rebuild
    runs when the contextChanged _resolves_ — with the entry it followed
    (`contextChangedAfter` flag; Type Design, Data Flow 5).
  - An open stream rode into the resolved part, so a file-only entry
    resolving meanwhile landed after it (time order). Decision (Anton):
    the stream is conceptually keyed by its final frame's uuid, which
    nothing carries ahead of time (see Definitions, "Open stream's
    item"), so it is pending-only and blocks the prefix move — file order.
    A `message_start`-uuid key was considered: it is the merge's own id,
    but a query-only id resolves as soon as its predecessor settles, so it
    would not change the ordering.
  - False "resolved but never observed" for ids query-pending in the seed
    state. Decision (Anton): seed the session models (`seedPending`,
    `queryMessages` values optional).
- Multi-block responses (deferred 2026-09-20, fixed 2026-09-22): the CLI
  emits one `assistant` message per content block, interleaved with the
  partials (`content_block_start i` … `assistant` … `content_block_stop
  i`), and `message_stop` is the response's real end; `streaming.delete`
  on the first of them lost the later blocks' partials. Now a stream lives
  until `message_stop`; each `assistant` message for its API id — from
  either side, once per uuid (`StreamingComponent.finalizedUuids`) —
  removes partial block _n_ (_n_ = messages seen so far; a message carries
  no block index) via `withoutBlock` and renders as its own item inserted
  ahead of the stream's item (`insertItem`; nested:
  `ToolExecutionComponent.addSubagentChildBefore`). The per-block
  ordering is asserted LIVE in tests/sdk/stream-classification.test.ts.
  Consequence for the two-part invariant: dropping a stream's item that
  headed the pending part releases the banners behind it
  (`discardStream` → `resolvePrefix(0)`).
- Command output attachment (review 2026-09-20): `attachCommandOutput`
  attaches to the last item overall (pending's last, else resolved's),
  because before phase 3 the command block is the unkeyed dequeue echo —
  in either part — and the output is its entry. An entry carrying both a
  slash command and its stdout (`system/local_command` with both views)
  therefore attaches its output to a pending command block, or renders
  it standalone, when the pending part is non-empty at its resolution.
  Phase 3 keys the echo, so the output can attach by uuid; leave until
  then.
- Items per uuid (Anton, 2026-09-19; refined 2026-09-20): a tool call
  and its result are separate frames/entries with separate uuids; the
  tool item is keyed by the call's uuid and paired with its result by
  tool_use_id. A uuid keys one _run_ of items, not one item: the
  transcript makes a top-level item per tool_use block and per user
  view, so `resolve` moves through the last item of the run.

# WORK LOG

- [x] Anton reviews this spec (2026-09-20, committed with review round
      87f60fc addressed)
- [x] Step 1 (2026-09-20): `SessionModel.queuedEntries`, `enqueueEntry`,
      `resolve`; `pushEntry`/`retire` removed. The anomaly check scans the
      queue for the id (Cost updated). Unknown-id report text: "`<uuid>`
      resolved but never observed".
- [x] Step 2 (2026-09-20): `SessionModels` holds every event with its
      state until the snapshot (`HeldEvent.event: AgentEvent`);
      `applyEntry(event, state)` then `applyResolutions(state)` is the
      held block; a replay runs `applyEntry` only past the cut.
      Test-order note: the
      harness feeds `scanComplete` after a rescan's entries, as the daemon
      does — before it, they would expect an echo and stay pending.
- [x] Step 3 (2026-09-20): `TranscriptRenderer.resolvedItems` /
      `pendingItems`, `ItemKey.uuid` on every item, `resolve(uuid, entry)`,
      `partFor` placement of unkeyed items; `append`/`appendEntry` share
      `appendMessage(message, part)`. Deviation from the draft rule: a
      uuid keys a run of items, so the prefix moves through the _last_
      item keyed `uuid` (Transcript rules updated). `resolve` branches on
      `itemsByUuid.has(uuid)` — `replaceContent` for an assistant item
      keyed `uuid`, `appendEntry` otherwise — not on whether the move
      found an item: a stream's item rides an earlier resolution into the
      resolved part unkeyed and is keyed there by its frame, so its own
      resolution moves nothing yet must re-render it. Not on
      `renderedUuids` either: a user frame that rendered text is in that
      set, but its entry's tool results still need `appendEntry`. The
      move alone does not rebuild the container. Dropped: `appendEntry`'s
      `cwd`/timestamp bookkeeping for an assistant entry whose frame
      rendered (the frame's arrival time stays the thinking clock; live
      `cwd` comes from `setCwd`). Tests: 6 new in transcript.test.ts.
- [x] Step 4 (2026-09-20): `interactive-mode.ts` — `renderEvent` no longer
      renders `sessionEntry`; `onResolved(sessionId, uuid, entry)` calls
      `transcript.resolve` for the query session only, under the existing
      replay/scan gate; `renderHistory` appends the whole `pathToLeaf()`
      (no merge read). `replaceContent` stays public: its unit test calls
      it directly.
- [x] Step 5 (2026-09-20): presubmit green (705 tests; one flaky run of
      the generated `streaming/driver.test.ts` timing test, unrelated).
      Main spec updated: Decisions "rebuild", Type Design "Phase 1"
      (`SessionModel`/`SessionModels`/`OnResolved`, interactive-mode and
      transcript bullets), Data Flow "Phase 1" steps 1/5/6 and "Phase 3"
      step 4, WORK LOG.
- [x] Anton's review round b1b7f7d (2026-09-20): `applyToTrees` split
      into `applyEntry`/`applyResolutions`; `renderCompactSummary(content,
uuid, part)`; `appendEntry` names its part once; `resolve` replaces
      or appends, not both (step 3 entry updated).
- [x] Post-implementation review (2026-09-20, reviewer 2149ed67):
      `resolve` branches on `itemsByUuid` — `renderedUuids` skipped the
      entry's tool results for a user frame that rendered text (test
      added); `resolve` no longer rebuilds for the move (Cost updated);
      `itemsByUuid` TODO corrected (a stream's item can be looked up in
      the resolved part); snapshot exception stated in Definitions. Three
      design findings left OPEN in IMPLEMENTATION IDEAS for Anton.
- [x] Anton's review round 4ca5e0f (2026-09-20): decisions recorded
      (IMPLEMENTATION IDEAS), Definitions rewritten around "run of
      items", Type Design/Data Flow/Tests/Plan step 6 updated.
- [x] Step 6a (2026-09-20): `QueuedEntry.contextChangedAfter`,
      `enqueueContextChange`, `Resolution` return type; `OnContextChanged`
      third constructor arg, `applyEntry` handles `contextChanged`,
      `applyResolutions` reports it after `onResolved`; interactive-mode
      `onContextChanged` → `rebuildTranscript` under the `onResolved`
      gate, `renderEvent` `contextChanged` renders nothing. Tests: 2 in
      session-model.test.ts, 2 in session-models.test.ts.
- [x] Step 6b (2026-09-20): `isOpenStream` (unkeyed assistant item);
      `partFor` sends it to the pending part, `resolve`'s follower loop
      stops at it; file comment, `ItemKey.uuid` run-of-items comment,
      `itemsByUuid` TODO, DEFERRED comment at the stream ownership check.
      Tests: the "rides into the resolved part" test replaced by two.
- [x] Step 6c (2026-09-20): `queryMessages: Map<UUID, SDKMessage |
    undefined>`, `recordPending` optional message,
      `SessionModels.seedPending(state)` (uses `pending(session.merge,
    "query")`), called right after construction in interactive-mode;
      `renderHistory` skips undefined values. Tests: 1 in
      session-model.test.ts, 1 in session-models.test.ts (a seeded
      stream_event id resolving query-only).
- [x] Step 6d (2026-09-20): comments landed with 6b; main spec updated
      (Type Design Phase 1, interactive-mode bullet, Data Flow 4,
      Decisions `queryMessages` invariant, Non-goals contextChanged
      clause). Presubmit: see below.
- [x] Presubmit after step 6 green (713 tests, 2026-09-20). Awaiting
      Anton's review/commit.
- [x] Anton's field test (2026-09-20, /tmp/events_4de): "resolved but
      never observed" for every `stream_event` with nothing query-pending
      ahead of it — such an id resolves in the step that observes it, the
      merge forgets it, and the store rule (`merge.nodes` only) skipped
      it. Store rule now also reads the step's `resolved` record
      (`Resolved.seenOn`), so the id is recorded and retired within the
      step; main spec Decisions/Type Design/Data Flow/Edge cases updated.
      Test: "a query-only frame with nothing pending ahead resolves in
      its own step as a known id".
- [x] Multi-block streaming fix (2026-09-22; IMPLEMENTATION IDEAS):
      `withoutBlock` (sdk-render.ts), `StreamingComponent.finalizedUuids`,
      `insertItem`/`resolvePrefix`, `message_stop` → `discardStream`,
      `addSubagentChildBefore`. transcript.test.ts: streaming test
      extended, 3 new (two-block, entry-first, message_stop releases
      banners), 2 resolve tests gain the `message_stop`, the
      "entry outrunning its open stream" test folded into the entry-first
      one. LIVE: stream-classification suite 7/7 with the new ordering
      assertion.
