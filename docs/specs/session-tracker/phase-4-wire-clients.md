# Phase 4: wire + clients

> Work log for phase 4 of docs/specs/session-tracker.md (IMPLEMENTATION
> IDEAS, "Wire + clients"). Status: **complete, step 5 awaiting
> review** (2026-09-13).

## Scope

Type design sections "Wire", "Deleted" (the client-side remainder);
Data flow 6; criteria 4 (tail/prompt `--until`), 5 (format annotation),
6 (the `uuids`/`full` payloads), 7 (trees from the stream, `/tree`
never refetches, the `queued_command` row), 11 (the TUI banner).

Already landed by phase 3 and not redone here: `contextChanged
{boundary, leaf}` (no `request`), `get-entries {since}`, handlers
served from the tracker through `payloads`/`readEntriesAt`, `seed.ts`,
the flush waits, slim, the "no-write rewinds" comment.

Not here (phase 5): docs/agent-events.md, status notes in the older
specs, the AGENTS.md bullet.

## Current state (survey 2026-09-13)

- Wire (`src/core/sdk-socket.ts`): `get-entries {since?}` →
  `SessionSnapshot {entries, leaf}` (the type lives in
  `src/core/tree/nodes.ts` and is consumed by `format/tree.ts`,
  `format/input.ts` — `clauctl format` accepts the get-entries document
  or bare JSONL); `get-context {at?}` → bare `SessionEntry[]`. No
  `payload`, no `uuids` variant, no `ContextSlice`.
- `request-handlers.ts` serves both from `tracker.payloads(...)`
  (`readEntriesAt`), so every call reads the served ranges; nothing
  serves identities without a read.
- `AgentObserver` (`src/core/agent-observer.ts`, 255 lines): used by
  `tail.ts` (live path, `history: "emit"`) and `prompt.ts` (`history:
"skip"`). It is the only consumer of `SessionEntryClient`
  (`entry-stream.ts`); `CanonicalEntryFilter` is also used by
  `session/messages.ts` and `format/command.ts` (offline) and stays.
- `tail.ts`: `UntilSettlement` (`consumedUuids`, `beginCatchup`,
  `CATCHUP_TIMEOUT_MS`) races the condition against a catch-up expiry;
  `--since` is resolved by reading the latest session file directly
  (`resolveSinceCursor`), for the dormant path as well as the live one;
  `tailDormant` prints the file; `tailEvents` uses the raw socket.
  `prompt --until` shares `UntilSettlement`. `until.ts` holds the
  conditions (unchanged by this phase).
- TUI (`src/tui/interactive-mode.ts`, 1242 lines): `reloadHistory`
  sends `get-entries` (no payload) and rebuilds `buildTree` →
  `toContextTree` → `toDisplayTree` from scratch; it runs at attach and
  on every `contextChanged`; `/tree` (`openTreeSelector`) fetches again.
  `sessionEntry`/`sessionFileChanged`/`scanComplete`/`trackerAnomaly`
  are ignored (the phase-3 stub). Rendering resolves payloads through
  `byUuid` (`sdk-render.ts`, `tree-selector.ts`). No anomaly banner
  (`addBanner` exists). No `queued_command` row anywhere;
  `DisplayTreeBuilder` has no attachment rule (attachments are not
  rows today).
- CLI (`sdk-commands.ts`): `get-entries --since`, `context --at`, no
  `--uuids`; uuid-prefix resolution (`sessionEntryUuids`) fetches the
  whole snapshot (complete entries) to read uuids.
- format (`format/events.ts`): `requestAnnotation` is still used by
  `controlApplied` (stays); `contextChanged` prints the boundary uuid
  only; the session-stream kinds print placeholder annotations.

## Plan

Each step leaves typecheck + suite green; `npm run presubmit` at the
end. Order: wire first (server + CLI, the smallest change and what
every client step builds on), then the two socket clients, then the
TUI, then rendering.

