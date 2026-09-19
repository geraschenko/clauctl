# Phase 1: the rebuild

> Work log for phase 1 of docs/specs/query-pending-list.md (Type Design,
> "Phase 1 — the rebuild"; Data Flow, "Phase 1"). Status: **implemented,
> awaiting review and commit**.

## Scope

Full entries on the wire, `SessionState.resolved`, one `SessionModel` per
session id under a `SessionModels` mirror of `AgentState.sessions`, the
transcript's render-once guard with keyed in-place replacement, and
`renderHistory()` as the one rebuild path (attach, `contextChanged`,
`scanComplete`). Queue ids stay numeric and `deliveredMessages` stays
(phase 3); the queue model's per-run dequeue is phase 2.

The spec's type design is fixed; this doc orders the work so the suite is
green after every step, and records what the plan learned on contact
with the code.

## Plan

Each step ends with `npm run check` and the affected tests green.

1. **Complete entries everywhere; the structural projection goes.**
   `session-tracker.ts` `push` emits and retains the complete entry
   (`byUuid` holds only entries deferred behind an absent anchor, so
   residency is unchanged in kind; see Implementation-Time Decisions).
   Deleted: `src/core/session/structural.ts` (+ its test),
   `scripts/diagnostic/structural-stats.ts`, and `LiveEntryFeed`'s twin
   join in `entry-sink.ts` — `tail.ts`/`prompt.ts` push `event.entry`
   straight to the sink and stop recording twins. The `push` doc comment,
   the `sessionEntry` comment in `protocol.ts`, and the wire descriptions
   in `docs/protocol.md` (l.152), `docs/stream-merging.md` (ll.76, 171),
   `docs/session-views.md` (l.63) say "complete". `session-tracker.test.ts`
   tracer: the reply event's entry equals `assistantEntry(reply, prompt)`.
   The old `SessionModel` (until step 4) loses its twin grafting — plain
   first-wins on the complete entry; `session-model.test.ts` drops the
   twin simulation (its rewrite is step 4).
2. **`SessionState.resolved`.** `session-state.ts`: the field and
   `freshSessionState` (`resolved: []`); `observe-on.ts`: return
   `resolved: [...session.resolved, ...resolved]`; `agent-state.ts`
   `nextAgentState`: clear `anomaly` and every session's `resolved` before
   folding (one helper `clearedForFold(state)` replacing the inline
   destructure — a sibling-free change inside agent-state.ts).
   `agent-state.test.ts`: the spec's cases (set by the resolving step,
   empty on the next; several resolutions in one step).
3. **Transcript render-once and keyed replacement** (`transcript.ts`):
   `renderedUuids`, `itemsByUuid`, `replaceContent(uuid, entry)`; stream
   ownership by API `message.id` recorded at `message_start`
   (`assistant` frame/entry finalizes only the matching stream; a keyed
   frame discards only a matching open stream); `append` records
   `assistant`, `system:compact_boundary`, `system:local_command_output`;
   `appendEntry` records every content-rendering entry (attachment under
   `source_uuid`); `append(user)` records nothing; `resetTranscript`/
   `conversation_reset` clear both maps. `transcript.test.ts`: the spec's
   render-once cases. Interactive mode is untouched in this step (its
   `releaseDedupeUuid` guard and the new guard agree).
4. **Models + interactive mode** (one step: the old `SessionModel` API
   disappears and its only consumer is interactive mode).
   - `session-model.ts` becomes the per-session class of the spec
     (`byUuid`, `queryMessages`, `attachmentBySource`, `trees`,
     `pushEntry`, `recordPending`, `retire`, `resetTrees`, `entryFor`,
     `pathToLeaf`, tree getters). `completedEntry` is no longer imported.
   - New `session-models.ts`: `SessionModels(onInvalid, onResolved)` with
     `observe`, `applySnapshot` (taking the state at the cut) and `get`;
     the snapshot hold stores `[event, state]` pairs (IMPLEMENTATION
     IDEAS).
   - `interactive-mode.ts`: `sessionModels` field; `handleEvent` →
     `sessionModels.observe(event, state)`; `applyEvent` split into
     `applyState`/`renderEvent`; `reloadHistory` passes the state at the
     cut and releases buffered events through `applyState` only, then
     `renderHistory()`; fetch-error banner after `renderHistory()`;
     `renderHistory()` per the spec (path → `appendEntry`; file session
     `queryMessages` → `append`; query session's when different;
     `deliveredMessages` tail last); `sessionFileChanged` →
     `resetTranscript()` only, `scanComplete` → `renderHistory()`;
     `onResolved` → `replaceContent` gated like `renderEvent`; `/tree`
     and rewind through `sessionModels.get(fileSessionId)`. Removed:
     `renderEntry`, `pendingContextChanges`, `replayedUuids`,
     `replayedBoundaryUuids`, the attach-point banner, the
     `leaf(this.agentState)` read and its `leaf` import.
   - Tests: `session-model.test.ts` rewritten against the new class (tree
     parity, first-wins, `entryFor` via attachment); new
     `session-models.test.ts` with the spec's routing/retire cases.
