# Spec: the query pending list — prompts with identity, and rebuilding a transcript from the local model

> Status: **SPEC APPROVED 2026-09-16** (type design + data flow); design
> revised 2026-09-18 after reviewer pass 3 (full entries on the wire,
> per-session models, resolution-driven retirement); not yet implemented.
> Follow-up to docs/specs/session-tracker.md (phase 4 introduced the
> rebuild on live `contextChanged`) and
> docs/thoughts/delivered-prompt-identity.md. SDK ground truth this rests
> on: docs/claude-agent-sdk.md "Queued prompts coalesce by run", pinned by
> `tests/sdk/queued-batches.test.ts`.

# SPEC

## Problem

Two related defects, one root.

1. **"history attach point not found" after a CLI compaction.** The TUI
   rebuilds its transcript on a live `contextChanged` by replaying the
   root-to-leaf path cut at `leaf(agentState)`. While the query stream
   leads the file, that leaf is a `pendingLeaf` uuid whose entry the TUI's
   `SessionModel` does not hold yet, so `pathUpToBoundary` finds no cut,
   replays everything and warns. Confirmed by offline replay of a captured
   event stream (WORK LOG, diagnosis): at the `contextChanged` for the
   boundary the state leaf was the `<local-command-stdout>` message emitted
   on the query stream 4 events earlier and landing in the file 3 events
   later. Attach is immune only because `get-entries` gates on settledness.

2. **Delivered prompts have no identity.** `deliveredMessages` holds
   turn/append prompts dequeued by the queue model until _any_ later
   uuid-carrying `sdkMessage` arrives, then clears wholesale (positional
   confirmation, docs/user-message-tracking.md). It never says which entry
   is the prompt's, and a transcript rebuilt from the local model in the
   window between the clear and the entry's arrival at the client loses
   the prompt.

A third defect surfaced while derisking: `queue-model.ts` drains a whole
priority bucket as one dequeue, but the CLI dequeues one _run_ at a time
(an append never merges with its neighbours), so a bucket like
`[Q, Q, A, Q]` is announced as one turn where the file records three
entries over three `result`s.

## The rule

> A client rebuilding a view from its local model cuts at its local
> model's leaf and re-applies what it holds beyond it. The state leaf is a
> valid cut only against a settled snapshot.

The transcript rendered so far is exactly **the path to the session
model's leaf, followed by the query pending list** — the `user`/`assistant`
messages observed on `query` whose ids the merge has not resolved, in
observation order (a resolved id has been seen on both streams, or
excluded from one; an unresolved id may also be waiting on an unresolved
predecessor). Since the query stream leads the file, everything pending is
after the file leaf.
Nothing is deferred; the rebuild is immediate and shows everything the
model holds (what it does not hold — the accepted losses under Decisions
— no rebuild can show).

For this to be complete, everything a client renders live must be in one
of the two: entries (the path) or the pending list. Prompts therefore
join the query stream **with identity** at dequeue (their stamped uuid),
so a prompt is pending until its own entry lands instead of being cleared
positionally.

> **`userMessageDequeued` is a user message on the query stream.** The CLI
> echoes on the query stream every message it consumes except the prompts
> it dequeues; the daemon's dequeue event is that missing echo. Every
> consumer — the daemon fold, `SessionModel`, `settled()`, the transcript
> — treats a dequeued prompt exactly as it would a `user` sdkMessage with
> the same uuid: observed on `query`, pending until its entry, the
> `pendingLeaf`. Nothing about a prompt is "delivered" or "confirmed"
> positionally.

This statement is repeated where a future reader meets the event:
`protocol.ts` (`userMessageDequeued` doc comment), the
`agent-state/agent-state.ts` header, and the `SessionModel` class doc.

Three principles make the rule cheap to keep:

> **The entry is canonical; the query message is provisional.** The wire
> carries every entry complete, so whichever side a client saw first, the
> entry is what a re-attach shows and what a live view converges to.

> **The merge is the only source of "pending" and "resolved".** A client
> stores the query messages the fold observes and drops each one when the
> fold reports its id resolved (`SessionState.resolved`). No client
> re-derives pendingness from classification or arrival order.