0. **Wire shapes + handlers + CLI.** sdk-socket.ts per the spec's Wire
   section: `get-entries {payload: "uuids" | "full"; since?}` →
   `GetEntriesResponse {uuids, entries?, leaf}`, `get-entries {uuids}` →
   `SessionEntry[]` (requested order; an unknown uuid is an error),
   `get-context {at?, payload}` → `GetContextResponse {refs, entries?}`.
   `SessionSnapshot` moves to sdk-socket.ts (it is the wire; format
   imports it and `parseSessionSnapshot` requires `entries` — a
   `"uuids"` document is not formattable). Handlers: `"uuids"` touches
   no file; `"full"` maps through `payloads` as today; `{uuids}` is
   `payloads(uuids)`. `set-context.ts` keeps its own `payloads` calls.
   CLI: `get-entries --uuids`, `context --uuids`, `sessionEntryUuids`
   sends `"uuids"`. Tests: request-handlers shapes; the read-count test
   (criterion 1) asserts `"uuids"` and `payload`-less prefix resolution
   read nothing.
1. **`tail`/`prompt` on the agent event stream; delete `AgentObserver`.**
   Live `tail --type entries|messages`: subscribe (events buffer),
   `get-entries {payload: "full", since}`, print the snapshot, skip the
   `sessionEntry` events received before the response, print live ones
   (`--type entries` prints what the wire carries; `--type messages`
   prints the `sdkMessage` twin for shared classes and the intact
   entry's message for session-only ones — `entry-sink.ts` adapts).
   `--since` on a live agent resolves through `get-entries {payload:
"uuids"}`; the dormant path (`tailDormant`, no daemon) keeps reading
   the file. `UntilSettlement` reduces to condition + `settled(state)`
   bounded by `SETTLE_TIMEOUT_MS` (the client's fold is the daemon's;
   `consumedUuids`/`beginCatchup`/`CATCHUP_TIMEOUT_MS` deleted; the
   `--until` order per Data flow 6). `prompt` subscribes on the raw
   socket and folds; `--type entries|messages` stays live-only. Delete
   `agent-observer.ts` and, with it, `SessionEntryClient` (see open
   question 3). tail.test.ts/prompt tests move to the socket harness.
2. **TUI trees from the stream.** `InteractiveMode` owns
   `byUuid: Map<UUID, SessionEntry>` (snapshot entries, then whatever
   each live `sessionEntry` carries) and `sdkMessages: Map<UUID,
SDKMessage>` keyed by entry uuid, feeding one `DisplayTreeBuilder`
   composed over `SessionTreeBuilder`/`ContextTreeBuilder` (phase 1's
   builders; the one-shot functions leave the TUI). Attach handoff per
   Data flow 6: `sessionFileChanged` before the response resets the
   model; `sessionEntry` before the response is not pushed; snapshot
   applied; live pushes afterwards. `reloadHistory` becomes the
   attach-time fetch only; `contextChanged` and `/tree` read local
   state (`TreeSelectorComponent` takes the live display tree +
   `byUuid`). Rendering checks entry (history), SDK message (live
   shared), intact entry (live session-only). Test (criterion 7): after
   attach no `get-entries` is sent by `/tree` or `contextChanged`; the
   live tree after N events equals `toDisplayTree` over the same
   entries.
3. **The `queued_command` row.** A `queued_command` attachment becomes
   a display-tree row rendered as the user message it was, after the
   tool result it rode on, live and from history alike. This is a
   `DisplayTreeBuilder` rule (tree/, not TUI): the attachment entry is
   not a row today, and the one-shot `toDisplayTree` must agree so the
   corpus equivalence test (criterion 2) keeps holding. Derisk against
   docs/derisk/uuid-stamping/ before coding (open question 4).
4. **Anomaly banner + format rendering.** TUI: `state.anomaly` latches
   into a banner (`addBanner`) on every fold that carries one
   (criterion 11). `format/events.ts`: `contextChanged` annotates from
   the boundary's `compactMetadata` — the event carries `{boundary,
leaf}`, so the formatter keeps the `compactMetadata` of the last
   `compact_boundary` `sessionEntry` it saw (structural entries keep
   it intact); `sessionEntry` renders for `tail --type events` (which
   fields: open question 5). `requestAnnotation` stays for
   `controlApplied`.
5. **Sweep.** Stale comments (`tree/nodes.ts` "seedFromEntries",
   `entry-stream.ts` "cross-file follower (AgentObserver)"), spec
   checklist, criteria 4–7/11 re-read against the code, presubmit,
   smoke: spawn → attach → prompt → `/tree` → set-context → `tail
