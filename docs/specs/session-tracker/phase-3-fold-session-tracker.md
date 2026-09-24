# Phase 3: fold + session tracker + daemon composition

> Work log for phase 3 of docs/specs/session-tracker.md (IMPLEMENTATION
> IDEAS, "Fold + session tracker"). Status: **complete** (2026-09-13;
> review round f0f5137's changes uncommitted); phase 4 continues in
> phase-4-wire-clients.md;
> **redesigned 2026-09-12** before step 1 — read redesign-2026-09-12.md
> first (its WORK LOG records step 1b).

## Scope

Type design sections "Agent events", "Agent state" (+ fold rules),
"Session tracker", "Event hub"; Data flow 1–5 and 7; the merge model's
dedup, anomalies and recovery. The daemon follows the log from startup
on, folds both streams through one `AgentState`, and serves requests
from the tracker. Deleted here: `seed.ts`, `waitForEntry`,
`readEntriesAfterStreamFlush`, top-level `AgentState.sessionId`/`leaf`/
`lastUsage`/`model`, `contextChanged.request`.

Not here (phase 4): the request/response wire shapes (`payload`,
`since`, `uuids`, `ContextSlice`, `entryPayload`), per-variant sink
serialization, `AgentObserver` deletion, `tail`/`prompt`/TUI/CLI
rewrites, the anomaly banner. Phase 3 keeps `get-entries`/`get-context`
returning today's shapes (complete entries) but served from the tracker.

## Plan

Each step leaves typecheck + suite green.

0. **Stubs, then tracer** (implement.md). Every phase-3 signature from
   the spec's Type design compiles with placeholder bodies
   (`AgentEvent`, `SessionState`/`TrackerAnomaly`/`initialAgentState`/
   `querySession`/`leaf`/`sessionSettled`/`settled`/`nextAgentState`,
   `SessionTracker`, `TrackedSessionLog`, `EventHub` surface,
   `AnomalyRecorder`). Then one end-to-end pass on a temp file:
   follower → `SessionTracker.push` (entry + range only) → `hub.emit`
   → sinks, before the pieces are filled in. (Done with full/slim
   sinks; reshaped per the redesign in step 1b.)
1. **Classification.** `excludedFromSession(message)` in
   agent-state.ts from the table (`excludedFromQuery`, incl. the
   `<local-command-stdout>` shared row, landed in 1b); unit test from
   docs/derisk/stream-classification/captures (events.jsonl +
   session.jsonl, the recorded pair) — the same pair is the
   merge-equivalence fixture in step 2.
   1b. **Redesign reshaping** (done 2026-09-12; log in
   redesign-2026-09-12.md). `slim.ts` → `structural.ts`
   (`PAYLOAD_PATHS`, `structuralEntry`; slim limit/`truncated`
   deleted), `sessionEntry {entry, expectsSdkMessage, leaf, lastAssistant?,
awaitingAnchors}`, hub single sink set, tracker `index` + per-class
   event shape, `ContextTreeBuilder`'s per-assistant usage/model
   record, tracer test asserting both shapes and that no entry stays
   resident. Builder `byUuid` pruning moves to step 3 (no builders in
   the tracker before then; see the report's decisions).
2. **Types + fold.** `AgentEvent` replaces `SdkEvent` (sdk-socket.ts);
   `SessionState`, `TrackerAnomaly`, `MergeStream`, `initialAgentState`,
   `querySession`, `leaf`, `sessionSettled`, `settled`; `nextAgentState` with
   the merge calls, routing by `session_id`/`fileSessionId`, scan
   exclusion, pending leaf, one anomaly per fold by precedence, the
   same-id rescan rebuild. agent-state.test.ts reworked; merge-
   equivalence test (criterion 3): fold the recorded pair, every id
   resolves, settled, no anomaly.
3. **`SessionTracker`** (session-tracker.ts): first-wins push → index
   (range + class) + `SessionTreeBuilder`/`ContextTreeBuilder` push on
   observation + prune consumed entries, `leaf`, `lastAssistantOn`,
   `awaitingAnchors`; `push` returns the `sessionEntry` (intact or
   structural by class) then one `contextChanged` per completed
   boundary (own or anchored — diffed against the builder's
   `awaitingAnchors` before/after); `uuidsAfter`, `payloads`,
   `contextAt`, `index`, `contextTree`. Unit tests incl. the
   deferred-anchor (up_to) case and residency after push.
4. **`EventHub`.** `subscribe(sink)`, one sink set; `emit` widened to
   `sessionEntry`/`contextChanged`; tracker slot; `observeSdkMessage` dedup (byUuid
   hit + no merge node → duplicate / `classification`);
   `whenSettled`/`whenFileSettled` (waiters re-checked after
   every fold; `SETTLE_TIMEOUT_MS`); anomaly reporting: log at error +
   bundle via `AnomalyRecorder` (`anomaly-<timestamp>.json`,
   `ANOMALY_CONTEXT_EVENTS` ring). Tests.
5. **`TrackedSessionLog`** (tracked-session-log.ts) + daemon.ts
   wiring. The class owns the follower + tracker pair: `start(seed)`
   emits `sessionFileChanged` and builds them on the seed file when it
   exists (scan → `scanComplete`),
   the switch worker (Data flow 3) incl. the failure rescan and
   `whenFailed` race, `awaitFileExists` (moved out of
   agent-observer.ts). daemon.ts: `initialAgentState()` + settings
   cascade, construct
   the hub with `tracker: () => trackedLog.tracker`, start the log,
   shutdown: exclusive gate → drain → `shutdown` → close. Delete seed.ts
   (format/input.ts's raw-JSONL leaf derived locally via
   `toContextTree`). Tests on a temp file.
6. **Requests on the tracker.** `get-entries`/`get-context`:
   `whenSettled` outside the gate, shared gate, take tracker, re-check.
   set-context: exclusive gate, validate on the tracker, teardown,
   append, `sessionAppended`, `drainVisibleBytes`, restart; failures
   after teardown → `setQueryAvailable(false)`; the handler's
   `contextChanged` emit deleted. Delete `waitForEntry`/
   `readEntriesAfterStreamFlush`. request-handlers.test.ts /
   set-context.test.ts move to a real tracker + follower on a temp file.
7. **Client fix-ups (mechanical only).** tail/prompt/AgentObserver/
   TUI/format compile against `AgentEvent` and the new state shape
   (`leaf(state)`, `querySession(state)?.lastUsage`, `querySessionId`);
   no behaviour redesign (phase 4).
8. **Criteria.** Read-count test (criterion 1) over get-entries/
   get-context/set-context; memory measurement script on the 167 MB
   fixture (criterion 10, a script like slim-stats, not a unit test);
   one test per anomaly kind showing the tracker settles afterwards
   (criterion 11). Presubmit.

## Implementation-Time Decisions

### `model`/`permissionMode` stay top-level as the next-query prediction

The spec moves `model` into `SessionState`, but daemon.ts seeds the
top-level `model` from `persistedOptions.model ?? settings.model` and
`controlApplied set-model` folds into it — "what the NEXT query uses"
— and deliberately does not take `permissionMode` from the file. So:
top-level `model`/`permissionMode` keep today's seeding and fold
(init, set-model, status); `SessionState.model` is file evidence only
(`lastAssistant`), used as the display fallback
`state.model ?? querySession(state)?.model`; `permission-mode` entries do
not fold into the top-level field. Anton (2026-09-11): agreed.

### Anomaly bundles live in their own module

`src/core/daemon/anomaly-bundle.ts` owns the trail ring and the bundle
write; the hub delegates. Anton (2026-09-11): agreed.

### Phase-3 wire: every subscriber gets the per-class shape

`tail --type events` prints `sessionEntry` events meanwhile; the
request shapes (`payload: "uuids" | "full"`) are phase 4. Anton
(2026-09-11, revised 2026-09-12): acceptable.

### Redesign (2026-09-12)

Superseding the "One event stream, two sink sets" decision below:
there is one sink set and no slimming; a `sessionEntry` carries the
intact entry for session-only classes and `structuralEntry(entry)` for
shared ones. Rationale, evidence and the effect on step-0 code:
redesign-2026-09-12.md. Anton: approved the spec edits.

### Missing resume file at startup

No tracker/follower until the first `system/init` names a file (as the
`existsSync` seed check does today); the switch's `awaitFileExists`
covers later files. Anton (2026-09-11): agreed.

### The tracker is owned by `TrackedSessionLog`, not the hub

`SessionTracker` knows one file (ranges are offsets into it), so it is
replaced with the follower at every switch. The hub emits the whole
agent event stream and is not bound to a file, so it does not own the
tracker; `src/core/daemon/tracked-session-log.ts` (`TrackedSessionLog`: follower +
tracker pair, startup scan, switch worker, `awaitFileExists`) does,
and the hub reads the tracker only at the dedup site through a
`tracker()` dependency. Spec updated (Tracked log section; Data flow
3–5; the dedup note). Anton (2026-09-11): agreed after clarifying
tracker vs `AgentState.sessions` (merge bookkeeping, plain data).

### Session-file modules: `session/` is the format, `daemon/` is the policy

Recorded in the spec's Type design, "Module layering" (the "needs a
daemon or not" test). Anton (2026-09-11): keep it in the spec for the
post-project architecture review.

### Pre-implementation spec fixes (2026-09-11)

Found reviewing Type design against implement.md and daemon.ts; all
written into the spec's stable section with Anton's approval:

- **Stubs first, then a tracer bullet** (plan step 0) instead of the
  bottom-up order first drafted. Anton: agreed.
- **Startup seeding.** `initialAgentState()` takes no session id and
  creates no file; `TrackedSessionLog.start(seed)` emits
  `sessionFileChanged` when the seed file exists and the fold creates
  a missing `SessionState` there. Reason: the state function cannot know
  whether the file exists, and the fold rule assumed a query message
  had always created the `SessionState` first. Anton: agreed.
- **`EventHubOptions` and `AnomalyRecorder`** were unspecified; added.
  The ring constant is `ANOMALY_CONTEXT_EVENTS` — it holds recent
  events of both streams as reproduction context, not anomalies.
- **One event stream, two sink sets; `observeSessionEntry` dropped.**
  A draft gave sinks a second `slim?` argument and a `deliver: (sinks,
event, slim?)` option; Anton: nonsense — a session entry is a _kind_
  of `AgentEvent`, not a sidecar, and `deliver` stays the turnQueue
  push (user/SDK messages go through `deliverUserMessage`/
  `observeSdkMessage` so the queue model sees them — the SDK does not
  report when user messages enter context; everything else through
  `emit`). So: `sessionEntry` is `{kind, leaf, lastAssistant?,
awaitingAnchors} & SlimProjection` (flat, `SlimProjection` defined in
  slim.ts per TDC), `SessionTracker.push` returns the events to emit
  (`sessionEntry`, then its `contextChanged`s), `TrackedSessionLog`
  forwards them to `emit`, and `subscribe(sink, entries: "full" |
"slim")` picks the sink set; the hub slims once per event for the
  slim set (a second ~3 µs walk beside the tracker's residency slim;
  not worth threading the tracker's projection through). The fold
  reads only structural fields, so daemon (complete) and slim
  subscribers fold identically. A future "none" set (no entry events)
  would fold stale file state; not designed now.
- **Query-side values win.** `claudeCodeVersion` joins `lastUsage`/
  `model` under the settled-only guard for session entries;
  `permission-mode` entries do not fold (`permissionMode` is
  query-side only). Same principle as the leaf: a lagging entry never
  overwrites a fresher query value. Anton: agreed.

### Step-0 residue kept until its step

Top-level `AgentState.sessionId`/`leaf`/`lastUsage` and their
`contextChanged`/`sdkMessage` fold clauses stay until step 7 (their
consumers are the mechanical fix-ups; removed there); `seedFromEntries`
stays until step 5 (removed there). set-context's `succeeded` flag is redundant with the appended
boundary (it is only ever set after the append) — left as is, not this
phase's concern. format/events.ts renders the new kinds as placeholder
annotations (`sessionEntry` prints nothing: its SDK twin renders) and
the TUI ignores them; phase 4 owns both. `SessionTrackerEvent`
(session-tracker.ts) names `push`'s element type — an alias, not a new
concept.

### Subagent query traffic stays outside the merge (step 2)

The spec's sdkMessage rule observes "every uuid-bearing query item",
but subagent `user`/`assistant` messages (`parent_tool_use_id` set)
carry uuids and a shared class while their entries never reach the
main file: in the local corpus (349 files, CLI 2.1.1–2.1.3) no main
session file holds an `isSidechain: true` entry and 203
`<session>/subagents/` directories exist. Observing them would pend on
`session` forever, so the fold keeps today's early return before any
merge call; the messages still reach sinks. Anton (2026-09-12): agreed;
spec sentence added under "Fold rules", subagent state tracking noted
in docs/follow-ups/subagent-activity.md as a per-subagent-file merge.

### Fold mechanics not spelled out by the spec (step 2)

- `anomaly` is stripped at the top of every fold, so "cleared on the
  next fold" holds for every event kind, including the no-op ones.
- The scan-exclusion clearing ("a session observation finding the
  node already present") also fires for nodes `sessionAppended` put
  there — correct, those are live appends.
- `SessionState.model` takes the assistant message's `message.model`
  (per-file evidence); the top-level `model` stays the next-query
  prediction.
- Anomaly detail is `kind: detail; kind: detail` over every condition
  the fold hit; observation details read `class uuid on stream: merge
message`, rescan/append observations use the class names `rescan`/
  `appended` (the fold has no message there).
- A `sessionEntry` before any `sessionFileChanged` (no tracked file) is
  ignored; `TrackedSessionLog` never emits that order.

### Requests on the tracker (step 6)

- `settled` means "the file has caught up to the query"; with no
  query file (`sessions[querySessionId]` undefined — nothing has happened
  on the session yet) nothing can be pending, so `settled` is
  vacuously true rather than false as the spec's helper had it. The
  handlers then need no pre-settle guard: `whenSettled` resolves at
  once and a missing tracker yields the empty snapshot / `[]` /
  "set-context: no session yet" (there is no session id to name a
  file with, so even a clear-all boundary has nowhere to go).
- Cold revival (spec Data flow 1: "the post-scan state is the seed —
  settled, leaf = treeLeaf") holds only if `querySessionId` is the seed
  session; daemon.ts now seeds `querySessionId: seedSessionId` (the
  `sessionId` residue line stays until step 7). A seed id whose file is
  missing leaves `querySession` undefined → empty responses until the
  query's first message announces the file (fine; the switch worker
  opens it).
- set-context validation is unchanged (spec non-goal), and
  `normalizePreservedUuids` needs every entry's tool ids / message id,
  which the tracker does not index → set-context reads the complete
  canonical entries by range (`tracker.payloads(tracker.uuidsAfter(
  undefined))`: one get-entries-full's cost per set-context, no tree
  rebuild); `tracker.contextTree` serves `contextAt`/`matchPreservedList`.
- Mid-switch (`querySessionId ≠ fileSessionId`) set-context is
  REJECTED with "session switch in progress; retry". Accepting would
  be wrong: the boundary is appended to the tracked (old) file and
  the query resumed on that id, abandoning the file the query already
  moved to. The window is transient (settle + quiet window), so a
  retry is honest. Target and resume id = `fileSessionId`.
- The settle-then-acquire loop (Data flow 4/5) is one helper in
  request-handlers.ts, `acquireSettled(events, acquire)`: `whenSettled`
  → acquire → re-check `settled(state)` → else release and repeat.
  set-context gets it as `SetContextShared.acquireSettledExclusive()`
  (replacing `gate` there) rather than importing the helper — the two
  modules already import each other's types, no value cycle wanted.
- set-context after `teardownQuery`: `appendSessionEntries` → emit
  `sessionAppended` (all built uuids) → `trackedLog.drainVisibleBytes()`,
  one try/catch → `setQueryAvailable(false)` + "append/drain failed;
  retry set-context"; then `restartQuery` as before. The handler's own
  `contextChanged` emit and the post-append re-read are gone: the
  tracker's push inside the drain emits `sessionEntry(boundary)[,
  sessionEntry(summary)]` then `contextChanged` (criterion 5). `preTokens`
  = `preTokensOf(querySession(state)?.lastUsage)`.
- `RequestHandlerDeps.trackedLog` (the tracker is read after the gate
  is held — a switch replaces it — and the drain); `sessionFilePath`
  stays for the append path. `get-entries`/`get-context` with a
  defined query file but no tracker yet (file announced, scan not
  started) answer empty rather than throw.
- request-handlers.test.ts fixture: a real `TrackedSessionLog` on a
  `tempDir("rh", t)` config dir; `writeEntries` = pre-start history
  (writes, then `trackedLog.start`; once per fixture), `appendEntries`
  = live CLI write (`appendFileSync` + `drainVisibleBytes`);
  `emitted` filters out the log's own kinds (`sessionFileChanged`,
  `scanComplete`, `sessionEntry`), so set-context tests expect
  `["sessionAppended", "contextChanged"]`. No CLI runs: `appendEntries`
  is `appendFileSync` after the tracker started (what the CLI would
  write while running) versus `writeEntries`, the history the scan
  finds. The "follows the next transcript write" test no longer fakes
  an SDK message: an appended user entry pends on `query` without
  blocking settledness.
- `get-entries {since}` (spec phase-4 wire, pulled forward): `since` →
  `tracker.uuidsAfter(since)`, unknown cursor → error;
  `clauctl get-entries --since <uuid>` (unique prefixes resolved
  through a preceding get-entries, as `--at` is).

### Step 7: the fold's old context clauses go with the fields

Deleting `leaf`/`lastUsage`/`sessionId` also deletes what maintained
them: `conversation_reset` no longer clears session identity (the
per-file evidence stays with its file; the next init's `session_id`
routes fresh), the init-time "drop the leaf on an id change" rule is
gone (the leaf is per file by construction), and `compact_boundary` /
assistant usage fold only into `SessionState` (`withPostTokens` now takes
a `SessionState`). Mechanical consequences of the spec's state shape, not
behaviour redesign.

### Step 8: `awaiting-anchor` detection lives in `TrackedSessionLog`

Slipped from step 3 → 5 → here. `SessionTracker.push` stays
`sessionEntry | contextChanged`; the follower's `onEntry` in
`TrackedSessionLog.open` compares the pushed `awaitingAnchors` with the
previous push's (`awaitingAnchorAnomaly`): more than one outstanding
boundary, or one still outstanding after the next entry, emits the
anomaly (spec, Log entries are never buffered). The memory script's
run over a real log with compactions raised none.

### Step 8: switch-worker slot leak (bug found by the follower-failure test)

`ensureWorker` stored `this.worker = this.runWorker().catch(...)` — but
`runWorker` can finish inside its first synchronous segment (no
target), clearing the slot in `finally` _before_ the assignment, so the
slot held a settled promise forever and every later kick (including
the rescan after a follower failure) was dropped; the extended test
hung on `whenSettled`. Now a `workerRunning` boolean set and cleared
inside `runWorker` itself; the "cleared in the same synchronous
segment as the last target check" invariant is unchanged.

### Review round: malformed lines are reported in file order

`SessionEntryParser.push` returns `Result<ParsedEntry, MalformedLine>[]`
(neverthrow, as stream-merge already uses) in file order and takes no
callback; the policy is the caller's: whole-file readers throw via
`entryOrThrow`, the follower `match`es to `onEntry`/`onMalformedLine`.
So a `malformed-line` anomaly lands between the entries around it (the
test pins `sessionEntry, trackerAnomaly, sessionEntry`). `MalformedLine`
is data (`range`, `lineNumber`, `reason`), not an `Error`: the parser
therefore needs no file path, and the message is built only where it is
consumed — `malformedLineError(filePath, line)` for the readers and
`SessionEntryClient`, `malformedLineMessage(line)` in the anomaly
detail. Anton (2026-09-13, rounds 4a15f24 and f0f5137).

### Review round: `FileState` → `SessionState`, `files` → `sessions`

The record is keyed by session id and holds the merge of both streams
for that session (`lastUsage` is query-side while unsettled), so
"file" undersold it. Renamed with `querySession`, `sessionSettled`,
`freshSessionState`, `describeSession`; `fileSessionId` stays (it names
the tracked file). Doc comments now say which fields are predictive
(top-level `model`/`permissionMode`: the next query) and which are
observed (per-session `model`/`lastUsage`). `lastUsage(state)` accessor
added for the footer and set-context's `preTokens`. Anton (2026-09-13).
Not done, recorded: indexing tool-call/result pairings and message ids
in `SessionTracker` so set-context stops reading the history (comment
at the read site in set-context.ts).

### Step 8: read metering

Counting reads through `fs` mocks rather than a `readFile` dependency
on the follower: the follower and `payloads` already read through
`node:fs` named imports, and `syncBuiltinESMExports()` makes
`t.mock.method(fs, ...)` visible to them — no production seam for a
test-only concern. The meter is installed before the fixture starts so
the follower's fd is metered; the scan's bytes are asserted too.

## WORK LOG

- 2026-09-11: daemon-side sources, stream-merge.ts and the spec read in
  full; plan drafted; open questions raised with Anton and decided
  (above); spec updated for `TrackedSessionLog`; daemon.ts factoring
  candidates (query runner, startup classification) recorded in the
  spec's "Follow-up work" section, not phase 3.
- 2026-09-11: step 0 done. Rename `SdkEvent→AgentEvent` (+Record/
  Subscription), `INITIAL_AGENT_STATE→initialAgentState()`; the new
  event kinds (pass-through fold cases, placeholder rendering);
  `MergeStream`/`TrackerAnomaly`/`SessionState`, `sessions`/`querySessionId`/
  `fileSessionId`/`anomaly`, `querySession`/`leaf`/`sessionSettled`/`settled`
  (real), `excludedFromSession`/`excludedFromQuery` (throw); hub with
  full/slim sink sets and widened `emit`, `whenSettled`/
  `whenFileSettled` (reject); `AnomalyRecorder` (real); `SessionTracker`
  stub (first-wins + slim + ranges + `payloads`; no trees, `leaf` null);
  `TrackedSessionLog` stub; daemon.ts passes `tracker: () => undefined`
  until step 5. Tracer test (session-tracker.test.ts): temp file →
  follower → `push` → `emit` → full and slim sinks, live append,
  duplicate dropped, `payloads`. check/test/lint green (664 tests).
- 2026-09-12: step 1 started; the `<local-command-stdout>` row
  contradicted the captures (shared, not session-only) — raised
  instead of improvised. Design rethink with Anton → redesign
  (redesign-2026-09-12.md); spec edited. Step 1b then done ahead of
  step 1 (`sessionEntry.expectsSdkMessage` added to the design on the way; the
  tracker needs `excludedFromQuery`, so that half of step 1 landed
  too). Next: step 1 (`excludedFromSession` + capture test).
- 2026-09-12: step 1 done. `excludedFromSession`: `assistant`/`user`/
  `system/compact_boundary` shared, every other query class query-only.
  src/core/classification.test.ts pins both functions against the
  recorded pair (verdict == "the other stream carried this uuid", for
  every uuid on either side; asserts the pair holds the stdout entry).
  The derisk README's "3/3 shared" row now names the stdout entry.
  check/test/lint green.
- 2026-09-12: step 2 done. agent-state.ts: `foldQueryMessage` (route by
  `session_id`, create the file, `observe("query")` with first-
  observation `excludeFrom(["session"])`, `pendingLeaf`, per-file
  usage/model, compact_boundary post_tokens via `withPostTokens` shared
  with the top-level residue), `foldSessionEntry` (route by
  `fileSessionId`, scan exclusion + its clearing, `treeLeaf`/
  `awaitingAnchors`, settled-gated usage/model/version),
  `foldSessionFileChanged` (drop old; same-id rescan rebuild from
  `pending(old,"query")` with exclusions, leaf/usage kept),
  `foldSessionAppended`, `foldScanComplete`, `trackerAnomaly`;
  `observeOn` is the one merge call site (MergeError→ merge-error/
  classification, head-mismatch from `Resolved`), `withAnomalies`
  picks one by precedence. agent-state.test.ts: stubs carry
  `session_id`, the two reference-identity tests assert fields, 14
  merge-rule tests added. classification.test.ts →
  stream-pair.test.ts, adding the criterion-3 test: the recorded pair
  folded query-first, log-first and alternating — no anomaly at any
  step, `nodes` empty, settled. check (683 tests)/lint green.
- 2026-09-12: step 3 done (uncommitted). context-tree.ts:
  `ContextTreeBuilder.place` reads the entry only at raw placement
  (relinked occurrences read nothing; `boundaryUuids` set is builder-
  owned; tool-result exclusion checks the parent via
  `fullTree.parentMap` instead of `byUuid` — a semantic shift only for
  corrupt "call after result" files); tree tests green (79).
  session-tracker.ts written: `entryIndex` (range + class, file order),
  `byUuid` of structural entries pruned by walking `sessionTree.nodes`
  from a `consumed` cursor (raw occurrences only), `push` → sessionEntry
  (leaf, `lastAssistantOn(leaf)`, awaitingAnchors) then one
  `contextChanged` per boundary completed (awaiting-before minus after,
  then its own if not awaiting; `leaf` = post-push leaf, criterion 5),
  `uuidsAfter` (throws on unknown cursor), `contextAt`, `contextTree`,
  `leaf`, `residentEntries` (byUuid.size, the pruning observable).
  `awaiting-anchor` anomaly detection goes to step 5 (push returns only
  sessionEntry|contextChanged). session-tracker.test.ts: tracer asserts
  leaf/lastAssistant/awaitingAnchors and `residentEntries === 0`; two
  direct-push tests — up_to boundary (awaiting on its own push,
  `contextChanged` with the summary, leaf `reply@boundary`, contextAt,
  uuidsAfter incl. unknown-cursor throw, nothing resident) and a self-
  anchored wipe (`contextChanged` on its own push, leaf null). check
  (685 tests)/lint green.
- 2026-09-12: step 4 done (uncommitted). event-hub.ts: `observeSdkMessage`
  dedup — a uuid-bearing message whose `session_id` is the tracked
  file, present in `tracker().index` and absent from that file's
  `merge.nodes` is dropped: silently for a shared class, via
  `trackerAnomaly {classification}` for a session-only one;
  `whenSettled`/`whenFileSettled` share `awaitState` (waiters
  re-checked after every fold; `SETTLE_TIMEOUT_MS = 10_000` defined
  here rather than imported from tail.ts — same bound, tail.ts is not
  a daemon dependency — timer unref'd; rejection names the file's
  pending("query") and awaiting anchors); `applyEvent` records every
  event on the `AnomalyRecorder` and, when the folded state carries
  `anomaly`, writes the bundle and logs `error: tracker anomaly
  <kind>: <detail> (bundle: <path>)`. event-hub.test.ts: four tests
  through a real direct-push `SessionTracker` (shared duplicate silent;
  session-only duplicate → anomaly + log + bundle with the event ring,
  cleared by the next fold; whenSettled resolves on the catching-up
  entry; timeout rejection under mock timers). check (689 tests)/lint
  green.
- 2026-09-12: step 5 done (uncommitted). tracked-session-log.ts:
  `start(seed)` opens the seed file when it exists (announce → scan →
  `scanComplete`) then subscribes to the hub, kicking the switch worker
  on every `sdkMessage`; the worker loops over `switchTarget()` (a
  rescan of `fileSessionId` when the follower failed, else
  `querySessionId ≠ fileSessionId`), waits `whenFileSettled` (timeout
  logged) + `whenQuiet(SESSION_FILE_QUIET_MS)` raced against
  `whenFailed()` (skipped for a rescan or with no follower), awaits the
  file's existence (`awaitFileExists`, moved to
  session/await-file-exists.ts with `SESSION_FILE_TIMEOUT_MS`;
  agent-observer imports it), then under the exclusive gate `open()`:
  close old follower, new tracker, `sessionFileChanged`, new follower
  (`onMalformedLine` → `malformed-line` anomaly, `onFailure` →
  `follower-failure` anomaly + rescan flag + kick), `start()`,
  `scanComplete`. The worker slot is cleared in the same synchronous
  segment as its last target check, so no kick is lost. The stub's
  duplicate `SETTLE_TIMEOUT_MS` removed (event-hub.ts owns it).
  daemon.ts: seed is settings only (`seedFromEntries` gone;
  `sessionId` residue kept for step 7), `RwGate` created here and
  passed to both the request handler (`RequestHandlerDeps.gate`) and
  the tracked log, `tracker: () => trackedLog.tracker`,
  `trackedLog.start(seedSessionId)`; shutdown = exclusive gate → drain
  (throw logged) → `shutdown` → `trackedLog.close()` → release → query
  close (criterion 9). Deleted session/seed.ts + seed.test.ts;
  format/input.ts and scripts/tui-parity/render-session.ts derive the
  raw-JSONL leaf as `toContextTree(...).leaf` (the previous
  meta/sidechain-filtered "last conversational occurrence" is gone —
  the spec's "same function the daemon computes").
  tracked-session-log.test.ts: startup scan then a switch to the
  query's file (real 500 ms quiet window), truncation → anomaly +
  same-file rescan. check (685 tests: −6 seed, +2)/lint green.
- 2026-09-12: step 6 done (uncommitted). entry-stream.ts: `waitForEntry`
  and `readEntriesAfterStreamFlush` deleted (+5 tests); `runStream`
  import dropped (`SessionEntryClient` stays for agent-observer).
  request-handlers.ts: `acquireSettled` helper; `get-entries` =
  `payloads(uuidsAfter(undefined))` + `tracker.leaf`, `get-context` =
  `payloads(contextAt(at ?? leaf))` under the shared gate; the
  `querySession === undefined` fast path. set-context.ts rewritten per the
  decisions above (`SetContextShared.acquireSettledExclusive`; no
  `contextChanged` emit; `buildTree`/`toContextTree`/`readSessionEntries`
  imports gone). daemon.ts: `querySessionId: seedSessionId` seeded,
  `trackedLog` passed to the handler. request-handlers.test.ts: fixture
  redesign (above); tests that overwrote the file after `linearSession`
  now `appendEntries` the extra entries; the two `initialEntries`
  restart tests write then read. check (680 tests)/lint green.
- 2026-09-12: step 6 review round (2ee6280) addressed. `settled` is
  vacuously true without a query file (agent-state.ts) and the
  handlers' `querySession` pre-checks are gone; `get-entries {since}` on
  the wire (`uuidsAfter(since)`, unknown cursor → error) plus
  `clauctl get-entries --since` (sdk-commands.ts, prefix resolution as
  `--at`); mid-switch wording fixed (rejected, and should be); the
  "live" test wording clarified (no CLI runs). +1 test (`--since`,
  unknown cursor). check (681 tests)/lint green.
- 2026-09-12: step 7 done (uncommitted). agent-state.ts: top-level
  `sessionId`/`leaf`/`lastUsage` and their fold clauses deleted
  (`contextChanged` is a pass-through; `withPostTokens` takes a
  `SessionState`); `conversation_reset` clears only `deliveredMessages`;
  `freshSessionState` exported for tests. Clients: tail.ts `leaf(state)`,
  footer.ts `querySession(state)?.lastUsage`, interactive-mode.ts
  `leaf(state)` (null-checked), format/events.ts snapshot line and
  agent-observer.ts `querySessionId`, daemon.ts seed `sessionId` line
  gone. Tests: prompt.test.ts/agent-state.test.ts/tail.test.ts/
  footer.test.ts/events.test.ts fixtures carry `session_id` (a query
  message without one routes nowhere and unsets `querySessionId`, so a
  fixture missing it now renders nothing — two such failures found and
  fixed). check (680 tests)/lint green.
- 2026-09-12: step 8 done (uncommitted). Criterion 1:
  request-handlers.test.ts `meterLogReads` mocks `fs.openSync`/
  `readSync`/`readFileSync` (`t.mock.method` + `syncBuiltinESMExports`
  so file.ts/entry-stream.ts's named imports follow) and sums
  `readSync` bytes on fds opened for the log; the test asserts the scan
  reads the history once, get-entries the served ranges, `since` one
  line, get-context the two served entries, set-context the history
  (normalization) plus the appended boundary line, and no whole-file
  read anywhere. Criterion 11 (one test per anomaly kind, tracker
  settles after): merge-error and head-mismatch in event-hub.test.ts;
  classification test now awaits `whenSettled`; malformed-line,
  follower-failure (extended: the query-pending id survives the rescan
  and settles on the rewritten file) and awaiting-anchor in
  tracked-session-log.test.ts. Criterion 10: scripts/diagnostic/
  tracker-memory.ts — on the 167 MB fixture (9904 entries) scan 510 ms,
  resident 6.1 MB (heapUsed 10.8 → 17.0 MB after GC; bound 80 MB), no
  anomaly raised. check/lint green, 685 tests.
- 2026-09-13: review round (4a15f24) addressed: `whenNext`/`drain` in
  the tracked-log test harness, `lastUsage(state)`, the read-count test
  calls `get-context` directly, parser file-order reporting, the
  `SessionState`/`sessions` rename (decisions above). Anton's
  questions answered in chat: set-context's per-entry history read is
  by design for now; `/clear`'s command entry cannot pend on the old
  session because prompts are not query observations.
- 2026-09-13: review round (f0f5137, which also carries Anton's own
  remaining `file` → `session` local renames) addressed: the three
  `"error" in line` checks replaced by `Result<ParsedEntry,
  MalformedLine>` with a data `MalformedLine` (decision above); the
  redundant `session: session` shorthands from the rename fixed.
  check/lint green, 684 tests.