> **A session model is one session.** Clients hold one `SessionModel` per
> id in `AgentState.sessions`, created and dropped as the fold creates and
> drops `SessionState`s; no model names another session. Only the
> renderer combines sessions (the file session's path and pending list,
> then the query session's pending list during a rollover).

## Success criteria

- The transcript is a function of the session models: a rebuild (attach,
  `contextChanged`, `scanComplete`) renders the file session's path and
  pending list and nothing else, and the rebuilt transcript equals the
  transcript rendered live up to that point (modulo an in-progress
  streaming assistant message, which re-renders when its `assistant`
  message arrives — the existing attach behaviour — the transient banners
  and nested subagent output listed under Decisions). No "history attach
  point not found" warning exists.
- Every id renders once, from whichever stream shows it first; a user
  turn or assistant message re-renders in place from its entry when its
  id resolves. Live and re-attached transcripts agree once the file has
  caught up (slash-command rewrites and assistant `stop_reason` included).
- Every accepted prompt is in exactly one of: **queued** (pending area),
  **pending on query** (transcript, unconfirmed), or **tree** (transcript,
  at/before the leaf), except a prompt dequeued before the first `init`
  (Edge cases). Transitions are one fold step each. This restates the
  prompt-visibility invariant of docs/user-message-tracking.md;
  `deliveredMessages` is replaced by the pending list. (A plain interrupt
  drops nothing — sdk.d.ts `SDKControlInterruptResponse`: queued prompts
  and an already-dequeued batch "WILL run" — so there is no dropped
  state.)
- The queue model announces dequeues one run at a time, matching the
  file: `[Q, Q, A, Q]` in one bucket → `turn [1,2]`, `append [3]`,
  `turn [4]` over three `result`s.
- Merged runs behave in `AgentState` and the TUI exactly as the session
  file records them: one message under the run's last uuid, joined the
  way the CLI joins. Live and replayed views of a merged run agree.
- `settled()` waits for a dequeued prompt's entry like any other pending
  query observation (`wait --until` semantics unchanged: "the file has
  caught up with the query").
- The type/structure guarantee: no TUI code can compute a path for a
  `TreeNodeRef` that is not a node of the local model — the path is
  computed by the model itself (`SessionModel.pathToLeaf()`), not from a
  caller-supplied ref.
- `src/core/agent-state.ts` becomes the directory
  `src/core/agent-state/` whose `agent-state.ts` is the only file imported
  from outside it, enforced by lint.

## Decisions

- Rebuild model: path to the file session's leaf, then the pending list.
  No deferral. (Anton: "exactly the right approach".)
- The rule and the three principles are recorded in `SessionModel`'s
  class documentation.
- Structural guarantee over a brand type: `SessionModel.pathToLeaf()`
  produces the path itself; no ref-taking entry point is used by the TUI.
- **Full entries on the wire.** `SessionTracker.push` emits the complete
  entry for every class (today a shared-class entry goes out structural,
  session-tracker.ts `sessionEntryEvent`); `expectsSdkMessage` stays — it
  is the fold's classification, not a payload flag. The daemon's own
  `SessionTracker.byUuid` stays structural (its memory bound). This
  removes `completedEntry`, twin grafting and every "which side carries
  the payload" rule from clients; a client's `byUuid` holds complete
  entries whichever side arrived first. Cost: shared-class payloads cross
  the local socket twice (Cost).
- **One `SessionModel` per session id.** The TUI's `SessionModels`
  mirrors `AgentState.sessions`: `sessionEntry`/`sessionFileChanged`/
  `scanComplete` route to `fileSessionId`, `sdkMessage` to
  `message.session_id`, `userMessageDequeued` to `querySessionId` (all
  read from the folded state, which those folds leave as the event
  found it or set to the event's own id); a model whose id has left
  `sessions` after a fold is dropped. Per model: `byUuid` (complete
  entries, first-wins, never cleared), the rolling trees (reset on a
  `sessionFileChanged` for this id and rebuilt from the entries the new
  tracker emits — a same-file rescan therefore holds exactly the current
  file's entries, `byUuid` merely retains stale payloads), `queryMessages`
  (the pending list, insertion order = query order), and
  `attachmentBySource` (a steer's `queued_command` entry under its
  `source_uuid`, so `entryFor(uuid)` answers for steers too). Nothing in
  a model names another session; the reviewer's rollover cases
  (A→B→C with the follower at B, switches on either side of the snapshot
  cut) reduce to routing.
- **Resolution retires and replaces.** `SessionState` gains `resolved`,
  the ids resolved by every `observeOn` call of the fold step that
  produced this state, in resolution order (`nextAgentState` clears it
  before folding, as it clears `anomaly`; each `observeOn` appends —
  a multi-steer dequeue, an attachment's uuid + `source_uuid`,
  `sessionAppended`, a rescan and a reset's observe + exclude all make
  several calls in one step). After folding each event the TUI reads
  `sessions[id].resolved` for every session: each resolved id leaves
  `queryMessages`, and the item keyed under it re-renders in place from
  `entryFor(id)` when the model has the entry (a reset-excluded prompt has
  none: nothing to re-render). The store rule is the merge's: after the
  fold, every uuid-bearing message of the query stream — an `sdkMessage`'s
  or a `sessionAppended`'s `message` (`sdkMessageOf(event)`,
  protocol.ts) — is recorded iff the fold observed the uuid on `query`:
  `merge.nodes[uuid]?.seenOn` includes `"query"`, or the step's
  `resolved` holds the uuid with `"query"` in its `seenOn` (the merge
  forgets resolved nodes, and an id resolves in its own step when
  nothing pends ahead of it — every `stream_event` between turns, an
  entry-first frame; such an id is retired again by the same step's
  resolutions). Node existence is not enough: a failed observation —
  `anomaly` — leaves an existing node untouched, e.g. a session-only
  node blocked behind an unresolved predecessor when `query` attempts
  it. A dequeued prompt is recorded under `ids.at(-1)`, steers each
  under their own id, on the same condition.
  Types the file never carries (`stream_event`, `result`, other `system`
  subtypes, `conversation_reset`, `command_lifecycle`) are recorded too:
  the merge excludes them from `session`, and they resolve once every
  `query` predecessor has, so the list is the query tail past the last
  file-settled message and a rebuild replays it through `append` exactly
  as the live stream did (a retained `conversation_reset` replays as the
  reset it was; partial output reconstructs only while its
  `message_start` is still pending — a multi-block message whose earlier
  block's frame already pends replays as that finalized block, the later
  block's deltas lost until its own frame: a safe partial loss). No
  second classification predicate on the client: the stored set is
  `!excludedFromSession` by construction. Invariant:
  **`keys(queryMessages)` equals `pending(merge, "query")`** — the seed
  state's pending ids are seeded with no message
  (`SessionModels.seedPending`; their payloads arrive with their entries;
  until then a rebuild cannot show them — an accepted loss).
- **The transcript renders each id's content once.**
  `TranscriptRenderer.renderedUuids` records a uuid when its visible
  content is rendered: a top-level item (assistant message, user turn,
  compact summary, boundary banner) or a command-output attachment
  (`attachCommandOutput`, which mutates the preceding command item — an
  effect, not an item, so a set rather than the item map is the guard).
  The key is the uuid the entry carries (a run's last member for a prompt;
  a steer's `source_uuid`; the entry uuid otherwise). A message whose key
  is present renders no content; everything else it does still happens:
  `append(user)` renders the compact summary under the key when the
  uuid is the preceding boundary frame's anchor (the summary rule
  below), else the turn's views unless the CLI flagged the frame `isReplay`
  (command output, stream-classification/captures/events.jsonl:151) —
  its entry renders the output attachment — then resolves tool results
  (idempotent by tool call id), and `append(assistant)` finalizes the
  stream it owns. The
  daemon's dequeue echo is the prompt's query message (the CLI never
  echoes a prompt; `userMessageDequeued` remedies that), so it renders
  through the same `append`. Stream ownership is
  the API message id: `streaming` records `message.id` from
  `message_start`, and an `assistant` frame or entry (both carry
  `message.id`) finalizes the open stream at its key only when the ids
  match — an unkeyed one renders whole otherwise (today's "no partials
  seen" path); a keyed one discards a matching open stream (its
  provisional rendering; the entry already rendered it) and leaves a
  non-matching one alone. The two streams are delayed independently, so
  the entry path cannot assume the open stream is its own (file entry A
  → `message_start` A → file entry B → frame A is a legal order); the
  API id is used for stream ownership only, never for transcript
  identity. `itemsByUuid: Map<UUID, AssistantItem
| UserTurnItem>` is the replacement lookup: at resolution the item's
  component re-renders in place from the entry (`updateContent`; tool
  items are keyed by tool call id and never re-created). This matters
  for both kinds: a prompt's entry carries the CLI's slash-command
  rewrite (`<command-name>…`), and an assistant frame carries
  `stop_reason: null` where its entry carries the final value
  (exp4-events.jsonl 31/35 vs exp4-S1.jsonl 9–10; `toStopReason` renders
  `max_tokens`/`refusal`). A rebuild is `resetTranscript()` (a fresh
  transcript headed by the welcome line, so it tops every scrollback;
  the startup warnings describe the keybindings and settings as read at
  start and appear only on the first attach), then the query session
  only: its display path — the trees hold resolved entries only (phase
  1.5: an entry joins them when the merge resolves its id, so an
  unresolved file-side entry and the pending query messages are never
  interleaved), then its `queryMessages` through `append` exactly as
  they rendered live. The file session's path is not rendered while `querySessionId`
  differs (rollover window): the old file is not this conversation.
  `streaming`,
  `toolComponents`/`toolItems` (results, subagent children) stay as they
  are. This replaces `replayedBoundaryUuids`, `replayedUuids`,
  `releaseDedupeUuid` and the attach-point banner.
- **The summary rule.** A compaction summary's entry is identified by
  its `isCompactSummary` flag — the file's own marker, which also covers
  a summary preserved by a later boundary without its own (a relink:
  Anton's session file has a self-anchored boundary `f3e4b1fa` followed
  by the earlier summary `2dac0aa6` parented on it). Its frame carries
  no flag (`isSynthetic` is undocumented in sdk.d.ts and attested on one
  capture), so the frame is identified by the anchor heuristic: a
  boundary frame's `preserved_messages.anchor_uuid` is its summary's
  uuid, or its own when it has none (a rewind, a bare wipe — the CLI's
  convention on every boundary in the captured sessions, and
  `buildBoundaryEntries`' `summaryUuid ?? boundaryUuid`), and the summary
  frame immediately follows the boundary frame. The transcript holds
  the last boundary frame's anchor until the next top-level user frame,
  which renders as the `CompactSummaryComponent` ("Compacted (ctrl+o to
  see full summary)") iff its uuid is that anchor; no other user frame
  after a boundary is a summary. Both sides render into the same
  component under `firstRender(uuid)`, whichever arrives first.
- **Rebuild triggers and the scan window.** Attach (after the snapshot),
  `contextChanged` and `scanComplete` call `renderHistory()`.
  `sessionFileChanged` resets the transcript and the model's trees and
  renders nothing; the entries between it and `scanComplete` fold only.
  The daemon emits the three in one synchronous segment
  (tracked-session-log.ts `open`: announce, `follower.start()`,
  `scanComplete`), so the blank window is one socket burst. Rendering at
  `sessionFileChanged` instead would put pending prompts before the
  scanned history. Events buffered during the attach fetch fold state
  only (`applyState`), never render — the rendered transcript is the
  state of the world at the end of the fetch. Not a uuid-dedupe of the
  buffered events (rejected by review): stream frames carry their own
  uuids, not the assistant's (exp4 capture: `message_start` `eb033284…`,
  finalized `85866333…`), and a buffered `conversation_reset` clears the
  transcript destructively.
- Accepted losses (what no rebuild — attach, `contextChanged`,
  `scanComplete` — can show): rendering effects that are not in the
  model — transient banners
  (`notification`, refusal, "turn failed", `compactSent`/`interruptSent`,
  "conversation reset", `local_command_output`), a stream in progress
  (later deltas find no streaming component; the finalized `assistant`
  renders whole, today's "subscribed mid-message" path), and nested
  subagent output (rendered live inside tool components from
  `parent_tool_use_id` messages, which the main-session path does not
  carry). `resetTranscript` clears every banner too, so a banner that
  must survive a rebuild is added after `renderHistory()` (the attach
  fetch-error banner); banners added before it during the fetch are
  lost.
- Queued prompts do NOT go into `byUuid` or `queryMessages`.
  `SessionModels.queued` holds the messages of `userMessageQueued` events
  (seeded from the seed state's `queuedMessages`); `userMessageDequeued`
  removes its ids, joins them (turn/append) and records the result in the
  query session's `queryMessages` under `ids.at(-1)` — steers one each
  under their own id — on the store rule above (recorded iff the fold
  observed the id on `query`: an entry-first prompt resolved in the same
  step is recorded and retired within it). No client guard: the merge
  already knows.
- Steers: observe every dequeued prompt on `query` under its stamped uuid;
  in `foldSessionEntry`, a `queued_command` attachment carrying
  `source_uuid` additionally observes `source_uuid` on `session` (the
  attachment's own uuid stays a session-only observation). Both arrival
  orders happen — the dequeue is emitted at the first assistant activity
  after the tool result, and the tail may read the attachment line before
  or after that frame — so `excludeOther` is decided from state the fold
  has. The rule is the same for a run's `user` entry (uuid = last member)
  and for a `source_uuid`: the uuid in `queuedMessages` (ours, dequeue
  still to come) or already in the merge (dequeue folded) → `false`;
  otherwise historical (a prompt this daemon never dequeued: scan,
  previous daemon run) → `true`, consistent with the scan exclusion of
  everything before the first shared query uuid. Without the
  `queuedMessages` half, an entry-first prompt would be excluded from
  `query` and its dequeue would fail `excluded-observed`. The hub emits a
  steer dequeue **before** the assistant activity that triggered it (the
  trigger only tells the queue model that the CLI has absorbed the
  steer), so the stream order is `tool_result` → steer → assistant, the
  file's order. Turn/append dequeues still follow their `result`.
- The dequeue fold sets `pendingLeaf = ids.at(-1)` for a turn/append
  dequeue (the prompt is a tree row, like a `user` sdkMessage), before the
  observation, so an entry-first resolution clears it in the same step. A
  steer's attachment entry is a tree node too, but its uuid is only
  learned when the attachment lands, so a steer dequeue cannot move the
  leaf; the entry moves it (`treeLeaf`) as today. With no `querySessionId`
  yet (a prompt dequeued at spawn, before the first `init`), the ids
  leave `queuedMessages` and nothing is observed: the entry arrives
  file-only, as today.
- `conversation_reset` (old session id) excludes from `session` the LAST
  pending-on-`query` node of that session **that awaits a `session`
  occurrence** (the last id of `pending(merge, "query")` whose node is not
  excluded from `session`; `pending()` is in query order) via
  `excludeFrom(merge, ["session"], uuid)`, resolving it and clearing
  `pendingLeaf` if it was the leaf: whatever was last awaiting the file
  is what caused the reset, and the CLI files it under the next session
  (docs/claude-agent-sdk.md, "Session ids roll over in place"). The
  selector ranges over pending nodes only, so a message that already
  landed is never excluded. The raw last pending id would be wrong:
  `command_lifecycle started` and the `conversation_reset` message itself
  are observed query-only after the reset command (exp4 capture). No
  command classifier; every other pending observation still has to land.
  A heuristic: if the reset's cause was not a prompt, the exclusion is
  wrong and lossy for the abandoned session (its message is retired
  without its entry and the switch proceeds without waiting for it);
  accepted because only a conversation the CLI has abandoned is affected.
  When the prompt's entry then arrives in the new file it is `user`
  without `tool_result` → `excludedFromQuery` → a session-only node,
  resolved at once: no anomaly, no special case.
- Merged runs mirror the session file (docs/derisk/queued-batches/):
  the CLI dequeues one run per `result` — within the top-priority bucket,
  a maximal run of consecutive querying members, or a single append — and
  writes one entry under the run's **last** member. `queue-model.ts` emits
  one `userMessageDequeued` per run (not per bucket). On a turn/append
  dequeue with several ids, both folds (`nextAgentState` and
  `SessionModels`) hold one joined message under `ids.at(-1)`, produced by
  one shared core join function; steers are never joined. The join has
  two shapes, both pinned by the sdk test: all-string members → `\n`-joined
  string; any block-form member → one block array, strings lifted to text
  blocks, arrays spliced, no separator.
- Settlement: a dequeued prompt is a query-stream observation like any
  other (the CLI simply fails to echo it); `settled()` waits for its entry.
- Interrupt: unchanged. A plain interrupt drops nothing, and
  `cancel_queued` is unreachable through the SDK (`Query.interrupt()` takes
  no argument, sdk.d.ts:2591), so neither `--cancel-queued` nor
  dropped-prompt reporting is in this spec; `command_lifecycle` frames are
  merge observations like any uuid-carrying message (query-only) and
  nothing more.
- `agent-state.ts` is split into a directory before any behaviour change
  (a pure move, committed on its own); `agent-state/agent-state.ts` is the
  public surface (defines `AgentState`/`nextAgentState`, re-exports what
  outsiders use); siblings are implementation, one file per function or
  per group that genuinely belongs together; an ESLint
  `no-restricted-imports` rule forbids importing siblings from outside.
- One spec, four phases in order: (0) the directory split, (1) the
  rebuild — full entries, `SessionState.resolved`, per-session models,
  render-once (independent of stamping), (2) the queue model's per-run
  dequeue, (3) identity.
- docs/thoughts/fold-resolved-events.md moves to docs/thoughts/old/ as
  part of this spec: `SessionState.resolved` is its idea, and the
  render-once guard is why the immediacy client needs nothing more.
- Follow-up item (not this spec): audit the SDK for control requests that
  gained flags/arguments clauctl does not expose (`cancel_queued`,
  `cancel_async_message`, …).
- Tests: `agent-state.test.ts` — `resolved` set by the step that resolves
  and empty on the next; several resolutions in one step (entry-first
  multi-steer dequeue; a reset that observes and excludes);
  `session-models.test.ts` — routing across a rollover (A→B→C with the
  file at B), a switch before and after the snapshot cut, a same-file
  rescan keeping payloads, a dequeue-first and an entry-first prompt
  (turn and steer) retiring on resolution, a subscription whose seed
  state already has pending query ids (nothing recorded, nothing to
  retire), a failed observation against an existing session-only node
  blocked behind an unresolved predecessor (`anomaly`, nothing
  recorded), a reset frame retained behind an unresolved predecessor
  (never stored), a pending `compact_boundary` frame replayed by a
  rebuild; `transcript.test.ts` — render-once (sdkMessage then entry,
  entry then sdkMessage, boundary from either side after a rebuild), open
  stream → file-first assistant entry → its frame (one item, stream
  finalized), file entry A → `message_start` A → file entry B → frame A
  (B renders whole, A's stream finalized by its frame),
  assistant replacement updating `stop_reason` without re-creating tool
  items, a `user` frame with text and tool results (text renders under
  the key, results resolve, the entry adds nothing), a synthetic
  compact-summary frame then entry (`CompactSummaryComponent` once), a
  replay output-only frame then entry (attached once), the user-turn
  replacement preserving attached output and expansion; an
  `interactive-mode` case for a failed history fetch, one for the scan
  window (nothing renders between `sessionFileChanged` and
  `scanComplete`, `onResolved` ignored) and one for a snapshot cut
  preceding a session switch.

## Type Design

### Phase 0 — `src/core/agent-state/` (pure move)

```
src/core/agent-state/
  agent-state.ts            AgentState, AgentActivity, initialAgentState, nextAgentState (the switch);
                            re-exports the public symbols of the siblings
  agent-state.test.ts       moved from src/core/agent-state.test.ts
  session-state.ts          SessionState, MergeStream, freshSessionState, withSession, withoutFile
  selectors.ts              querySession, leaf, lastUsage, settled, sessionSettled, describeSession,
                            SETTLE_TIMEOUT_MS, isIdle, queryingCount, isQuerying
  tracker-anomaly.ts        TrackerAnomaly, withAnomalies
  observe-on.ts             observeOn (+ Observation, otherStream)
  classification.ts         excludedFromSession, excludedFromQuery, classOf, isLocalCommandStdout
  to-non-nullable-usage.ts  toNonNullableUsage
  fold-query-message.ts     foldQueryMessage, withPostTokens, isLeafEligible
  fold-session-entry.ts     foldSessionEntry
  fold-session-file-changed.ts
  fold-session-appended.ts
  fold-scan-complete.ts
  fold-sdk-message.ts       the `sdkMessage` case body (subagent filter, init/status/assistant/result,
                            conversation_reset); calls foldQueryMessage
  fold-user-message-queued.ts
  fold-user-message-dequeued.ts
  observed-permission-mode.ts  withObservedPermissionMode (shared by the `controlApplied` case and
                            fold-sdk-message; a sibling so no fold imports agent-state.ts at runtime)
```

Every symbol keeps its name and signature. Importers of
`core/agent-state.ts` (27 files) switch to `core/agent-state/agent-state.ts`.
`eslint.config.js` gains:

```js
"no-restricted-imports": ["error", {
  patterns: [{
    group: ["**/agent-state/*", "!**/agent-state/agent-state.ts"],
    message: "Import agent-state/agent-state.ts; the siblings are implementation.",
  }],
}],
```

Sibling imports inside the directory are `./x.ts` (no `agent-state/`
segment) and are not matched.

### Phase 1 — the rebuild

```ts
// core/daemon/session-tracker.ts — push(): the sessionEntry event carries
// `entry` (complete) for every class; `expectsSdkMessage` unchanged.
// structuralEntry stays for the daemon's byUuid/trees.

// core/agent-state/session-state.ts
interface SessionState {
  // existing fields
  /** Ids resolved by every observeOn call of the fold step that produced
   *  this state, in resolution order; empty on every other state. */
  readonly resolved: readonly Resolved<UUID, MergeStream>[];
}
// observe-on.ts: observeOn returns the session with
// `resolved: [...session.resolved, ...step resolutions]` (it already
// collects across excludeFrom + observe; every call in a step appends).
// agent-state.ts nextAgentState: clears `resolved` of every session and
// `anomaly` before folding.
// core/stream-merge.ts: unchanged (MergeStep stays the library's return).

// core/protocol.ts — PROTOCOL_VERSION 2 (wire change)
// The daemon appended an entry to the query file itself (set-context):
// its query-stream form, one event per entry in file order, emitted
// before the drain that delivers the entries — the echo the CLI would
// have produced had it written them.
// | { kind: "sessionAppended"; message: SDKMessage }
/** The SDKMessage an event carries: the CLI's own frame, or the daemon's
 *  echo of an entry it appended. Both are what the fold observes on
 *  `query`, so a client's pending list and its transcript treat them
 *  alike. */
function sdkMessageOf(event: AgentEvent): SDKMessage | undefined;
// core/session/file.ts: appendedEntryToSdkMessage(entry): SDKMessage —
// the boundary as SDKCompactBoundaryMessage (with preserved_messages),
// the summary as the plain user message; no flag marks it (summary rule).
// agent-state/fold-session-appended.ts observes the message's uuid on
// `query` of `querySessionId` with `classOf(message)`.

// tui/session-model.ts — one session
class SessionModel {
  /** Complete entries, first-wins, never cleared (payload retention
   *  across a same-file rescan). */
  readonly byUuid: Map<UUID, SessionEntry>;
  /** The query pending list, in query order (Decisions, store rule); a
   *  rebuild replays them through `append` exactly as they rendered live.
   *  undefined: pending in the seed state at attach, frame never seen
   *  here (`SessionModels.seedPending`). */
  readonly queryMessages: Map<UUID, SDKMessage | undefined>;
  private readonly attachmentBySource: Map<UUID, SessionEntry>;
  private trees: RollingTrees;
  get leaf(): TreeNodeRef | null;
  get contextTree(): ContextTree;
  get displayTree(): DisplayTree;
  /** Entries in file order not yet in the trees (phase 1.5), each
   *  flagged when a contextChanged followed it in the file stream. */
  private readonly queuedEntries: {
    entry: SessionEntry;
    contextChangedAfter: boolean;
  }[];
  enqueueEntry(entry: SessionEntry): void; // byUuid (first-wins), attachmentBySource, queue
  /** Flags the queue's tail; true when nothing is queued (due now). */
  enqueueContextChange(): boolean;
  recordPending(uuid: UUID, message: SDKMessage | undefined): void;
  /** queryMessages.delete; the queue's prefix through uuid into the
   *  trees (a deeper position is an anomaly); entry = entryFor(uuid),
   *  contextChanged iff a pushed entry carried the flag. */
  resolve(uuid: UUID): {
    entry: SessionEntry | undefined;
    contextChanged: boolean;
  };
  resetTrees(): void; // sessionFileChanged for this id; clears the queue too
  /** byUuid[uuid], else the queued_command entry whose source_uuid is
   *  uuid. A retained entry for a uuid the current trees lack is the
   *  same entry the file re-wrote (first-wins, as everywhere). */
  entryFor(uuid: UUID): SessionEntry | undefined;
  /** The display path to `leaf` (nearestVisibleNode → pathToLeaf over
   *  displayTree.parentMap and byUuid). */
  pathToLeaf(): TreeNodeRef[];
}

// tui/session-models.ts — the mirror of AgentState.sessions
class SessionModels {
  constructor(
    onInvalid: OnInvalid,
    onResolved: OnResolved,
    onContextChanged: OnContextChanged,
  );
  /** The seed state's query-pending ids → recordPending(id, undefined)
   *  on their session models (attaching mid-turn). */
  seedPending(state: AgentState): void;
  /** Every event of the subscription in socket order, with the state
   *  the event folded to, in this order: (1) sdkMessageOf(event), if any
   *  → recordPending on the session model of message.session_id iff the
   *  folded merge's node for its uuid, or the step's `resolved` record
   *  for it, has seenOn "query"; (2)
   *  sessionEntry → enqueueEntry on the session model of
   *  state.fileSessionId, contextChanged → enqueueContextChange on it
   *  (true → onContextChanged now), sessionFileChanged → resetTrees;
   *  (3) every session's `resolved` in order → `resolve` and onResolved
   *  with the entry, then onContextChanged if the push crossed a flag;
   *  (2)+(3) are held until the snapshot, see applySnapshot;
   *  (4) session models absent from state.sessions are dropped. */
  observe(event: AgentEvent, state: AgentState): void;
  /** The `get-entries {payload: "full"}` response into the session
   *  model of `stateAtCut.fileSessionId`, where `stateAtCut` is the state
   *  the daemon answered against: the seed state folded through the
   *  first `eventsBefore` events (the TUI has it: the state paired with
   *  the buffered event at `eventsBefore - 1`, or the seed state). The
   *  snapshot is the file prefix in resolution order: each entry is
   *  enqueued and resolved in turn. Held events then replay (3) with
   *  their own states, and (2) only past the cut. A failed fetch applies
   *  an empty snapshot at position 0. */
  applySnapshot(
    entries: readonly SessionEntry[],
    eventsBefore: number,
    stateAtCut: AgentState,
  ): void;
  get(sessionId: UUID): SessionModel | undefined;
}
/** A step resolved `uuid` on `sessionId`, reported in resolution order
 *  after the session model pushed its entry into the trees; `entry` is
 *  what renders `uuid`, undefined for a query-only id. */
type OnResolved = (
  sessionId: UUID,
  uuid: UUID,
  entry: SessionEntry | undefined,
) => void;
/** A contextChanged on `sessionId` resolved: the entry it followed is in
 *  the trees, so the path is current (phase 1.5 spec, Data Flow 5). */
type OnContextChanged = (sessionId: UUID) => void;
```

- `interactive-mode.ts`: `resetTranscript()` installs a fresh transcript
  headed by the welcome line; `reloadHistory(startupWarnings)` adds the
  warnings once, on the first attach. `renderHistory():
void` — the query session's `pathToLeaf()` entries via
  `transcript.appendEntry` (no merge read: the trees hold resolved
  entries only), then its defined `queryMessages` values via
  `transcript.append`, then the `deliveredMessages` tail via `append`
  (until phase 3). Attach, a resolved `contextChanged`
  (`onContextChanged`) and `scanComplete` call it identically after a
  reset; `sessionFileChanged` calls `resetTranscript()` only. Live, the
  dequeue echo and a `sessionAppended`'s message go through
  `transcript.append` too; a `sessionEntry` and a `contextChanged` render
  nothing on arrival.
  `onResolved(sessionId, uuid, entry)` → `transcript.resolve(uuid,
entry)` for the query session, gated like `renderEvent`: ignored while
  events are buffered for the attach fetch and between
  `sessionFileChanged` and `scanComplete` (the `renderHistory()` that
  ends each window renders the entry).
  `reloadHistory`'s release loop applies each buffered event's state
  effects only — `applyEvent` is split into `applyState(event, state)`
  (agentState, anomaly banner, pending area, footer sync) and
  `renderEvent(event)` (the transcript switch); live events call both,
  the release loop only the first. Removed: `renderEntry`,
  `pathUpToBoundary` (its `sdk-render.ts` definition and the four
  `sdk-render.test.ts` cases; no other caller), `releaseDedupeUuid`, the
  attach-point banner, `pendingContextChanges`, `replayedUuids`,
  `replayedBoundaryUuids`, the `leaf(this.agentState)` read. Kept until
  phase 3: the `deliveredMessages` tail (rendered from the folded
  `agentState`, after the pending lists).
- `transcript.ts`: `renderedUuids: Set<UUID>` (the content guard,
  Decisions) recorded by `append` for `assistant`, `system:
compact_boundary` and `system:local_command_output`, and by
  `appendEntry` for every entry that renders content (entry uuid; a
  `queued_command` attachment under `source_uuid`); `append(user)` records
  nothing. `itemsByUuid: Map<UUID, AssistantItem>` (phase 3 adds
  `UserTurnItem`) and `replaceContent(uuid: UUID, entry: SessionEntry):
void` — the keyed item's component `updateContent`s from the entry's
  rendering (`renderAssistant` of `entryToSessionMessage(entry)`); no-op
  when the uuid has no item. A keyed `assistant` frame whose API message
  id matches the stream open at its key removes that stream's item and
  component. The
  `compact_boundary` banner is keyed, so a file-first boundary after a
  rebuild and its late sdkMessage render one banner. Phase 1.5: the
  items form a resolved part and a pending part; `append` fills the
  pending part, `appendEntry` the resolved one, and `resolve(uuid,
entry)` moves the pending prefix through the items keyed `uuid` before
  rendering the entry (docs/specs/query-pending-list/phase-1.5-render-at-resolution.md).
- `/tree` and rewind read `sessionModels.get(fileSessionId)`; today's
  `sessionModel.byUuid` sites (interactive-mode.ts 1102, 1123).
- `session-model.test.ts` no longer simulates structural wire entries.

### Phase 2 — queue model per-run dequeue (`src/core/daemon/queue-model.ts`)

No signature changes. In `observeSdkMessage`'s `result` branch the
top-priority bucket is taken as now; the run is `[head]` when
`!isQuerying(head)`, else the bucket's maximal prefix of querying
members; one `dequeued(run)` event; the remaining members stay queued
for the next `result`. The `userMessageDequeued` doc comment in
`protocol.ts` states the run rule instead of "the whole bucket".

`event-hub.ts` `observeSdkMessage`: the queue-model transition is
computed first; a `steer` dequeue is applied before the message's own
`sdkMessage` event, a `turn`/`append` dequeue after it (Decisions,
Steers). The "dequeues follow their trigger" comments in `event-hub.ts`
and `queue-model.ts` are replaced accordingly.

### Phase 3 — identity

The queue id is the stamped uuid.

```ts
// protocol.ts
| { kind: "userMessageQueued"; id: UUID; message: SDKUserMessage }
| { kind: "userMessageDequeued"; delivery: MessageDelivery; ids: UUID[] }

// queue-model.ts
export interface QueuedMessage { id: UUID; message: SDKUserMessage; toolResultSeen: boolean }
export interface QueueModelState { queued: QueuedMessage[] }          // nextId removed
export interface AcceptTransition extends QueueTransition { id: UUID }
/** `message.uuid` must be set: the hub stamps before delivery. */
export function acceptUserMessage(state, message: SDKUserMessage, isIdle: boolean): AcceptTransition

// event-hub.ts — stamps, delivers the stamped message, then accepts it
deliverUserMessage(message: SDKUserMessage): UUID

// agent-state/agent-state.ts
readonly queuedMessages: readonly { id: UUID; message: SDKUserMessage }[];
// `deliveredMessages` removed, with the positional clears in fold-sdk-message.ts
// (`sdkMessage` user/assistant, `conversation_reset`).

// agent-state/joined-prompt.ts (new sibling, re-exported by agent-state.ts)
/** The one message the CLI writes for a merged run: the last member with
 *  the run's content joined the way the CLI joins it (all strings →
 *  `\n`-joined; otherwise one block array, strings lifted to text blocks). */
export function joinedPrompt(messages: readonly SDKUserMessage[]): SDKUserMessage

// agent-state/fold-user-message-dequeued.ts
//   turn/append: remove ids from queuedMessages; on the query file set
//   `pendingLeaf = ids.at(-1)` then observe `ids.at(-1)` on `query`
//   (class "prompt", excludeOther=false).
//   steer: remove ids; observe every id on `query`; pendingLeaf untouched.
//   querySessionId undefined: remove ids only.
// agent-state/fold-session-entry.ts
//   ours(uuid) = uuid in queuedMessages || uuid in session.merge.nodes
//   entry.uuid: excludeOther = first && !ours(uuid) && (!expectsSdkMessage || scanExcluded)
//   a `queued_command` attachment with `attachment.source_uuid` also
//   observes `source_uuid` on `session`; excludeOther = !ours(source_uuid).
// agent-state/fold-sdk-message.ts, conversation_reset
//   const last = pending(session.merge, "query")
//     .filter((id) => !session.merge.nodes[id]!.excludedFrom.includes("session"))
//     .at(-1);
//   if (last !== undefined) excludeFrom(session.merge, ["session"], last)
//   through observeOn's resolution bookkeeping (pendingLeaf cleared when
//   resolved); replaces the deliveredMessages clear.

// core/prompt.ts
submitPrompt(...): Promise<UUID | undefined>
opensGate(event: AgentEvent, promptId: UUID | undefined): boolean

// tui/components/pending-messages.ts
add(id: UUID, text: string): void
take(ids: UUID[]): string[]

// tui/session-models.ts
class SessionModels {
  constructor(onInvalid: OnInvalid, onResolved: OnResolved, queued: readonly { id: UUID; message: SDKUserMessage }[]);
  private readonly queued: Map<UUID, SDKUserMessage>;
  // observe(): userMessageQueued → queued.set(id, message)
  //            userMessageDequeued → steer: recordPending(id, {origin: "dequeue", message}) per id;
  //                                  turn/append: recordPending(ids.at(-1), {origin: "dequeue", message: joinedPrompt(messages)})
  //            on the model of state.querySessionId, iff its merge node or `resolved` record has seenOn "query"
  //            (none → ids leave `queued` only); step (3) then retires
  //            whatever this step resolved.
}

// tui/components/user-turn.ts (new; the pattern of AssistantMessageComponent)
/** One user turn — prompt text, slash command and its output — as one
 *  component, so a provisional rendering can be replaced in place. */
export class UserTurnComponent extends Container {
  constructor(views: readonly UserTurnView[], toolsExpanded: boolean);
  /** Re-renders the turn's views; output attached by attachOutput and the
   *  expansion state are preserved. */
  updateContent(views: readonly UserTurnView[]): void;
  /** Output goes under the turn's command view: true when attached, or
   *  when the command is /compact (its stdout stays hidden, as today, and
   *  counts as handled); false when there is no command view or it
   *  already holds output — the caller then renders standalone output. */
  attachOutput(text: string): boolean;
  setExpanded(expanded: boolean): void;
}

// tui/transcript.ts
interface UserTurnItem { kind: "userTurn"; component: UserTurnComponent }
// TranscriptItem = AssistantItem | ToolItem | PlainItem | UserTurnItem;
// CommandItem goes (its expand/output bookkeeping moves into the component);
// PlainItem keeps banners and compact summaries.
// The live dequeue echo and a rebuild's pending prompts go through
// `append(user)` (phase 1), which renders the turn under `message.uuid`
// and nothing when the key is present; phase 3 stamps the uuid.
// itemsByUuid: Map<UUID, AssistantItem | UserTurnItem>; replaceContent
// (phase 1) re-renders a UserTurnItem from entryUserViews(entry).
/** Entries with a user turn (user message, queued_command attachment,
 *  system/local_command) render under entry.uuid / attachment.source_uuid
 *  with entryUserViews(entry) when the key is absent; an output-only
 *  entry (<local-command-stdout>, bash output) attaches to the preceding
 *  UserTurnItem (attachOutput) or renders standalone — as today's
 *  attachCommandOutput. */
appendEntry(entry: SessionEntry): void;
/** The views of an entry — factored out of today's appendEntry branches
 *  (user message, queuedCommandPrompt, system/local_command). */
private entryUserViews(entry: SessionEntry): UserTurnView[];
// resetTranscript / conversation_reset clear renderedUuids and itemsByUuid
// with the rest.
```

`interactive-mode.ts` drops `queuedById` (`SessionModels` holds it) and
the `deliveredMessages` tail; the live `userMessageDequeued` case calls
`append` on the joined message stamped `uuid = ids.at(-1)` (steers: one
call per id) — the render-once guard makes the entry-first case a
no-op; `onResolved` →
`replaceContent` (phase 1) now also covers user turns. `format/events.ts` and
`format/sdk-message.ts` switch their id types. `/compact` is not a
dequeued prompt (it bypasses the queue model: `compactSent`); its entry
renders through `appendEntry` only.

## Data Flow

Phase 1:

1. `sessionEntry` (complete) → `SessionModels.observe` → the file
   session's `enqueueEntry`; the fold's `resolved` for that step
   `resolve`s each id (retires it from `queryMessages`, pushes the queue
   through its entry) and fires `onResolved` → `transcript.resolve`
   (moves the frame's items into the resolved part, renders the entry:
   assistant `stop_reason`; user turns in phase 3).
2. `sdkMessageOf(event)` (an `sdkMessage`'s or a
   `sessionAppended`'s message) → `transcript.append` live, and
   `recordPending` on the model of `session_id` iff the fold observed it
   on `query` (merge node or this step's `resolved` record); retired
   when the merge resolves it — in the same step for an id with nothing
   pending ahead (entry-first, or a `stream_event` between turns).
3. `sessionFileChanged(id)` → the fold drops the old `SessionState`
   (unless a same-file rescan) → `SessionModels` drops that model and
   resets the trees of `id`'s model; the TUI `resetTranscript()`s. The
   scan's entries fold; `scanComplete` → `renderHistory()`.
4. `contextChanged` → `enqueueContextChange` on the file session's model;
   `renderHistory()` when the entry it followed resolves (or at once if
   it already has) — phase 1.5 spec, Data Flow 5.
5. Attach: `reloadHistory` fetches `get-entries {payload: "full"}`
   (answered under `acquireSettled`), `applySnapshot` with the state at
   the `eventsBefore` cut (the snapshot's entries enqueue and resolve in
   file order; held events replay their resolutions with their own
   folded states, entries and file switches only past the cut, so a held
   `sessionFileChanged` routes correctly), applies the state of every
   event buffered during the fetch, then `renderHistory()`. The buffered
   events render nothing and their `onResolved` calls are ignored.
6. `renderHistory()` after `resetTranscript()` (banners at the top): the
   query session's path via `appendEntry`; its `queryMessages` via
   `append`; the `deliveredMessages` tail via `append`.

Phase 2 (queue model): `result` → one dequeue for the first run of the
top bucket; the next `result` (the run's own) dequeues the next run.
The fold's activity logic is unchanged: the remaining querying members
keep `activity: "pending"`.

Phase 3 (identity):

1. `prompt` request → `EventHub.deliverUserMessage` stamps
   `uuid = randomUUID()`, delivers the stamped message to the SDK,
   `acceptUserMessage` uses `message.uuid` as the id → `userMessageQueued {id}`
   (+ immediate dequeue when idle). The receipt `{id}` returns to
   `submitPrompt`.
2. `userMessageDequeued` (daemon fold and every subscriber, same code):
   ids leave `queuedMessages`; turn/append observe `ids.at(-1)` on `query`;
   steer observes each id. The merge now holds the prompt as pending on
   `query`; `settled()` is false until its entry.
3. File: a run's `user` entry (uuid = last member) arrives as a
   `sessionEntry`; it is session-only by classification (no `tool_result`
   block), so `foldSessionEntry` resolves the node. A steer's
   `queued_command` attachment entry observes its own uuid (session-only)
   and `source_uuid` on `session`, resolving the steer.
4. TUI: `userMessageQueued` → `SessionModels.queued` + pending area;
   `userMessageDequeued` → the joined message into the query session's
   `queryMessages`, and `append` of the joined message (stamped
   `ids.at(-1)`) renders it unless the entry already did. The entry's
   arrival renders nothing when
   the key exists; the step's `resolved` retires the message and
   `onResolved` → `transcript.resolve(uuid, entry)` re-renders the
   turn from the entry. A rebuild renders it from the path (landed) or
   from `queryMessages` (not yet) — never both.

## Cost

- The pending list is bounded by the merge's pending set restricted to
  the three stored types: normally the query-file lag plus queued prompts
  in flight; one unresolved predecessor (a stale old-file observation)
  holds everything behind it until it resolves or the session is
  dropped (a settle timeout releases waiters, not nodes) — the same
  bound the merge itself has.
- Full entries on the wire: each shared-class payload (assistant text,
  tool results, `<local-command-stdout>`) is sent once as an `sdkMessage`
  and once as a `sessionEntry`. Today the session stream carries only
  structural stubs for those, so the combined subscription bytes of a
  live turn roughly double, on a local socket. The daemon's memory is
  unchanged (its `byUuid` stays structural).
- `SessionState.resolved`: one array per fold step, as long as that
  step's resolutions (a delayed predecessor resolving releases everything
  behind it at once); cleared on the next step, nothing accumulates.
- A rebuild replays the whole path (thousands of nodes on long sessions)
  — the existing per-compaction cost, plus one per `scanComplete`.
- A client's `byUuid` retains complete payloads for the session's
  lifetime (it did before too: twins were grafted in); a same-file rescan
  adds nothing.
- Settlement: prompts pending on `query` make `settled()` wait for the
  CLI to persist them. A turn's entry is written when the turn starts and
  a steer's attachment before the steer is dequeued, so the wait is a file
  flush; an append's entry lands at its own empty `result`.
- Phase 0 touches 27 import sites and moves ~800 lines; review effort
  concentrates on "nothing changed but paths".
- Phase 1 rewrites `session-model.ts` into two classes and the
  transcript's keying; phase 3 rewrites the transcript's user-turn path
  around `UserTurnComponent` (transcript.ts, the new component,
  `cached-lines.test.ts`'s `UserCommandComponent` case). `itemsByUuid`
  holds one entry per keyed item for the transcript's lifetime; a
  replacement is an in-place `updateContent`, no array search. Review
  effort concentrates there.

## Edge cases

- File leads query (entry before its sdkMessage): the entry is complete,
  renders on arrival and keys the uuid; the late sdkMessage renders
  nothing and is recorded and retired within its step. If a stream
  with the entry's API message id was open, the entry finalized it
  (through `append`) and the frame finds no matching stream; if the
  stream opened after the entry, the keyed frame discards it.
- Compact summary: the query stream's `user` frame renders nothing live
  (as today: `append(user)` resolves tool results only) and records no
  key, so the entry's `CompactSummaryComponent` renders on arrival; a
  rebuild while the frame is pending shows nothing for it (as live).
- A steer is a pending item from its dequeue until its attachment entry
  resolves it (`source_uuid`), or — entry-first — never pending: the
  attachment renders on arrival and the later dequeue renders nothing.
- A slash-command prompt renders from the query message (`/context`)
  until its id resolves, then from the entry with the CLI's
  `<command-name>` rewrite — the same provisional-then-final sequence a
  re-attach shows only the final of. Its stdout is a separate
  `<local-command-stdout>` entry with its own uuid (shared class: the
  query stream replays it as a `user` frame with `isReplay`, which
  renders no text), rendered when the entry arrives and attached to the
  preceding turn (`attachOutput`).
- Rollover (`/clear`): `conversation_reset` clears the transcript; the
  new session's messages render live into a fresh model under the new
  `session_id`; `sessionFileChanged(new)` drops the old model,
  `scanComplete` rebuilds from the new one. A prompt queued behind the
  `/clear` is dequeued after the new `init` (new session's model) whether
  or not the follower has switched yet. The daemon-side follower may be
  more than one session behind (A→B→C): each switch is one routing step.
- Attach during a rollover: `acquireSettled` checks the query session
  while the follower may still hold the old file, so the snapshot can be
  the old conversation; the `sessionFileChanged`/`scanComplete` that
  follow rebuild from the new session's model. The "conversation reset"
  banner of the fetch window is not shown (accepted loss).
- Attach after a settle timeout: `get-entries` waits under
  `acquireSettled`, and on `SETTLE_TIMEOUT_MS` the request **fails**
  (`whenSettled` rejects → error response); the TUI applies an empty
  snapshot (`applySnapshot([], 0, state)`) and adds the fetch-error
  banner after `renderHistory()` (which resets the transcript).
  From then on the model holds only what arrives live (complete entries,
  but no history), so the transcript is empty history plus live traffic
  until a re-attach — a local rebuild cannot recover it. Accepted; the
  daemon logs the timeout.
- Same-file rescan (`sessionFileChanged` with the same id, after a
  truncation or inode change): the fold keeps the query side's pending
  observations (`foldSessionFileChanged`), the model resets its trees
  and keeps `byUuid` and `queryMessages`; the new tracker emits each
  uuid once, so the rebuilt trees are exactly the current file.
- `conversation_reset`: queued prompts still belong to the process. The
  reset command itself (`/clear`, `/new`) is dequeued from the old
  session but its `<command-name>` entry is written to the NEW session's
  file (docs/claude-agent-sdk.md, "Session ids roll over in place";
  `tests/sdk/clear-session.test.ts`), so observing it on the old session's
  `query` would leave that session unsettled and the file switch
  (`settleAndQuiet` → `whenFileSettled(old)`) waiting out
  `SETTLE_TIMEOUT_MS`. Hence the `conversation_reset` rule in Decisions.
  A `/clear` dequeued at spawn (no `querySessionId`) was never observed,
  so the reset finds nothing pending and is a no-op. Set-context's
  daemon-appended entries cannot be the reset's last pending node: it
  tears the query down, appends, drains synchronously and restarts
  (set-context.ts), so no reset interleaves with the append/drain window.
- Fresh spawn (a prompt dequeued before the first `init`): the daemon
  fold has no query file to observe it on, and the TUI has no session
  model to record it in, so between dequeue and entry the prompt is in
  none of queued/pending/tree; it renders when its entry lands (the new
  file's first entries, one flush later). Accepted for this spec.
- Merged-run display: the pending item and the resolved entry are the same
  joined message, so live and replayed views agree.
- Idle appends: each is its own run and its own entry (never joined);
  idle acceptance already dequeues immediately.

## Non-goals

- Holding `contextChanged` until settled in the daemon (rejected: an
  ordered stream cannot hold one event without holding everything after
  it). The TUI's session model holds it per session behind the one entry
  it followed (phase 1.5), which holds nothing else. The only ordering
  change is the steer dequeue's placement before its trigger (phase 2).
- Interrupt changes (`--cancel-queued`, dropped-prompt reporting) —
  follow-up audit.
- Fixing the `<task-notification>` rendering (new CLI background-Agent
  delivery); separate.
- Moving the merge-and-`byUuid` projection into `src/core/` for other
  clients (fold-resolved-events' second half): `SessionState.resolved` is
  the piece every client needs; the TUI keeps its models.

# IMPLEMENTATION IDEAS

- Phase 1: a pending `origin: "query"` `user` message must replay through
  `append` even though it renders no text: its tool results resolve tool
  items already rendered from the path.
- Phase 1: `SessionModels.observe` receives the folded state; the
  interactive mode already buffers `[event, state]` pairs, so the
  snapshot hold stores the same pairs.
- Phase 2 tests (queue-model.test.ts): "mixed bucket with one querying
  message" becomes append `[1]` at the first result, turn `[2]` at the
  second; add `[Q, Q, A, Q]`; add a `later` run behind a `now` arriving
  mid-drain (priority still wins between results).
- Phase 3: `acceptUserMessage` asserting `message.uuid` — throw on
  absence (daemon bug) rather than stamp there, so the delivered message
  and the queued one are provably the same object.
- `joinedPrompt` for `origin`/`priority`/`shouldQuery`: take the last
  member's fields. `shouldQuery` is equal by construction (all querying);
  `priority` shares a bucket (default and `next` rank alike, so the
  literal may differ); `origin` may differ across a run (a human prompt
  merged with a mailbox one). The last member's values are a choice, not
  a derivation; the CLI's entry carries none of them.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Derisk: type design + data flow approved 2026-09-16
      Each phase keeps its own plan and work log at
      `docs/specs/query-pending-list/phase-N-<name>.md`; this log tracks
      phase status only.

- [x] Phase 0 `src/core/agent-state/` split + lint rule done 2026-09-18
      (committed) — docs/specs/query-pending-list/phase-0-agent-state-directory.md
- [x] Phase 1 rebuild (full entries, `SessionState.resolved`,
      `SessionModels`, render-once) — plan in
      docs/specs/query-pending-list/phase-1-rebuild.md
- [x] Phase 1.5 render at resolution (entry queue, two-part transcript,
      `renderHistory` without the merge read) done 2026-09-20 —
      docs/specs/query-pending-list/phase-1.5-render-at-resolution.md
- [x] Phase 2 bucket probe + sdk test — probe (docs/derisk/queued-batches/)
      and `tests/sdk/queued-batches.test.ts` done 2026-09-16; fact recorded
      in docs/claude-agent-sdk.md
- [x] Reset-window probe + sdk test — exp4 in
      docs/derisk/clear-vs-session-experiment/ and
      `tests/sdk/clear-session.test.ts` (5/5) done 2026-09-17; fact
      recorded in docs/claude-agent-sdk.md
- [x] Reset command's dequeue handling decided 2026-09-17 (Anton: exclude
      the last pending query uuid at `conversation_reset`); narrowed
      2026-09-18 to the last node awaiting `session`
- [x] /reviewer pass 1 on this spec 2026-09-17 (findings in the
      2026-09-18 entry)
- [x] /reviewer pass 2 on the single-render-source revision 2026-09-18
      (findings in the pass 2 entry)
- [x] /reviewer pass 3 on the keyed-upsert / session-lifecycle revision
      2026-09-18 (findings in the pass 3 entry; design revised)
- [x] /reviewer pass 4 on the full-entries / per-session / resolution
      revision 2026-09-18 (findings in the pass 4 entry)
- [x] /reviewer pass 5 on the content-guard / store-rule revision
      2026-09-18 (findings in the pass 5 entry)
- [x] /reviewer pass 6 2026-09-18: no blockers; two wording edits applied
      (stream discard only on matching API id; stdout renders at its
      entry)
- [ ] Phase 2 queue-model per-run dequeue
- [ ] Phase 3 identity; `git mv docs/thoughts/fold-resolved-events.md docs/thoughts/old/`
- [ ] Follow-up (separate): SDK control-request flag audit
      (`cancel_queued` unreachable via `Query.interrupt()`)

## 2026-09-16 — diagnosis

- Capture: `clauctl tail --type events --json` across a `/compact`
  (`/tmp/events2`, not committed) + tmux pane. Offline replay
  (`/tmp/replay-leaf-race.ts`, scratch: session file → `SessionModel`
  snapshot, then the captured events through `nextAgentState` +
  `SessionModel.observe`) showed at the first `contextChanged`:
  `stateLeaf={uuid: ce8e212a}` (pendingLeaf from the
  `<local-command-stdout>` sdkMessage) `inByUuid=false → boundaryMissing`.
  Its entry arrived three events later.
- The second boundary in the capture was Anton rewinding (set-context);
  expected. An earlier "summary rendered as expanded user turn" was
  daemon/TUI version skew; not pursued.
- Rejected: deferring the rebuild until the state leaf lands (moving
  target, waiting state); holding `contextChanged` in the daemon
  (ordered stream); cutting at the file leaf without re-applying pending
  (loses content); coupling to fold-resolved-events (its resolved list is
  the complement of what the rebuild needs — reversed 2026-09-18, pass 3:
  the resolved list is what retires the pending list).

## 2026-09-16 — steer timing and batch probe

- Steer-dequeue timing verified in `queue-model.ts`: default-priority
  queued messages are marked at the `tool_result` and the `steer` dequeue
  is emitted at the next assistant activity after it (with
  `includePartialMessages`, the first `stream_event`) — never at the tool
  call. Query order tool_result → steer → assistant matches the file
  order `user tool_result` → `attachment queued_command` → `assistant`
  (uuid-stamping capture). No queue-model change needed.
- Batch probe (docs/derisk/queued-batches/, SDK 0.3.258): steers absorbed
  together → one `queued_command` attachment per member, each with its
  own `source_uuid`; merged next turn (all querying, default or `later`)
  → one `user` entry, `\n`-joined, uuid = last member;
  `command_lifecycle` per member in all cases. Appends never coalesce:
  idle appends (spaced or back-to-back) and a bucket containing a
  `shouldQuery:false` member are written one entry per message, each
  with its own `result`. So queue-model.ts's "whole bucket = one
  delivery" is wrong for mixed buckets.
- Decided (c) for merged turns (now in Decisions). Image probe
  (`probe-image.mjs`): a run with a block-form member merges to a block
  array (strings lifted to text blocks, no separator), still under the
  last member; pinned by the sdk test's mixed run.
- Dropped from the spec: `--cancel-queued` (`Query.interrupt()` has no
  argument) and dropped-with-reason (a plain interrupt drops nothing;
  `cancelled` lifecycle frames only follow `cancel_queued` /
  `cancel_async_message`, which clauctl does not send). `command_lifecycle`
  frames do reach the daemon as `sdkMessage`s despite not being in the
  `SDKMessage` union (the sdk test's triggers fire on them) — noted, not
  used.
- Phase 0 (directory split) added at Anton's request: agent-state.ts is
  too big to grow the dequeue fold and the join into.

## 2026-09-17 — reset window, attach simplification, SessionModel design

- exp4 (docs/derisk/clear-vs-session-experiment/): across `/clear` the
  query stream runs `conversation_reset` (old id) → `init` (new id) →
  `result` → next turn. A prompt queued behind `/clear` is dequeued after
  the rollover: attributed to the new session, entry in the new file. The
  `/clear` prompt itself is dequeued from the old session and its entry
  lands in the new file — the only prompt whose query observation and
  entry disagree on session. `new_conversation_id` matched neither id.
  Pinned by `tests/sdk/clear-session.test.ts`.
- Consequence (Anton): with the dequeue observed on the old session's
  `query`, that session never settles and `settleAndQuiet`'s
  `whenFileSettled(old)` waits the full timeout before the follower
  switches files. Rejected: a reset-command classifier in the dequeue
  fold (a command list to maintain); excluding every pending prompt at
  the reset (declares the file settled when it has not caught up).
  Decided (Anton): exclude only the last pending query uuid at
  `conversation_reset` — it is by construction the message that caused
  the reset. Assumption to falsify if it ever bites: nothing else is
  observed on the old session's query between the reset command's
  dequeue and `conversation_reset` (exp4 order holds for an idle-dequeued
  command; a reset command steered mid-turn was not probed).
- Attach simplification (Anton: "sounds good", reviewer to check):
  attach == `contextChanged` rebuild; no cut, no `pathUpToBoundary`,
  no attach-point banner; `replayed` is the only dedupe.
- SessionModel design (Anton): `queued` map seeded from the seed state;
  dequeue → join → twin under `ids.at(-1)`; steers resolve by
  `source_uuid`; invariant merge-pending == twins. `pendingLeaf` moves to
  `ids.at(-1)` on a turn/append dequeue.

## 2026-09-18 — reviewer pass 1, single render source

- Reviewer findings verified against code/captures and accepted:
  - "Last pending uuid" at `conversation_reset` picks the wrong node:
    `command_lifecycle started` (exp4-events.jsonl line 44, uuid
    `f3586ee2…`) and the `conversation_reset` message itself are observed
    query-only between the `/clear` dequeue and the reset. Rule narrowed
    to the last pending node not excluded from `session`; the
    2026-09-17 "nothing else is observed" assumption is withdrawn.
  - The invariant "merge pending-on-`query` == twins" was unqualified;
    restated as nodes awaiting `session` minus daemon-appended ids, with
    the subagent filter on both sides.
  - Steer both orders: the attachment line can be read before the
    dequeue frame. Fold: `excludeOther` from `queuedMessages`/merge
    membership. `SessionModel`: `attachmentSeen` set (Anton's design).
  - `replayed`-based exactly-once was unsound: stream frames carry their
    own uuids, and a buffered `conversation_reset` clears the transcript.
    Anton: the transcript should always be a function of `SessionModel`.
    Decided: buffered events fold state only; attach and `contextChanged`
    are the same `renderHistory()`. Accepted losses listed in Decisions;
    phase 1 keeps the `deliveredMessages` tail (fixed in phase 3; the
    phases squash-merge together).
  - Settle timeout: `get-entries` waits (`acquireSettled`,
    request-handlers.ts); corrected in pass 2 — on timeout the request
    fails and the TUI applies an empty snapshot (Edge cases).
  - Fresh-spawn gap (prompt dequeued before the first `init`) recorded as
    an accepted edge case.
- Reviewer's speculative items, resolved 2026-09-18:
  - Reset origins other than `/clear` (sdk.d.ts: plan-mode exit,
    fresh-session flows): the reset rule needs no origin knowledge. If
    the origin is not a prompt, the last node awaiting `session` is some
    assistant/tool_result message: either it already landed (nothing
    excluded) or it is excluded wrongly. A wrong exclusion is lossy for
    the abandoned session: the message is retired without its entry, the
    old file counts as settled without it, and the follower switches
    after the quiet window instead of waiting for it. Not excluding a
    reset prompt costs the settle timeout every time. A heuristic, chosen
    because the wrong case only affects a conversation the CLI has
    abandoned. Unprobed: a `/clear` steered mid-turn (deferred).
  - Event-hub drop (`observeSdkMessage`): fires only when the file
    indexed the uuid AND the merge has no node for it (resolved nodes are
    forgotten, stream-merge.ts `resolve`). A file-first shared-class
    entry leaves a node pending on `query`, so its late twin passes; the
    drop hits historical (scan-excluded) and misclassified session-only
    entries.
  - Steer display order: the dequeue followed its trigger on the wire, so
    live rendering put the steer after the `message_start` component
    while the file (and a rebuild) has it before. Decided (Anton): the
    hub emits steer dequeues before their trigger (phase 2).
  - `completedEntry` grafting: prompt entries are complete (session-only
    class) and carry the CLI's slash-command rewrite, which a re-attach
    shows. Decided (Anton): the entry wins. (Superseded in pass 3 by full
    entries for every class.)
  - Reset selector: ranges over pending nodes only, so a landed message
    is never excluded and no merge node is created for it.
- Prompt entries and the merge (Anton's question): a prompt's `user`
  entry is session-only, and `foldSessionEntry` excludes only on a first
  observation, so a dequeue-first entry is a plain observation — no
  `excluded-observed`. The entry-first order needs the `queuedMessages`
  guard; the steer `source_uuid` rule was generalized to the entry's own
  uuid.
- Twins as provisional renderings (Anton): rejected a tagged item span
  with a linear scan (a user turn was several items); decided the
  streaming pattern — one `UserTurnComponent` per turn, replaced in
  place when the entry arrives.

## 2026-09-18 — reviewer pass 2

- Accepted (all verified against code):
  - Live `contextChanged` + late boundary twin: `replayedBoundaryUuids`
    guards a real case (interactive-mode.ts 628/765); generalized (Anton)
    to "every uuid-keyed item is an upsert" — `itemsByUuid` in the
    transcript, the boundary banner from the boundary itself.
  - Attach during rollover: `acquireSettled` checks the query session
    while the follower may still hold the old file. Decided (Anton):
    `sessionFileChanged` triggers a rebuild (moved to `scanComplete` in
    pass 3).
  - Timeout: `whenSettled` rejects; the fetch fails and the TUI applies an
    empty snapshot. Edge case rewritten.
  - Entry-first ordinary prompt: dequeue records a twin only when
    `byUuid` lacks the id; `pendingLeaf` set before the observation.
  - Same-file rescan: decided (Anton) `SessionModel` clears `byUuid` on
    `sessionFileChanged` (reversed in pass 3: trees reset, payloads kept).
  - Output-only entries attach to the preceding turn; `/compact` is
    `compactSent`, not a twin — example changed to `/context`.
  - Session lifecycle: twins carry their query session; the switch drops
    other sessions' twins (replaced in pass 3 by per-session models).
  - Wording: "cannot miss", `command_lifecycle`, the ordering non-goal,
    `joinedPrompt` field choice, tests enumerated.
- Reset heuristic reworded: a wrong exclusion drops that twin's payload
  and lets the switch proceed without waiting for its entry (Edge cases /
  Decisions), not "nothing displays".

## 2026-09-18 — reviewer pass 3, design revision

- Reviewer findings, all verified and accepted:
  - Clearing `byUuid` on `sessionFileChanged` lost payloads: a rescan
    re-emits shared-class entries structurally (session-tracker.ts
    `sessionEntryEvent`) and resolved twins are gone.
  - Rebuilding at `sessionFileChanged` put pending twins before the
    scanned history (`open()` announces, then scans, then `scanComplete`).
  - "Drop every other session's twins" deleted a future session's twins
    when the follower was more than one session behind (`switchTarget()`
    is captured before `settleAndQuiet`).
  - The snapshot hold skipped a switch's twin-pruning effect when the
    switch fell before the cut.
  - Re-rendering an assistant on its entry duplicated the tool items and
    `toolComponents` the `assistant` frame owns (transcript.ts `append`).
    The uuid key itself holds: the CLI emits one `assistant` sdkMessage
    per content block with the entry's uuid (exp4 capture lines 31/35 vs
    S1 lines 9–10); nothing keys by API `message.id`.
  - Output-only entries needed an idempotent identity.
  - `sessionAppended` carries only uuids (protocol.ts) — nothing to
    render; the boundary renders from its entry. The reset-window
    argument is the set-context sequence (teardown → append → drain →
    restart), not the gate alone.
- Diagnosis (Anton, agreed): identity was being solved twice — every
  client guard added in passes 2–3 (`byUuid.has`, `attachmentSources`,
  twin sessions, an `awaitingTwin` proposal) re-derived a fact the merge
  already had — and structural entries forced every "which side carries
  the payload" rule. Decided (Anton):
  - Full entries on the wire; the daemon's `byUuid` stays structural.
  - `SessionModel` per session id, mirroring `AgentState.sessions`
    (Anton's TDC comment on the twin-session field).
  - Resolution-driven retirement and replacement: `SessionState.resolved`
    (the fold's `MergeStep.resolved`, cleared per step like `anomaly`;
    placed on `SessionState` rather than `MergeState` because `observeOn`
    makes two merge calls per observation and "empty on every other
    state" is a fold convention, not a merge-library promise). The
    fold-resolved-events idea, now in this spec.
  - Rebuild at `scanComplete`; `sessionFileChanged` resets only.
  - Replacement is for user turns only; other entries render identically
    to their query message, so their key is retired and nothing re-renders
    (my narrowing, pending Anton's confirmation).
- Trees are built from pushed entries, `byUuid` is only the payload
  lookup (session-model.ts `pushEntry`), so a truncated file's rescan
  yields the current file's trees with stale payloads retained (Anton's
  question).

## 2026-09-18 — reviewer pass 4

- Accepted, all verified against code or captures:
  - A uuid guard that skips the whole `assistant` handler strands an
    open streaming component. Resolved: the guard covers content only;
    an assistant entry runs through `append` and finalizes an open
    stream like its frame; a keyed frame finding a stream open at its
    key discards it.
  - "Entry rendering equals frame rendering" was false: frames carry
    `stop_reason: null`, entries the final value (exp4-events.jsonl 31/35
    vs exp4-S1.jsonl 9–10; `toStopReason` renders `max_tokens`/
    `refusal`), and a compact summary's frame has no `isCompactSummary`.
    Resolved: replacement at resolution covers `AssistantItem` too
    (`updateContent` only; tool items keyed by tool call id); `append
(user)` records no key (it renders no text), so summary and
    output-only entries render on arrival.
  - Guarding `append(user)` would have suppressed tool-result resolution
    and, for an output-only frame, its entry. Resolved by the same rule:
    `renderedUuids` is a content-identity set (top-level item or output
    attachment), not an item map; `itemsByUuid` is the replacement lookup
    only.
  - The exact `queryMessages` invariant failed at bootstrap (seed
    pending ids without payloads), on failed observations (`anomaly`,
    no merge node) and for subagent `stream_event`s (the fold's subagent
    filter is user/assistant only). Resolved: store iff the folded
    merge holds the id and the type is `user`/`assistant`; invariant
    restricted to ids observed since the subscription.
  - `resolved` must accumulate across every `observeOn` call of a step
    (multi-steer dequeue, attachment uuid + `source_uuid`, rescan,
    reset's observe + exclude); each call appends, `nextAgentState`
    clears.
  - Raw pending replay would recreate streaming components and replay a
    retained `conversation_reset` (destructive) when a stale predecessor
    blocks resolution. Resolved: only `user`/`assistant` messages are
    stored; a pending message replays exactly as it rendered live
    (`PendingMessage.origin`).
  - Snapshot cut state: `applySnapshot` takes the state at `eventsBefore`
    (the buffered pair's state, or the seed state); held events apply
    only their entry/tree effects — retirement and pruning already ran.
  - `onResolved` is gated like `renderEvent` (attach buffering, scan
    window); fires after the resolving entry is pushed.
  - Wording: pending-list definition (unresolved, not "entry not
    arrived"), wire cost relative to today's structural stubs, pending
    and `resolved` bounds tied to the merge's, "nothing bridges" →
    storage vs renderer.
- Speculative, noted: `entryFor` after a truncation returns the retained
  first-wins entry for a uuid the current trees may lack; resolution
  means the current file wrote that uuid, and first-wins is the
  repersist rule everywhere (docs/claude-agent-sdk.md).
- Not adopted: nothing.

## 2026-09-18 — reviewer pass 5

- Accepted, verified:
  - Node existence is not a query observation: `excluded-observed`
    leaves an existing node (stream-merge.ts `observe` rejection), so a
    session-only node blocked behind an unresolved predecessor would be
    stored when `query` attempts it. Store rule: `seenOn` includes
    `"query"`.
  - Pending `user` frames must replay in a rebuild (tool-result
    resolution); the skip idea is withdrawn.
  - Entry-driven stream finalization could finalize another message's
    stream (file A → `message_start` A → file B → frame A). Stream
    ownership is now the API `message.id` recorded at `message_start`;
    used for ownership only.
  - `compact_boundary` frames are durable content: stored and replayed
    with user/assistant.
  - Accepted losses apply to every rebuild; `resetTranscript` clears
    banners, so the fetch-error banner is added after `renderHistory()`
    (the pass 4 "banners as today" note was wrong: interactive-mode.ts
    `resetTranscript` clears the chat container).
  - A settle timeout releases waiters, not merge nodes; Cost reworded.
- Tests added: failed observation against an existing blocked
  session-only node; cross-stream A/B streaming order.

## 2026-09-19 — phase 1 review round (Anton's TDC comments, e93b5ae)

- Banners: `resetTranscript()` installs a transcript already headed by
  the welcome line and startup warnings, so every rebuild (attach,
  `contextChanged`, `scanComplete`) keeps them at the top of the
  scrollback; the pass 5 "fetch-error banner after renderHistory" order
  stays for that one banner. The phase-1 claim that only the rescan's
  rebuild dropped banners was wrong: every rebuild did.
- `sessionAppended` carries the `SDKMessage` form of the appended entries
  (protocol v2): everything in the query stream is an `SDKMessage`,
  everything in the file stream a `SessionEntry`. `sdkMessageOfs`
  (protocol.ts) is the one place a client asks what an event contributes
  to the query stream; the fold observes them with `classOf`.
- `PendingMessage` is gone: pending messages are `SDKMessage`, and the
  dequeue echo is a user message the CLI should have echoed, so it
  renders through `append(user)` like any other — which now renders
  prompt text unless the frame is `isSynthetic` or `isReplay` (the CLI's
  own flags on the summary and command-output frames, events.jsonl
  150–151). `appendUserTurn` deleted. Phase 3 stamps the echo's uuid;
  until then the echo and the entry both render (accepted).
- The pending list stores every uuid-bearing query message (the spec's
  "three durable types" restated `!excludedFromSession` in a second
  place); the accepted loss is a partial whose `message_start` resolved
  behind an earlier block's frame.
- `renderHistory` renders the query session only, and of its path only
  the entries the merge has resolved (`merge.nodes` membership is the
  unresolved set): the merge exists because unresolved file-side entries
  and pending query messages cannot be interleaved.
- The fold skips every message with a string `parent_tool_use_id`
  (`stream_event`s included; the filter was user/assistant only):
  subagent traffic never meets an entry in this file. Per-subagent
  session models are the direction (docs/thoughts/subagent-activity.md).
- `lastEntryAtMs` stays monotonic; the `Date.now()` fallback for
  timestamp-less frames means a delta across a rebuild measures the
  replay (documented, untestable without clock injection). Anton
  suspects stamping only on a message's first arrival is the right rule;
  revisit with phase 3's uuid keying.

## 2026-09-19 — phase 1 review round 2 (Anton's TDC comments, 9ed62fa)

- Compaction summaries are identified by the anchor rule (Decisions), on
  both streams, and rendered as the summary component from whichever
  side arrives first. Suppressing the frame on `isSynthetic` hijacked an
  undocumented SDK flag and hid the summary until the entry landed (or
  for good, in a rebuild's pending replay): the user could not see what
  the assistant sees. The two compactions in Anton's session file
  (auto 2e3a8058/7825aa28, manual ca179e36/a64072b9) have identical
  entries — `isCompactSummary`, no `isSynthetic` anywhere in the file —
  so the "sometimes a plain user message" rendering was query-side
  (arrival order or a flag the auto path omits); the anchor rule removes
  both dependencies. All 78 boundaries in that file anchor at their
  summary or at themselves. `appendedEntryToSdkMessage` no longer sets
  `isSynthetic`; `entry.isCompactSummary` is no longer consulted.
- `sessionAppended` carries one message per event, in file order
  (boundary, then summary); `sdkMessageOf(event): SDKMessage |
undefined`.
- Startup warnings appear once, on the first attach
  (`reloadHistory(startupWarnings)`): they describe keybindings and
  settings as read at start, which a later rebuild may misstate. The
  welcome line still heads every transcript (`freshTranscript()`).
- Round 3 (93f5394): the reviewer showed the anchor rule is not a
  complete classifier for entries — a later boundary can preserve an
  earlier summary without its boundary (WORK-LOG P9 b-prefix; attested
  in Anton's file, `f3e4b1fa` → `2dac0aa6`), and the SDK documents
  boundaries without `preserved_messages`. Anton: entries use
  `isCompactSummary`; frames fall back to the anchor heuristic, holding
  only the last boundary frame's anchor (a single slot, not a set: the
  summary frame is always the next frame) and never treating any other
  user frame after a boundary as a summary. `queryStreamMessage` is
  `sdkMessageOf`: the function answers which SDKMessage an event
  carries, not whether the event is query-synchronized (most are).
- Deferred to phase 1.5 (Anton): entries join the trees only at
  resolution, so `pathToLeaf()` is the resolved path by construction
  (the `renderHistory` `merge.nodes` filter goes); file-side content
  renders at resolution through a two-part transcript (resolved part +
  query-pending part) so an entry omitted from a rebuild is rendered when
  it resolves; `SessionModels` passes the resolving entry to
  `onResolved`. Reviewer findings 1 (no re-delivery of omitted entries)
  and 2 (path minus unresolved is not a prefix under a relink) close
  there.