--since` → `/clear` (tree reset on `sessionFileChanged`).

## Open questions (resolve before the step that needs them)

1. (step 1) Dormant/archived `tail` keeps reading the session file
   directly — "tail never revives", and there is no daemon to ask.
   Anton: yes. Reader: `readSessionEntries` + `CanonicalEntryFilter` as
   `tailDormant` does today, not a `SessionLogFollower` — a dormant
   agent has no writer, so fs.watch and byte offsets buy nothing.
   Anton: confirmed.
2. (step 0) `SessionSnapshot` moves from `tree/nodes.ts` (where it sat
   since the initial commit, beside the tree types its `leaf` uses) to
   `sdk-socket.ts`, with the other response shapes and where the spec's
   Wire section puts it; `format/input.ts` narrows to `entries`
   present. Anton: confirmed.
3. (step 1) `SessionEntryClient` (+ its tests) is deleted with
   `AgentObserver`, its only consumer; `CanonicalEntryFilter` and
   `SessionLogFollower` stay. Anton: yes.
4. (step 3) The `queued_command` row is in this phase. Anton: yes.
5. (step 4) `tail --type events` prints a `sessionEntry` as a one-liner
   `[entry <uuid> <type/subtype> expectsSdkMessage leaf]`, no payload
   (the SDK twin prints it). Anton: yes.

## Implementation-Time Decisions

- (step 0) `format tree` does not take the wire `SessionSnapshot`:
  `parseSessionSnapshot` also produces its input from raw JSONL, where
  `uuids` has no meaning, and the renderer never reads `uuids`. format
  has its own `SnapshotDocument {entries, leaf}` (`format/input.ts`);
  a get-entries document is accepted with `uuids` ignored and
  `entries` required (a `"uuids"` document is a UsageError as before —
  no `entries`). Open question 2's "format narrows to `entries`
  present" is realized as this type rather than as a narrowed wire
  type.
- (step 0) `payload` is validated server-side (`parseEntryPayload`,
  `ENTRY_PAYLOADS`) like the other enum-valued request fields; the
  `{uuids}` variant is distinguished by the `uuids` key.
- (step 1) The Data flow 6 handoff is a client-side count:
  `SdkSocketClient.requestWithEventCount` returns the response with the
  number of events queued before it (`eventsBefore`); a subscriber
  skips `sessionEntry` events up to that position — they are in the
  snapshot. No wire change.
- (step 1) `SETTLE_TIMEOUT_MS` and `describeSession` moved from
  event-hub.ts to agent-state.ts: settledness is the state's concept,
  and the client's `UntilSettlement` bounds its wait by the same
  constant the daemon's `whenSettled` uses.
- (step 1) `LiveEntryFeed` (entry-sink.ts) does the `--type messages`
  joining: a shared-class user/assistant `sessionEntry` waits for its
  `sdkMessage` twin (the twin's `message` and `tool_use_result` are
  grafted onto the entry), entries behind it wait with it (file
  order), and `end()` flushes what is still waiting as it is. `--type