5. **`sdk-render.ts`**: delete `pathUpToBoundary`, `releaseDedupeUuid`,
   their five `sdk-render.test.ts` cases and the `TreeNodeRef`/
   `treeNodeRefsEqual` imports they alone used; the header comment of
   `scripts/tui-parity/render-session.ts` no longer names
   `pathUpToBoundary`.
6. **Docs**: `docs/architecture.md`/`docs/session-views.md` wherever they
   describe the TUI's attach cut or twin grafting; the main spec's WORK
   LOG. `npm run presubmit` (treefmt quirk: re-run once).

## Implementation-Time Decisions

- Interactive-mode tests (Anton, 2026-09-18): `InteractiveMode` takes a
  socket-backed `ProtocolClient` and a `TUI`; no harness exists. The
  spec's three `interactive-mode` cases are covered as far as they are
  pure — the snapshot cut before a switch in `session-models.test.ts`,
  the render-once guard in `transcript.test.ts` — and the fetch-failure,
  scan-window and attach-buffering paths by the manual smoke under
  Verification. A harness is a spec of its own (Deferred).
- The structural projection is removed outright (Anton, 2026-09-18),
  not just taken off the wire: with complete entries on the wire the
  `LiveEntryFeed` join and the client-side grafting are dead by
  construction, and the daemon's `byUuid` holds only the entries
  deferred behind an absent anchor (the anchor is the next line in the
  file, so the window is one flush). The pathological case — an anchor
  that never arrives — keeps the preserved block resident either way;
  complete entries make that block larger, not the bound different.
  `expectsSdkMessage` stays: the fold reads it and the event-hub dedup
  reads the index's class.
- Pending messages are plain `SDKMessage`s (Anton, 2026-09-19): the
  spec's `PendingMessage` union is gone. The dequeue echo is the user
  message the CLI never echoes, so it goes through `append(user)` like
  the rest; `appendUserTurn` is deleted and `append(user)` renders the
  compact summary when the uuid is the preceding boundary frame's anchor
  (the spec's summary rule; Anton, 2026-09-19 rounds 2–3 — `isSynthetic`
  was a hijacked, undocumented flag, and suppressing the frame hid the
  summary from the user; entries use `isCompactSummary`), else the turn under `firstRender(uuid)` unless the
  frame is `isReplay` (command output, whose entry renders the output
  attachment; stream-classification/captures/events.jsonl:151).
- `sessionAppended` carries the `SDKMessage` form of one appended entry
  per event, in file order (`appendedEntryToSdkMessage`, file.ts; the
  summary carries no marker — the summary rule identifies it),
  `PROTOCOL_VERSION` 2. The query stream is uniformly `SDKMessage`, the
  file stream uniformly `SessionEntry`; `sdkMessageOf(event)`
  (protocol.ts) is what the TUI records and renders live, whichever
  event carried it.
- The welcome line tops every scrollback (Anton, 2026-09-19):
  `resetTranscript()` installs a transcript already headed by it
  (`freshTranscript()`), so attach, `contextChanged` and `scanComplete`
  rebuilds all keep it. Startup warnings (keybindings, settings, version
  skew as read at start) show once: `reloadHistory(startupWarnings)` adds
  them to the first transcript before the fetch. Attach order: the
  warnings, the fetch (its failure banner lands under them), then the
  buffered events' state effects (`applyState`, incl. anomaly banners
  and the scan gate), then `renderHistory()` unless the release left a
  scan window open — its `scanComplete` rebuilds.
- The snapshot cut is awaited, not assumed (review, 2026-09-19):
  `eventsBefore` counts events pushed to the subscription queue, the
  buffer holds the ones the pump has delivered, and one socket read can
  push many events ahead of the response line. `reloadHistory` awaits the
  buffer reaching `eventsBefore` (`cutAwaiter`, resolved by
  `handleEvent`) before reading the state at the cut; no seed fallback.
- The scan gate lives in `applyState`, so a `sessionFileChanged` released
  from the attach buffer without its `scanComplete` gates the attach
  rebuild and the live entries that follow. Live, `handleEvent` runs
  `applyState` before `sessionModels.observe`, so `onResolved` reads the
  gate the event itself set.
- Attach inside a scan window happens only when a scan failed to start
  (`rescanNeeded`, tracked-session-log.ts): a vanilla attach is outside
  one — the startup scan precedes the protocol server, and a switch's
  `sessionFileChanged`/scan/`scanComplete` run in one synchronous gated
  segment that a `get-entries` response cannot interleave.