entries` passes the wire's entry through.
- (step 1) tail keeps first-wins dedup across a rollover on the client
  (`emittedUuids`: the snapshot's uuids plus every live uuid printed)
  — the daemon re-emits an entry the new file re-persists, and the
  spec's dedup is the printer's.
- (step 1) `sessionEntryUuids` (sdk-commands.ts) is exported for tail's
  live `--since` prefix resolution; a full uuid passes through to the
  daemon's cursor check unresolved.
- (step 1) `prompt`'s messages/entries leg subscribes on the raw socket
  and submits after the subscription is established (the dequeue cannot
  be missed); `sdkMessage` twins are recorded before the gate opens
  because the query side may lead the log across it.
- (step 2) The TUI's entries, payloads, trees and the Data flow 6 cut
  live in `SessionModel` (`src/tui/session-model.ts`), not in
  `InteractiveMode`: `observe(event)` counts socket positions and holds
  session-stream events until `applySnapshot(entries, eventsBefore)`
  says which of them the snapshot already contains; the cut is thus
  testable without a TUI harness (none exists). Criterion 7's "no
  `get-entries` from `/tree` or `contextChanged`" holds by construction
  — both paths read the session model, which holds no client — rather
  than by a test.
- (step 2) One entry map, not the plan's `byUuid` + `sdkMessages` pair:
  an `sdkMessage` twin is grafted into its entry (`completedEntry`, moved
  from entry-sink.ts to `session/structural.ts` as the projection's
  inverse; tail's `LiveEntryFeed` uses the same function), twins whose
  entry has not arrived wait in a private map. Every consumer
  (`TreeSelectorComponent`, `resolveTreePick`, `pathUpToBoundary`,
  `TranscriptRenderer.appendEntry`) already takes `ReadonlyMap<UUID,
SessionEntry>`, so rendering "checks entry, SDK message or intact
  entry" collapses into one lookup.
- (step 2) `byUuid` survives `sessionFileChanged`; only the trees are
  rebuilt. `/fork` re-persists the old file's entries, structural on
  the wire for shared classes, and their payloads (history-fetched or
  twin-grafted) exist nowhere else in the TUI. An entry is immutable
  per uuid, so the retained map is a payload cache the new trees index
  into. Deviates from Data flow 6's "resets its model" wording — flagged
  for review.
- (step 2) `contextChanged` redraws synchronously from the session model
  (`resetTranscript` + `renderHistory`); the attach reload no longer
  re-enters on a buffered `contextChanged`. `replayedUuids` is defined
  only during the release loop (a redraw inside the loop adds to it, a
  live redraw's additions are inert); `pendingContextChanges` counts the
  buffered redraws still to come, replacing the "buffered contextChanged
  pending" scan for the missing-attach-point banner. A failed history
  fetch applies an empty snapshot at position 0, so the trees still grow
  from every live event.
- (step 3) No `DisplayTreeBuilder` rule: the capture
  (docs/derisk/uuid-stamping/captures/session.jsonl) shows the
  `queued_command` attachment already on the raw chain (`tool_result ←
attachment ← …`), and the context tree keeps attachment entries, so
  it is a display-tree occurrence today (`format tree --filter all`
  lists it as `·`). The plan's "not a row today" was the filters and
  renderers ignoring it. Criterion 2's one-shot agreement is untouched.
- (step 3) `queuedCommandPrompt(entry)` (session/file.ts) is the one
  reading of the attachment shape; `isPromptEntry` (format/tree.ts:
  human prompt or steered prompt) drives the user-only/conversation/
  picker filters and the `❯` glyph; `entrySummary` labels it with the
  prompt. Picking it rewinds to its own uuid (the pre-existing
  "attachment → itself" rule), not to its parent with editorText as a
  human prompt does: the parent is a tool result, and re-sending from
  there is untested.
- (step 3) Live rendering: the `sessionEntry` case renders a
  `queued_command` entry through `TranscriptRenderer.appendEntry` (the
  history path), release-deduped by `replayedUuids` like an sdkMessage;
  `userMessageDequeued {delivery: "steer"}` no longer echoes the message
  (it would render twice). The steered prompt therefore appears at the
  attachment's file position, a moment after the pending-area preview
  drops. `deliveredMessages` still excludes steers (agent-state.ts
  comment updated to the current reason).
- (step 4) The banner reads `state.anomaly` at the top of
  `applyEvent`, not the `trackerAnomaly` case: a sessionEntry fold
  raises anomalies too (`withAnomalies`), and `nextAgentState` clears
  the field before every fold, so one read per event shows each
  anomaly once. Buffered events replay through `applyEvent`, so an
  anomaly during history replay still banners. No InteractiveMode
  harness exists; the banner is unit-untested.
- (step 4) `contextChanged` annotates from a `boundaryMetadata` map
  keyed by boundary uuid (`FormatState`, beside `queuedMessages`),
  filled at each `compact_boundary` sessionEntry, rather than "the last
  boundary seen": the event names its boundary, so the lookup is exact
  and a deferred anchor cannot mislabel it. Reading `compactMetadata`
  is one function, `compactionMetadata` (session/file.ts), shared with
  `CanonicalEntryFilter`.
- (step 4) The `sessionEntry` and `contextChanged` lines bypass
  `annotation()`'s 80-char truncation: two uuids already exceed it and
  nothing in them is free text. Shape: `[entry <uuid> <type/subtype>
sdk twin|session-only leaf <uuid|none>]`, `[context changed: boundary
<uuid>, <trigger>, <n> preTokens]`.

## WORK LOG

- 2026-09-13: survey of the client code (Current state above); plan
  drafted; open questions 1–5 posed and resolved (Anton, b59061b and
  chat). Status → implementing step 0.
- 2026-09-13: step 0 done. Wire: `EntryPayload`, `SessionSnapshot`
  (moved from tree/nodes.ts), `ContextSlice`, the three request
  variants in sdk-socket.ts; handlers serve `"uuids"` from the index
  without a read. CLI: `get-entries --uuids`, `get-context --uuids`
  (prints node refs one per line), `sessionEntryUuids` sends
  `"uuids"`. TUI sends `payload: "full"` (still rebuilds; step 2).
  Tests: read-count test asserts both `"uuids"` calls read zero bytes
  and `{uuids}` reads exactly the requested line; shape tests updated.
  Presubmit green.
- 2026-09-13: step 1 done. tail/prompt on the agent event stream:
  `requestWithEventCount` (sdk-socket.ts), `LiveEntryFeed`
  (entry-sink.ts), `UntilSettlement` reduced to latch + `settled`
  bounded by `SETTLE_TIMEOUT_MS` (moved to agent-state.ts with
  `describeSession`), `tailLive`/`promptLive`. Deleted
  `agent-observer.ts`, `SessionEntryClient`/`EntryClientOptions`/
  `EntryStreamState` and their tests; `CATCHUP_TIMEOUT_MS`/
  `resolveSinceCursor`. tail.test.ts's fake daemon answers get-entries
  (both payloads) and writes live events after the snapshot response;
  new tests: live prefix `--since`, settle-after-catch-up, rollover
  dedup from `sessionFileChanged` + re-persisted `sessionEntry`, the
  settle-deadline message. prompt.test.ts's messages leg feeds
  `sessionEntry` events instead of appending to the file. Presubmit
  green. docs/claude-agent-sdk.md still names AgentObserver (phase 5).
- 2026-09-13: review round (b2d02b1). Anton renamed the response types
  `SessionSnapshot`→`GetEntriesResponse`, `ContextSlice`→
  `GetContextResponse`, `SetContextResult`→`SetContextResponse`
  (earlier names in this file's plan/log are as written at the time);
  comments, session-tracker.md's Wire section updated. request-handlers:
  `isGetEntriesByUuids` type guard, `includeEntries` boolean.
  `eventsBefore` under discussion (AsyncQueue pushed-count).
- 2026-09-13: `eventsBefore` resolved: pictl added
  `AsyncQueue.pushedCount` (synced); `eventsQueued` deleted.
- 2026-09-13: step 2 done. `SessionModel` (session-model.ts + tests:
  live trees after N events equal `toDisplayTree` over the same entries,
  twin-before/after-entry grafting, the snapshot cut with a
  `sessionFileChanged` and entries before it, trees rebuilt over
  retained entries after a switch). `InteractiveMode`: `handleEvent`
  feeds the session model first; `reloadHistory` is the attach fetch via
  `requestWithEventCount`; `renderHistory`/`resetTranscript` split out;
  `contextChanged` and `/tree` synchronous over the session model
  (`treeSelectorPending` gone; `confirmTreePick(pick)` resolves on the
  session model's context tree at pick time). `buildTree`/
  `toContextTree`/`toDisplayTree`/`entriesByUuid` no longer imported by
  the TUI. Presubmit green. Step 3 touches step-2 code (the attachment
  row renders through the session model's entries), so it waits for
  review.
- 2026-09-13: review round (049b145). Anton renamed `completedFrom`→
  `completedEntry` and `nearestVisibleRow`→`nearestVisibleNode` (specs
  and `pathUpToBoundary`'s parameter follow). `InteractiveMode.model`→
  `sessionModel` (AGENTS.md: long-lived variables named after their
  type); `renderHistory`'s comment now says why the path runs to the
  session model's leaf and is cut at the state leaf, and the "no
  duplicates on a display path" claim is gone (a visible relinked
  occurrence repeats a uuid). `/tree` keeps the session model's leaf:
  `leaf(agentState)` is the query-side leaf, which names an entry not
  yet in the tree while the query leads the file. Noted, unchanged:
  the same query-side leaf can be absent from the attach snapshot's
  path, so the "attach point not found" banner can be spurious at
  attach (pre-dates step 2).
- 2026-09-13: step 3 done. Derisk: the uuid-stamping capture rendered
  with `format tree --filter all` — the attachment is already a
  display-tree occurrence, so no builder change (decision above).
  `queuedCommandPrompt` (file.ts); format/tree.ts filters, glyph,
  summary; `TranscriptRenderer.appendEntry` renders it as a user turn;
  `InteractiveMode` renders the live `sessionEntry`, release-deduped,
  and drops the steer dequeue echo. tree-presentation.md glyph
  paragraph updated. Tests: tree.test.ts (❯ row + label under
  picker/conversation/user-only; another attachment stays `·` under
  all), transcript.test.ts (attachment renders / renders nothing).
  Verified on the capture: `--filter picker` shows `❯  83f9b5d0 Also