- The pending list stores every uuid-bearing query message (Anton,
  2026-09-19), not the spec's three durable types: that list restated
  `!excludedFromSession` (classification.ts) in a second place. An
  excluded type resolves once all its `query` predecessors have (merge:
  observed, closed, predecessors resolved), so the list is the query tail
  past the last file-settled message and the rebuild replays it through
  `append` as the live stream did. Partial output is reconstructed only
  when its `message_start` is still pending; a multi-block message whose
  earlier block's frame already pends (message_start and the first
  block's deltas resolved behind it, the later block's deltas wait on the
  frame) replays as the finalized earlier block, and the later block
  appears with its own frame — safe loss of a partial, not wrong output.
- `renderHistory` renders `querySessionId`'s session only (Anton,
  2026-09-19), and of its path only the entries the merge has resolved:
  `pathToLeaf()` minus the ids in `sessions[querySessionId].merge.nodes`
  (a node is in `nodes` iff unresolved, stream-merge.ts), then the
  pending query messages. The whole path would interleave unresolved
  file-side entries with pending query messages — exactly what the merge
  exists to prevent. Mid-switch the old file's path is not this
  conversation. Phase 1.5 removes the filter by feeding the trees only at
  resolution, and renders file-side content at resolution (an entry the
  filter omitted is otherwise never re-delivered: `onResolved` can only
  replace, not insert).
- The fold's subagent filter is any message with a string
  `parent_tool_use_id` (`stream_event`s included; it was user/assistant
  only): none of their ids can meet an entry in this file
  (fold-sdk-message.ts comment; direction in
  docs/thoughts/subagent-activity.md).
- Thinking-duration baseline (`lastEntryAtMs`) is monotonic (review,
  2026-09-19): a message's second arrival — its entry after its frame or
  the reverse — re-stamps, and must not move the baseline behind a later
  entry (`transcript.test.ts`, late second arrival). Only assistant
  messages carry a timestamp; the `Date.now()` fallback means a delta
  across a rebuild measures the replay, not the session (documented in
  `stampEntry`; no deterministic test without clock injection). Anton
  suspects stamping only on first arrival is the right rule; revisit with
  phase 3's uuid keying.
- Ordinary prompts render twice in this phase (Anton, 2026-09-19:
  accepted until phase 3): the dequeue echo (`append`, no uuid to claim)
  and the prompt's `sessionEntry` (`appendEntry`); on a rebuild, the path
  and the `deliveredMessages` tail. Phase 3's stamped uuid keys the echo.
- A dequeue that arrives during attach buffering or a scan window renders
  nothing at release (the rebuild's `deliveredMessages` tail shows a turn
  prompt); its `queuedById` entry goes stale. Accepted: the map leaves in
  phase 3.
- `/tree` with no file session yet (`fileSessionId` undefined) shows a
  warning banner instead of an empty selector.
- `pathToLeaf` on `SessionModel` returns the display path whose tail is
  the visible node carrying the context leaf; a relinked hidden leaf
  renders as the raw ancestors, then the boundary and summary
  (`session-model.test.ts`).

## Deferred

- An `InteractiveMode` test harness (fake `ProtocolClient`/`TUI`): the
  spec's fetch-failure and scan-window cases run as manual smoke until
  one exists.

## Verification

- Suite green after each step; presubmit green at the end.
- Manual smoke on an isolated config (`makeConfigDir`, never the real
  `CLAUCTL_DIR`): attach mid-turn, `/compact`, `/clear`, rewind — each
  assistant message renders once (prompts twice, see Implementation-Time
  Decisions), `stop_reason` errors appear on the entry's arrival.

# WORK LOG

- [x] Step 1 complete entries, structural projection removed (2026-09-18)
- [x] Step 2 `SessionState.resolved` (2026-09-18)
- [x] Step 3 transcript render-once (2026-09-18)
- [x] Step 4 models + interactive mode (2026-09-18)
- [x] Step 5 sdk-render removals (2026-09-18)
- [x] Step 6 docs + presubmit (2026-09-18) — `architecture.md`,
      `session-views.md`, `protocol.md` (resolved ids are no longer a
      planned follow-up), `tui-rendering-parity.md`; the
      `thoughts/fold-resolved-events.md` move to `old/` is phase 3's
- [x] Anton commits phase 1 (ae65bfe) + review comments (e93b5ae)
- [x] Review round (2026-09-19): banners in `resetTranscript`,
      `sessionAppended` messages + protocol v2, `PendingMessage` gone /
      `appendUserTurn` merged into `append(user)`, subagent filter,
      `renderHistory` query-session + resolved-path filter, boundary test
      coverage restored (`session-models.test.ts`)
- [x] Review round 2 (2026-09-19, 9ed62fa): frames render compact
      summaries too (`isSynthetic` unused), one `sessionAppended` per
      entry, startup warnings on first attach only
- [x] Review round 3 (2026-09-19, 93f5394): summary rule —
      `isCompactSummary` for entries, single-slot anchor heuristic for
      frames; `sdkMessageOf`
- [ ] Anton commits the review rounds
- [ ] Phase 1.5 spec: trees fed at resolution, two-part transcript