say the word QUEUED.` Presubmit green. Step 4's banner lands in
  `applyEvent`, which step 3 edited, so it waits for review.
- 2026-09-13: step 4 done (Anton: review 3 and 4 together). TUI banner
  from `state.anomaly` in `applyEvent`; `format/events.ts` renders
  `sessionEntry` (open question 5) and annotates `contextChanged` with
  the boundary's trigger/preTokens; `compactionMetadata` extracted to
  session/file.ts; `classOf` exported from agent-state.ts. Tests:
  events.test.ts (metadata after a seen boundary entry, plain boundary
  for an unseen one; identity line untruncated). Presubmit green.
- 2026-09-13: review round 88b4f5b (steps 3–4). `MessageControl`'s
  compaction variant is `{ kind: "compaction" } & CompactionMetadata`,
  making the metadata reader's field set the variant's. events.ts
  comment softened (session-only entries may render later). The
  `picker` filter mode, `passesFilter`'s `isFinal` argument,
  `collectFinalAssistantIds` and `isFinalAssistantEntry` are deleted:
  the final-assistant restriction served no-write rewinds, which are
  gone; `/tree` now uses `conversation` (tree-presentation.md updated;
  the older tui-tree.md / boundary-display-linearization.md keep their
  historical text for the phase-5 status notes). Rewinding to a
  steered row without editorText confirmed correct. Live session-only
  render order: question answered in chat, follow-up spec proposed
  (docs/follow-ups/transcript-order.md).
- 2026-09-13: step 5 done. Sweep: `tree/nodes.ts` treeNodeRefsEqual
  comment named the deleted seeding path (fixed); the entry-stream.ts
  AgentObserver mention was already gone. Criteria 4–7/11 re-read
  against the code. Presubmit green. Smoke against a live haiku agent
  (scratch CLAUCTL_DIR): spawn → prompt ×2 → `get-entries --uuids` /
  `format tree` → `set-context --rewind-to` (boundary returned, tree
  forks) → `tail --type entries --since` (starts after the given
  uuid, ends at the boundary) → `tail --type events` shows
  `[entry … compact_boundary sdk twin …]` then
  `[context changed: boundary …, manual, 14672 preTokens]` → attach:
  `/tree` picker lists the conversation rows → `/clear`: "conversation
  reset" banner, `/tree` shows "(no matching entries)", `get-entries`
  returns the new session's 3 uuids. Noted: a session `mode` entry
  has no uuid and prints as `[entry ? mode session-only …]`.
