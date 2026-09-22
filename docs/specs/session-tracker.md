# Spec: session tracker — the daemon follows the session log and merges it into the agent event stream

> Status: **COMPLETED 2026-09-16 — all five phases implemented (phase
> logs under docs/specs/session-tracker/).** Rewritten on top of
> docs/specs/stream-merge.md (2026-09-11); reviewer-approved at round 13;
> redesigned 2026-09-12 (payload-free shared entries, no slimming; WORK
> LOG "Redesign" and docs/specs/session-tracker/redesign-2026-09-12.md).
> Follow-up to
> docs/specs/get-context.md (its Cost section anticipated this) and
> docs/thoughts/old/get-entries-caching.md. Derisk rounds and the rewrite's
> decision record are in the WORK LOG.

# SPEC

## Problem

`ContextTree` answers "the assistant's context at any occurrence" from
the file alone, but every request that needs it (`get-context`,
`get-entries`, `set-context`, `/tree`, `reloadHistory`) re-reads and
re-parses the whole session log and rebuilds every tree. Measured on real
files: a 167 MB / 50k-entry log costs ~390 ms to parse, ~30 ms for all
three trees, ~560 ms to `JSON.stringify` for the wire, 167 MB on the
wire, and 240 MB of heap; a `/tree` round trip is ~1.5–2 s. The trees
are cheap; re-parsing and shipping the whole file is not.

The daemon also holds two unsynchronized views of one process: the
**query stream** (`SDKMessage`s from `query()`, folded into `AgentState`)
and the **session log** (the jsonl file, read ad hoc through
`readEntriesAfterStreamFlush`'s flush-lag wait). Clients that need both
(`tail`, `prompt`) merge them themselves in `AgentObserver`, and the
TUI dedupes stream-vs-file replay with ad hoc uuid sets whose ordering
assumption is documented as "unproven".

Wanted:

- **The daemon follows the session log** (`tail -f`) and maintains a
  **session tracker** — structural entries, byte ranges, the rolling
  full tree and context tree — from startup on. It never re-parses the
  log and never rebuilds a tree; full payloads are re-read by byte
  range on request.
- **One agent event stream.** sdk.sock emits the union of query-stream
  messages, log entries, and daemon bookkeeping — "the interface we wish
  the claude CLI provided". `AgentObserver` (client-side merge) goes
  away.
- **Settledness is a fold fact**, not a file re-read: the two streams
  are merged by docs/specs/stream-merge.md's library inside the fold,
  and the state says whether the log has caught up with the query
  stream.
- **Send what the query stream lacks.** A log entry whose class the
  query stream also carries (Classification table) goes out as its
  **structural projection** — payload strings emptied, everything the
  trees read kept — because the subscriber already has the payload
  from the `sdkMessage` twin; every other entry (attachments, prompts,
  hook summaries, …) goes out intact. No entry is ever truncated.
- **Trees are a function of the entry stream.** Every tree — the
  daemon's full and context trees, a client's display tree — is built
  from `sessionEntry` events alone (structural entries suffice for the
  builders), so the live tree structure equals the structure a restart
  rebuilds from the file.
- **Rolling builders.** `buildTree`, `toContextTree`, `toDisplayTree`
  become `push(entry)` builders; daemon and TUI extend their trees per
  arriving entry.

## Terminology

Recorded in a new `docs/agent-events.md` (sibling of
docs/session-views.md):

- **query stream** — the `SDKMessage`s `query()` yields, plus the
  entries the daemon appends in `set-context` (its own query-side
  action). Claude's view, in Claude's order. Every SDK message carries
  `session_id` and `uuid`.
- **session log** — the session jsonl file; its records are **log
  entries** (`SessionEntry`). A **canonical** entry is one the
  first-wins uuid filter accepts (docs/specs/canonical-session-entry-stream.md).
  A **scan** is what a follower delivers inside `start()`: the file's
  contents when it was opened.
- **agent event stream** — what sdk.sock emits: query-stream messages
  (`sdkMessage`), log entries (`sessionEntry`), and daemon bookkeeping
  (everything else). `AgentEvent` is its record type; `AgentState` its
  fold.
- **merge** — a `MergeState<UUID, "query" | "session">`
  (docs/specs/stream-merge.md), one per session file, kept as plain
  data in the fold. Its ids are the uuids of uuid-bearing occurrences
  on either stream. An id is **pending** on a stream once that stream
  has observed it and until it resolves; a **resolved** id has left
  the merge (stream-merge.md's terms).
- **classification** — the table below: which streams carry an id of a
  given class. Ids a stream never carries are `excludeFrom`'d it at
  first observation.
- **query file** — the session file the query stream is on: the
  `session_id` of the latest query message (`querySessionId`).
  Requests address it.
- **tracked file** — the session file the follower and the session
  tracker are on (`fileSessionId`). Equal to the query file except
  between a query message with a new `session_id` and the switch
  (below).
- **`SessionState`** — the per-file part of `AgentState`: merge, tree
  leaf, pending leaf, `awaitingAnchors`, `lastUsage`/`model`.
- **settled** — a `SessionState` with nothing pending on `query` and no
  boundary awaiting its anchor. The agent state is settled when the
  query file is the tracked file and is settled.
- **switch** — the daemon moves the follower and the session tracker
  from the tracked file to the next one; marked by
  `sessionFileChanged`. A `system/init` on the same file (a set-context
  restart) is not a switch.

## The merge model

**Assumption (falsifiable):** the query stream and the session log are
two views of one process in the same order. Each sees things the other
does not; shared ids correlate them. The merge library resolves ids in
a topological order of both streams; where they disagree — one stream
reports an id after the other has already passed it — the
disagreement surfaces as a head-mismatch (below), reported as an
anomaly; the merge itself never guesses (stream-merge.md's
guarantees). Empirically the order matches and the log lags the query
stream by a flush; both directions of lag are handled the same way.

### Observations

Every uuid-bearing query item for file F is `observe(F.merge, "query",
uuid)`; every canonical uuid-bearing log entry of the tracked file is
`observe("session", uuid)`. At an id's **first** observation the fold
`excludeFrom`s the other stream when the classification says it does
not carry the id (`excludedFromSession(message)` /
`excludedFromQuery(entry)`). How a wrong table surfaces is in the
Classification table section. The fold additionally excludes a scan
entry
from `query` while `SessionState.scanExcluded` holds — from the file's
opening until the scan meets an id the merge already holds (the query
stream reported it first) or `scanComplete` arrives. The startup scan
is therefore excluded entirely (a resumed query never re-reports the
file); a `/clear`'s first turn or a `/fork`'s copied history are
excluded up to the first live id. The scan exclusion is a cost
measure, not a correctness one: `MergeState` updates are pure and copy
the state they touch, so a backlog of n unresolved scan nodes makes
the scan O(n²); excluding them keeps the merge at the live lag. The
code notes this at the exclusion site.

Prompts the daemon submits are **not** query observations: clauctl
does not stamp `SDKUserMessage.uuid`, the query stream never echoes a
prompt, and the CLI persists a prompt wherever the command runs —
`/clear`'s `<command-name>` entry is the first `user` entry of the
**new** file (4 real post-`/clear` files) — so the fold could not name
the file to observe it on. Prompt `user` entries are session-only
(table). The one cost: a request issued right after `prompt --append`
does not wait for the entry to land (a turn prompt is covered by its
assistant messages). Stamping is kept as an option (interrupt/cancel
by uuid, `command_lifecycle`; docs/derisk/uuid-stamping/), not used.
A set-context append's uuids are observed on `query` at
`sessionAppended` (emitted before the drain that delivers them).

A `Resolved` whose `seenOn` ∪ `excludedFrom` misses a stream is a
**head-mismatch**: that stream skipped the id (a successor arrived
there first). Under the classification and the order assumption this
cannot happen: it is either genuine reordering or a class the table
calls shared that one side never carries. It is an anomaly (below);
the merge has already made the consistent choice, so nothing is reset.

**Settled** (file) ⇔ `!hasPending(merge, "query")` ∧ `awaitingAnchors`
empty; **settled** (state) ⇔ `fileSessionId === querySessionId` ∧ the
query file is settled — a request must not be served from a tracker
that is still on the previous file. Residency of the merge is the live
lag: scan entries resolve at once, live shared ids resolve when the
other stream passes them.

### Classification table (which streams carry an id)

The table itself lives in docs/stream-merging.md (moved there in
phase 5; this spec cites it).

Evidence: SDK 0.3.258 `sdk.d.ts` (every `SDKMessage` variant carries
`uuid`; optional only on host-pushed `SDKUserMessage`); 349 real
session files; echoed-message-placement captures (11/11
assistant/user uuids in the paired file); a live `/compact` on
2026-09-10; docs/derisk/stream-classification/ and
docs/derisk/uuid-stamping/ (probes, 2026-09-11).
tests/sdk/stream-classification.test.ts pins the table and the same
relative order of shared uuids on both streams. `excludedFromQuery` on
a `user` entry is "no `tool_result` block, not `isCompactSummary`, and
its string content does not start with `<local-command-stdout>`" —
tool results, summaries and local-command output are the shared `user`
classes. Local-command **output** is shared under two shapes (`/cost`:
`system/local_command` ↔ query `assistant`; `/compact`: `user` stdout
↔ query `user` replay); local-command **input** (caveat, command) is
session-only.

The table also decides what crosses the wire: a session-only entry
goes out intact, a shared one as its structural projection (Agent
events). Unknown rows are treated as **session-only** (excluded from
`query`) — the safe direction: the entry goes out whole. A wrong row
surfaces as an anomaly (below) in one of two ways; a "one-sided" row
that is really shared additionally costs a duplicate payload on the
wire, a "shared" row that is really one-sided costs the payload the
subscriber never gets (the head-mismatch names it):

| table says           | reality   | detected by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared               | one-sided | **head-mismatch**: the id resolves only when a successor closes it, with `seenOn ∪ excludedFrom` missing the absent stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| one-sided (excluded) | shared    | the excluded node resolves at once and is forgotten, so there is no `Resolved` to inspect when the other stream shows the id. Resident behind a pending predecessor: the library's `excluded-observed`. Forgotten: on the query side the **dedup site** — an `index` hit with no merge node whose class is session-only (a shared class is a duplicate, Query-stream duplicates); on the session side the fresh node pends and closes as a **head-mismatch** unless the entry's own class is also session-only, in which case nothing fires — both sides agree it is one-sided, and the merge is unharmed. |

A `system/init` never carries a shared id; `sessionFileChanged` is a
daemon event, not an SDK message.

### Query-stream duplicates

The CLI re-emits a shared uuid on the query stream in at least one
case (`/cost` output re-sent after a `/compact` that preserved it as
tail; docs/derisk/stream-classification/README, 2/2; the copies are
equal modulo `message.id`). Unresolved, a repeat is an
`order-violation`; resolved, it would create a node that never
resolves. The daemon dedups query uuids **first-wins before the merge**:
a query item is a duplicate iff its uuid is in its file's `index`
(available only while its file is the tracked one) and the merge has
no node for it (it resolved, which needed a query observation). `index` alone is not enough — the file may lead
the query for a shared uuid, and that first query observation is what
resolves the node. A duplicate is neither folded nor broadcast (like a
duplicate log line): the agent event stream is the interface we wish
the CLI provided, and it would not repeat itself. The same check
separates duplicates from classification errors (Classification
table): the class recorded in the `index` decides. Caveat, accepted: a
repeat on a file the follower has not reached yet (no `index`) is an
`order-violation`.

### Anomalies

An **anomaly** is an observation the model says cannot happen:
`order-violation` (an id observed on a stream that has already passed
it — with two streams only a same-stream repeat can do this, i.e. a
query duplicate the dedup rule missed or a duplicate log line the
first-wins filter missed), `classification` (the table is wrong for
this uuid: the library's `excluded-observed` on a resident node, or
the dedup-site check — Classification table), a head-mismatch (every
id a single fold resolved with a stream missing),
`awaiting-anchor` (below), `malformed-line` (a terminated log line
that does not parse; the follower skips it and continues), and a
follower failure (truncation, inode replacement, unrecoverable read
error). None is fatal: the daemon keeps running, recovers as below,
and **reports** — the fold sets `AgentState.anomaly` on the state it
produces (one per event at most — when several conditions fire in one
fold they form one anomaly, kind by precedence `merge-error` >
`classification` > `head-mismatch`, `detail` naming all; the next
fold clears it, so the field means "this event was anomalous"; the
`trackerAnomaly` fold itself never sets it), and the daemon's hub writes
a diagnostic bundle, logs it at error and emits a `trackerAnomaly` event
naming the bundle — right after the anomalous event for a fold-detected
anomaly, as the tracker's own event for the rest. Clients react to that
event alone (the TUI banners it: "tracker anomaly <detail> — this
shouldn't happen; details in <bundle path>; contact Anton
(geraschenko@gmail.com) to help fix it"); their own fold's
`AgentState.anomaly` goes unread. Anomalies are
the falsifiers of the order assumption and the classification table;
a report's fixture goes into tests/sdk/stream-classification.test.ts
and the table.

Recovery: a **merge error** (`order-violation`, or the
`excluded-observed` reported as `classification`) leaves the failing
observation unapplied and nothing else — both leave the merge exactly
as consistent as before; the message/entry is still folded and
broadcast (only its merge observation is dropped). **Head-mismatch**,
**classification**,
**awaiting-anchor** and **malformed-line** need no recovery. A
**follower failure** is recovered by a switch to the same file — the
byte ranges are stale, so the daemon re-opens and rescans it:
criterion 8's gated part with `sessionFileChanged` naming the current
id, entered at once (the settle and quiet waits are skipped: a request
that holds the shared gate finishes — its payload read fails on the
stale range, an error, not a wrong answer — and none starts on the
failed tracker). The fold keeps the `SessionState`'s query-side facts —
`pendingLeaf`, `lastUsage`, `model`, and the merge rebuilt from its
query-pending nodes: each id of `pending(old.merge, "query")`
re-observed on `query` in order, with `excludeFrom(["session"])`
reapplied where the old node had it — and re-initializes the
tracker-derived ones (`treeLeaf` null, `awaitingAnchors` empty,
`scanExcluded` true); clients reset their trees like on any switch.
Carrying the query side is what keeps a query message folded between
the failure and the gate from being lost: its id is among the file's
newest entries (the log lags), so the rescan excludes everything
older, meets the first pending id, and resolves them in order;
session-pending nodes are dropped because the rescan re-delivers
their entries (re-observing them would be an `order-violation`). The failure is handled by the same switch worker as a
`/clear`: if the worker is waiting on settle/quiet when the follower
fails, the wait is abandoned and the worker proceeds to the gated
part with `next = fileSessionId`, then loops as usual.

The diagnostic bundle (`<daemon dir>/anomaly-<timestamp>.json`): the
anomaly, the merge state before the failing call, the last
`ANOMALY_CONTEXT_EVENTS` (50) events of both streams as `{kind, type, subtype,
uuid, session_id, apiMessageId, parentUuid}` (no payloads; stream events
and subagent traffic are left out — they carry no node the merge relates
to anything and would only push the useful context out),
`claudeCodeVersion`, and the tracked and query session ids. It is what a reproduction needs: the trail
replays through the fold; the session files themselves are named by
their ids.

### Log entries are never buffered

Log-only entries have no counterpart to wait for, and the session
tracker must reflect the file the moment a byte is visible
(set-context reads its own append back synchronously). A boundary
whose preserved block relinks under an anchor not yet in the file (an
up_to compaction's summary follows its boundary) leaves the session
tracker **incomplete** until the anchor arrives: the block rows are
deferred and the leaf is provisional. Every `sessionEntry` event
reports `awaitingAnchors` (the uuids of boundaries still deferred, in
file order; several can be outstanding, and one anchor can complete
several); the fold keeps them in the `SessionState`, and `contextChanged`
is emitted per boundary when it completes — after the boundary's own
`sessionEntry` when nothing is deferred, else after the anchor's (one
event per completed boundary, file order).

`awaitingAnchors` is a list only because `SessionTreeBuilder` keys
deferred blocks by anchor and hand-crafted logs can have several
outstanding. In a CLI-written log at most one boundary is ever
outstanding, and only until the next entry (its summary). The daemon
emits an `awaiting-anchor` anomaly when either expectation fails — a
second outstanding boundary, or one still outstanding after the next
entry — as another falsifier (criterion 11).

### Leaf

The query-side leaf (the attach boundary the TUI cuts its path at and
the next prompt chains from) is per file: the **pending leaf** — the
last leaf-eligible query observation still pending on `query`, cleared
when it resolves — else the file's context-tree leaf. `leaf(state)` is
the query file's. A restarted daemon thus seeds it from the scan
(every scan entry resolves at once, so the tree leaf wins), and live
query messages own it until the log catches up.

## Success criteria

1. **No whole-file re-read.** After the startup scan the daemon reads
   the session log only at recorded byte ranges (`readEntriesAt`, which
   parses exactly the requested lines) to serve full payloads, and never
   rebuilds a tree. A test counts `readSessionEntries` calls and bytes
   read from the log: none / only the requested ranges after startup
   across `get-entries`, `get-context`, `set-context`, and `/tree`.
2. **Tree equivalence.** For every fixture in the tree test corpus and
   every prefix length k: a fresh `SessionTreeBuilder` fed the first k
   entries then `finish()`ed yields a `parentMap` equal to
   `buildTree(prefix)`; likewise `ContextTreeBuilder` (`parentMap`,
   `excluded`, `leaf`) against `toContextTree` and `DisplayTreeBuilder`
   (`parentMap`, `nearestVisibleNode` for every occurrence) against
   `toDisplayTree` — the per-prefix check docs/specs/get-context.md
   deferred to "the rolling builder". The per-prefix sequence is
   `session.pushAll(prefix); session.finish(); context.push();
display.push()`; pushing into a finished builder throws. Without
   `finish()`, a builder's live view omits rows deferred behind an
   anchor that has not arrived (their placement is unknowable until it
   does).
3. **Same fold everywhere.** An observer seeded from `subscribe` and
   folding the pushed `AgentEvent`s holds the same `AgentState` as the
   daemon: the fold reads only fields the structural projection never
   touches (`uuid`, `type`, `subtype`, `isMeta`, `isSidechain`,
   `version`, `permissionMode`, and the event's own
   `expectsSdkMessage`/`leaf`/`lastAssistant`/`awaitingAnchors`). The merge is part of
   the state, so the client's settledness is the daemon's. A daemon
   restarted on a log holds, after its startup scan, the `leaf`,
   `treeLeaf`, `lastUsage`, `model`, `claudeCodeVersion`,
   `permissionMode` the live fold held (the seed is the fold; `seed.ts`
   is deleted) — with no history machinery: the scan is excluded from
   `query`, so it resolves as it is folded. A client's fold never
   diverges from the daemon's: `subscribe` returns the folded
   `AgentState`, and every event the daemon folds afterwards is
   broadcast. A merge-equivalence test folds recorded query/session
   pairs (the classification fixtures) and asserts every id resolves,
   settled at the end, no anomaly.
4. **Settledness replaces the flush wait.** `get-entries`, `get-context`
   and `set-context` await `EventHub.whenSettled()` — `settled(state)`
   — which rejects after `SETTLE_TIMEOUT_MS` naming the query file's
   `pending(merge, "query")`. `tail --until` and `prompt --until` keep their
   conditions (`until.ts`): the condition latches on the event that
   meets it, and completion then awaits `settled(state)` (bounded by
   the same timeout) — no `consumedUuids` bookkeeping.
   `readEntriesAfterStreamFlush`/`waitForEntry` are deleted.
5. **`contextChanged` from the log.** The event follows the
   `sessionEntry` that completes every `compact_boundary` (the boundary's
   own, or its anchor's when the block was deferred) — native
   compaction and `set-context` alike — carrying `{boundary, leaf}` with
   the final post-boundary leaf; the request-handler emit is deleted.
   `tail --type events` annotates from the boundary's `compactMetadata`.
6. **Payload-free shared entries, intact everything else.** A
   `sessionEntry` event for a shared-class entry (`excludedFromQuery`
   false) carries `structuralEntry(entry)`: every string at a
   `PAYLOAD_PATHS` leaf is empty, every other value — block `type`,
   `id`, `tool_use_id`, `name`, `message.id`/`usage`/`model`,
   `compactMetadata`, `toolUseResult`'s keys — is JSON-equal to the
   file. A session-only entry (attachments, prompts, hook summaries,
   uuid-less rows) is JSON-equal to the file. `get-entries {uuids}` and
   `get-entries {payload: "full"}` return entries complete (JSON-equal
   to the file), in requested/file order. No entry is truncated
   anywhere; a client that wants shorter attachment bodies cuts them
   itself.
7. **Trees from the stream; `/tree` never refetches.** The TUI's trees
   are extended from `sessionEntry` events (structural entries are all
   the builders need); `/tree` and `reloadHistory` read local state.
   Rendering payloads come from the `sdkMessage` twin (live) or the
   `get-entries {payload: "full"}` history fetched at attach — never
   from a per-node refetch. A `queued_command` attachment (a steered
   prompt, docs/derisk/uuid-stamping/) is a display-tree row rendered
   as the user message it was, after the tool result it rode on — the
   same row whether the attachment arrived live or in the history
   fetch, so a restart shows what the live view showed.
8. **Switches are serialized and settle first.** A query message with a
   new `session_id` creates that file's `SessionState` and makes it the
   query file at once; the reader never pauses. The daemon then
   switches the follower, outside the request gate: it waits for the
   tracked file to settle (its merge holds only that file's items, so
   this is reachable; bounded by `SETTLE_TIMEOUT_MS` — on timeout the
   pending uuids are logged as lost and the switch proceeds) and then
   for `SESSION_FILE_QUIET_MS` without a write (the old file has no end
   marker; log-only trailing rows — `stop_hook_summary`,
   `turn_duration` — arrive after the last shared id and matter only to
   `tail --type entries`; named cost). Then, under the exclusive gate:
   close the old follower, drop its `SessionTracker` and `SessionState`,
   emit `sessionFileChanged {sessionId}` (the fold sets
   `fileSessionId`; clients reset their trees), open the next file in
   `sessions` order and scan it (every scanned entry is folded and
   broadcast like any other, excluded from `query` per the merge
   model), emit `scanComplete`, release the gate. Repeat while
   `fileSessionId ≠ querySessionId` (two rapid `/clear`s); on a fresh
   spawn the first `system/init` runs only the gated part (there is no
   old file). Requests
   await `settled(state)` outside the gate and take the session tracker after acquiring it, so a request
   that waited across a switch serves the new file; a request on a
   file whose follower does not exist yet simply waits for the switch
   to bring it. Anything the old file writes after the close is lost
   silently — the quiet period's cost. `system/init` resets nothing.
9. **Shutdown drains.** Teardown takes the request gate exclusively
   (so an in-flight set-context or switch completes first), calls
   `follower.drainVisibleBytes()` (a throw is logged, not fatal to the
   shutdown), emits `shutdown`, closes the follower — entries already
   on disk reach subscribers before the close (today's "socket close is
   conclusive idleness" drain in `AgentObserver`, moved upstream).
10. **Memory.** Daemon `process.memoryUsage().heapUsed` after the startup
    scan of the 167 MB fixture (measured after a forced GC with
    `--expose-gc`) ≤ 80 MB, versus 240 MB for full entries today.
11. **Anomalies are reported, never fatal.** The order assumption and
    the classification table are checked on every observation; every
    anomaly (merge model, Anomalies) names the id, the stream and the
    class, lands in `AgentState.anomaly`, the daemon log and a
    diagnostic bundle, and the TUI banner; the daemon recovers as
    specified and a test per anomaly kind shows the tracker settling
    again afterwards. Findings go to the WORK LOG and, for
    classification, the table.

## Examples

Notation: `Q:` a query observation, `S:` a session observation,
`pending(q)` = `pending(merge, "query")`.

- Query stream reports assistant `a7`; the log has not flushed it:
  `Q: a7` → `pending(q) = [a7]`, pending leaf `a7`, unsettled.
  `get-entries` waits. The follower delivers `a7`: `S: a7` resolves it
  (`seenOn` both), pending leaf cleared, `treeLeaf = a7`, settled; the
  request is served.
- The log delivers a `system/turn_duration` entry: `S: t`,
  `excludeFrom(["query"], t)` → resolves at once; `sessionEntry`
  event, `treeLeaf` advances to it; settledness unchanged.
- Query stream reports a `result` message `r`: `Q: r`,
  `excludeFrom(["session"], r)` → resolves at once; nothing pending.
- Prompt `p` submitted: no query observation; the CLI writes the
  `user` entry → `S: p`, excluded from `query`, resolves at once. The
  turn's assistant messages are what settledness waits for.
- `set-context --rewind-to a3`: handler validates against the session
  tracker, tears down the query, appends the boundary, emits
  `sessionAppended {uuids: [B]}` (`Q: B`, `pending(q) = [B]`), calls
  `follower.drainVisibleBytes()` — inside which the session tracker
  pushes the boundary (`S: B` resolves it) and the hub emits
  `sessionEntry(B, leaf: a3@B)` then `contextChanged {boundary: B,
leaf: a3@B}` — then restarts the query. The response is today's
  `SetContextResult` (`boundaryUuid: B`).
- Native `/compact` (up_to shape): `Q: B` (`system/compact_boundary`)
  → `pending(q) = [B]`; `S: B` resolves it, but the preserved block
  relinks under the summary `S`, not yet written: `awaitingAnchors =
[B]`, still unsettled. The log delivers `S`: block rows materialize,
  `awaitingAnchors` empty, `contextChanged {boundary: B, leaf:
P.last@B}` (the last preserved occurrence). `Q: S` (the compaction
  summary is a query `user` message) arrives before or after `S: S`;
  either order resolves it.
- Reordering (the order assumption false): `Q: a`, `Q: b`; the log
  delivers `b` first (`S: b`). `b`'s session observation closes its
  query predecessor `a` on `session` (closure propagates to
  ancestors), so `a` resolves seen on `query` only — a head-mismatch
  anomaly, "session skipped a" — and `b` resolves on both; settled.
  `S: a` then arrives as a fresh node (the old one is forgotten),
  pending on `session` until the next query item closes it: a second
  head-mismatch, "query skipped a". Settledness was reached with `a`
  off disk; the two anomalies are the only signal. With two streams
  an `order-violation` can arise only from a same-stream repeat
  (dedup covers the known case); see Anomalies.
- Classification error: an `attachment` entry `t` is classified
  session-only (`S: t`, excluded from `query`, resolved and forgotten);
  the SDK then reports `t`: `t` is in the `index`, has no merge node, and
  `excludedFromQuery` holds → the hub emits a `classification`
  anomaly naming `attachment`/`t` and drops the message; the banner
  shows, the table gains a row from the bundle.
- Startup on a 50k-entry log: 50k scan events fold with no subscribers;
  each is `S: u` + `excludeFrom(["query"], u)` and resolves at once
  (`scanExcluded` true throughout — no query message has been seen),
  so the merge stays empty; `scanComplete`; the state ends settled
  with `treeLeaf`, `leaf` (= `treeLeaf`), `lastUsage`/`model` (from the
  context's last assistant), `claudeCodeVersion`, `permissionMode` —
  the seed. The first live query message `m` is `Q: m` → pending until
  the log delivers it.
- `/clear`: query reports `system/init` with new id `F2` → `sessions[F2]`
  created (empty merge, `scanExcluded: true`), `querySessionId = F2`,
  `fileSessionId = F1`. The old file `F1` has `pending(q) = [a]` (its last
  assistant): the follower delivers `a`, `F1` settles, goes quiet, is
  closed; `sessions[F1]` dropped; `sessionFileChanged {F2}`
  (`fileSessionId = F2`); meanwhile the query stream has already reported `F2`'s first
  turn `Q: a1` into `sessions[F2].merge` (the prompt `p1` is never a
  query observation). The scan of `F2` reads `p1` first: session-only
  and `scanExcluded`, resolves at once; then `a1`: the merge holds it
  → `scanExcluded = false`, plain `S: a1` resolves it;
  `scanComplete`; live proceeds.
- `/fork`: as `/clear`, but the new file opens with a copy of the old
  one: the scan's copied entries are excluded from `query` (the merge
  has no node for them) and resolve at once; the first entry the
  query reported for `F2` ends the exclusion.
- Query duplicate: after a `/compact` the CLI re-sends the preserved
  `/cost` assistant message `c`; `c` is in the `index` and has no merge
  node → dropped before the merge.
- TUI start: `subscribe` (events buffer), then `get-entries {payload:
"full"}` → `GetEntriesResponse {entries, leaf}`; every `sessionEntry`
  event received before the response is folded but not pushed into the
  tree (the snapshot contains it — see Data flow 6); no gap, no replay
  in `subscribe`. Live from then on: an assistant message arrives as
  `sdkMessage` (payload, rendered at once) and later as a structural
  `sessionEntry` (parent link; pushed into the trees); an attachment
  arrives once, intact.
- A steered prompt: `userMessageDequeued {delivery: "steer"}` (the
  pending-area preview), the tool-result `user` twin pair, then the
  `queued_command` attachment entry intact — the display tree gains a
  user row for it under the tool result. After a restart the history
  fetch delivers the same attachment and the same row appears. The
  attachment is an ordinary in-context node (the tool-result entry
  carries nothing of the steer; docs/derisk/uuid-stamping/captures),
  so no relinked ref and no picker special case: rewinding to it is a
  rewind to its uuid. Caveat: the CLI takes an attachment in a
  preserved list without contributing its content
  (docs/derisk/compact-boundary-injection/FINDINGS.md, P3 m6), so a
  rewind to the steer row likely leaves the steer text out of the
  assistant's context — as a rewind to the tool result would.
- A client that only wants ids: `get-context {payload: "uuids"}` → the
  refs of `contextAt(leaf)` in context order (not file order: boundary
  relinking reorders), no file read; `get-entries {payload: "uuids"}`
  → every canonical uuid of the log, in-context or not, in file order.

## Type design

### Module layering: `session/` is the format, `daemon/` is the policy

The test for where a session-file module lives: does it need a daemon
to make sense?

`src/core/session/` knows the file as a format and nothing about the
daemon. Any process that has a session file can use it: file.ts (path,
parse, byte ranges, `entriesByUuid`, boundary append), structural.ts
(the projection), entry-stream.ts (`SessionLogFollower`: tail one file,
deliver each terminated line; and `SessionEntryClient`, the
filter+queue adapter on it that `tail`/`format` use on a dormant
agent's file).

`src/core/daemon/` decides what the daemon keeps resident and serves
over the socket. session-tracker.ts (`SessionTracker`) holds ONE file:
structural entries + byte ranges + rolling trees, and turns each pushed
line into the socket's `sessionEntry` event — "structural resident,
full by range, payload-free on the wire when the query stream has it"
is daemon serving policy, not a file property. tracked-session-log.ts
(`TrackedSessionLog`) decides WHICH file is followed and when it
switches: it owns the follower + tracker pair, the startup scan and
the switch worker, and replaces both on a session change.

The data path is `SessionLogFollower → SessionTracker.push →
EventHub.emit`. `TrackedSessionLog` is not in it: it constructs and
replaces the first two and connects them to the third.
The follower stays separate from the tracker because two adapters
consume it (the tracker and `SessionEntryClient`) and the tracker is
then testable without a filesystem.

### Agent events (`src/core/sdk-socket.ts`)

`SdkEvent` and `AgentObservation` are replaced by:

```ts
export type AgentEvent =
  | { kind: "sdkMessage"; message: SDKMessage }
  // One per canonical log entry of the tracked file, in file order,
  // emitted as soon as the follower reads the line (never held for
  // resolution: subscribers run the same merge and decide for
  // themselves). `entry` is the complete entry when its class is
  // session-only (`excludedFromQuery`), else `structuralEntry(entry)`:
  // the subscriber already holds the payload from the `sdkMessage`
  // twin, so only what the trees and the fold read crosses the wire.
  // `expectsSdkMessage` is that class decision (false = session-only;
  // a prediction from the table, not an observation), made by
  // the tracker on the complete entry: the fold reads it rather than
  // re-classifying, because the `<local-command-stdout>` rule reads
  // `message.content`, a payload leaf the projection empties.
  // `leaf` is the context tree's leaf after this entry and
  // `lastAssistant` the usage/model of the last non-excluded,
  // non-sidechain assistant on contextAt(leaf) (absent when none; each
  // field independently optional) — daemon-computed, so a client folds
  // them without owning a tree and a restart seeds them from the scan.
  // `awaitingAnchors` lists the boundaries whose blocks are still
  // deferred (session tracker incomplete).
  | {
      kind: "sessionEntry";
      entry: SessionEntry;
      expectsSdkMessage: boolean;
      leaf: TreeNodeRef | null;
      lastAssistant?: { usage?: NonNullableUsage; model?: string };
      awaitingAnchors: readonly UUID[];
    }
  // Emitted after the sessionEntry that completes a compact_boundary —
  // the boundary's own, or its anchor's when the block was deferred —
  // whatever wrote it (native compaction or set-context). `leaf` is the
  // final post-boundary context tip (null after a wipe).
  | { kind: "contextChanged"; boundary: UUID; leaf: TreeNodeRef | null }
  // The follower moved to `sessionId`: the old file's SessionState is
  // dropped and the new file is about to be scanned.
  | { kind: "sessionFileChanged"; sessionId: UUID }
  // The follower's start() has returned for the tracked file: every
  // entry the file held when it was opened has been folded.
  | { kind: "scanComplete" }
  // The daemon appended these uuid-bearing entries to the query file
  // (set-context); emitted before the drain that delivers them.
  | { kind: "sessionAppended"; uuids: readonly UUID[] }
  // An anomaly the daemon detected — by its fold (merge errors,
  // head-mismatch: reported right after the event whose fold raised it)
  // or by its tracker (follower failure, malformed line, classification
  // at the dedup site, awaiting-anchor) — with the bundle it wrote.
  | { kind: "trackerAnomaly"; stream: MergeStream; anomaly: TrackerAnomaly; bundlePath: string }
  | { kind: "userMessageQueued"; id: number; message: SDKUserMessage } // unchanged
  | { kind: "userMessageDequeued"; delivery: MessageDelivery; ids: number[] }
  | { kind: "compactSent"; message: SDKUserMessage }
  | { kind: "interruptSent" }
  | { kind: "controlApplied"; request: SdkControlApplied }
  | { kind: "shutdown"; reason: string };

export interface AgentEventRecord {
  event: AgentEvent;
}
export type AgentEventSubscription = StreamSubscription<AgentEvent, AgentState>;
```

`SdkSocketClient` keeps its name (rename deferred; see Non-goals).

### Agent state (`src/core/agent-state.ts`)

```ts
export type MergeStream = "query" | "session";

export interface TrackerAnomaly {
  readonly kind:
    | "merge-error"
    | "head-mismatch"
    | "classification"
    | "awaiting-anchor"
    | "malformed-line"
    | "follower-failure";
  /** Names the ids, streams and classes involved, the boundary (anchor),
   *  the line's byte range (malformed), or the error (follower). */
  readonly detail: string;
}
/** The fold's view of one session: the merge of its query stream and its
 *  file, and what has been observed on it. Fields that mirror a top-level
 *  `AgentState` field (`model`) are observed evidence; the top-level one is
 *  the prediction for the next query. */
export interface SessionState {
  readonly merge: MergeState<UUID, MergeStream>;
  /** The context tree's leaf, folded from sessionEntry.leaf; null before
   *  any entry and after a wipe. */
  readonly treeLeaf: TreeNodeRef | null;
  /** The last leaf-eligible query observation still pending on `query`;
   *  null once the log has it. */
  readonly pendingLeaf: UUID | null;
  /** Boundaries whose preserved blocks are deferred behind anchors not
   *  yet in the log; the session tracker is incomplete while non-empty. */
  readonly awaitingAnchors: readonly UUID[];
  /** Usage/model observed on the last assistant message of the context
   *  (from the query stream while unsettled, from the file once settled). */
  readonly lastUsage?: NonNullableUsage;
  readonly model?: string;
  /** While true, session observations are excluded from `query`: the
   *  scan has not yet met an id the query stream reported. */
  readonly scanExcluded: boolean;
}

export interface AgentState {
  // ...existing per-agent fields (activity, permissionMode, effortLevel,
  // claudeCodeVersion, observedPermissionModes, cwd, queuedMessages,
  // deliveredMessages) unchanged; `sessionId`, `model`, `lastUsage`,
  // `leaf` move into SessionState / derive from it...
  /** Plain record (it crosses the wire in `subscribe`). */
  readonly files: Readonly<Record<UUID, SessionState>>;
  /** The query file: the latest query message's `session_id`; undefined
   *  on a fresh spawn until the first `system/init`. */
  readonly querySessionId?: UUID;
  /** The tracked file; trails `querySessionId` until the switch;
   *  undefined until the first file exists. */
  readonly fileSessionId?: UUID;
  /** Set by the fold that detected it, absent on every other state:
   *  "the event just folded was anomalous". History lives in the log
   *  and the bundles. */
  readonly anomaly?: TrackerAnomaly;
}

/** Per-agent fields only, no file: `sessions` is empty and both session ids
 *  undefined. The seed file, when it exists, enters through the
 *  `sessionFileChanged` that `TrackedSessionLog.start` emits. daemon.ts
 *  spreads the settings cascade (`model`, `permissionMode`,
 *  `effortLevel`, `cwd`) over it as it does over INITIAL_AGENT_STATE
 *  today. */
export function initialAgentState(): AgentState;

export const querySession = (state: AgentState): SessionState | undefined;
/** The query-side leaf of the query file (merge model, Leaf); null
 *  without a file. */
export const leaf = (state: AgentState): TreeNodeRef | null;
export const sessionSettled = (file: SessionState): boolean;   // !hasPending(merge, "query") && awaitingAnchors empty
/** False without a file: requests on a fresh spawn fail as today. */
export const settled = (state: AgentState): boolean;

/** The classification table, one function per side: whether the other
 *  stream never carries this occurrence. Uuid-less occurrences are not
 *  asked. `excludedFromQuery` needs the complete entry (it reads
 *  `message.content`), so the tracker calls it once per entry and
 *  publishes the answer as the event's `expectsSdkMessage`; the fold reads
 *  that. */
export function excludedFromSession(message: SDKMessage): boolean;
export function excludedFromQuery(entry: SessionEntry): boolean;

export function nextAgentState(state: AgentState, event: AgentEvent): AgentState;
```

Fold rules (the merge calls are `observe`/`excludeFrom` on the named
file's merge; a `MergeError` leaves the merge as it was and the rest
of the rule still applies — `order-violation` is a `merge-error`
anomaly, `excluded-observed` a `classification` one; the `Resolved`s
of one fold missing a stream are a `head-mismatch` anomaly naming
them all; a fold sets at most one `anomaly`, by the precedence in the
merge model, and clears it otherwise):

- `sdkMessage`: routed by `message.session_id`. An unknown
  `session_id` creates its `SessionState` (empty merge, `scanExcluded:
true`) and sets
  `querySessionId`. Then `observe("query", uuid)`; on a first
  observation, `excludeFrom(["session"])` when
  `excludedFromSession(message)`; a leaf-eligible message sets
  `pendingLeaf`; `lastUsage`/`model` from an assistant message as
  today. `system/init` touches nothing else. Per-agent fields fold as
  today. Subagent messages (`parent_tool_use_id` set) reach sinks but
  fold nothing: their entries live in the `subagents/` files, never in
  this one, so an observation would pend forever (subagent state
  tracking: docs/thoughts/subagent-activity.md).
- `sessionEntry`: routed to `fileSessionId`. Uuid-bearing entries:
  `observe("session", uuid)`; on a first observation,
  `excludeFrom(["query"])` when `event.expectsSdkMessage` is false or
  `scanExcluded`; a session observation that finds the node already
  in the merge clears `scanExcluded`. Then `treeLeaf = event.leaf`,
  `awaitingAnchors = event.awaitingAnchors`; when the file is settled
  after the observation, `lastUsage`/`model` from
  `event.lastAssistant` (each unset when absent) and
  `claudeCodeVersion` from `version` — an unsettled fold holds fresher
  query-side values a lagging entry must not overwrite.
  `permissionMode` is query-side only (`init`/`status`/`controlApplied`);
  `permission-mode` entries do not fold.
- any resolution (either stream) of the id in `pendingLeaf` clears it.
- `userMessageQueued`/`userMessageDequeued`: queue bookkeeping as
  today; no merge observation (prompts are session-only).
- `sessionAppended`: `observe("query", uuid)` for each uuid, on the
  query file.
- `sessionFileChanged`: delete `sessions[fileSessionId]`; when
  `sessionId` is that same id (a follower-failure rescan) replace it
  with `{merge: rebuilt from pending(old.merge, "query") — each
observed on "query" in order, excludeFrom(["session"]) where
old.merge.nodes[id].excludedFrom had it; pendingLeaf, lastUsage,
model: old; treeLeaf: null; awaitingAnchors: []; scanExcluded:
true}`; then `fileSessionId = sessionId`. A new file's `SessionState`
  usually exists — the query message that named the id created it —
  with `scanExcluded` still true: only session observations clear it,
  and none have been routed to it; when absent (the seed file at
  startup, before any query message) a fresh one is created.
- `scanComplete`: `sessions[fileSessionId].scanExcluded = false`.
- `trackerAnomaly`: observation only; `anomaly` stays clear (the report
  of an anomaly is not itself one).
- `contextChanged`: nothing (the boundary's `sessionEntry` already
  folded the leaf; the event exists for consumers).

### Structural projection (`src/core/session/structural.ts`)

```ts
/** The leaves that carry payload, measured over real logs (WORK LOG).
 *  Within message content only payload leaves are listed — never
 *  structural fields (`type`, `id`, `tool_use_id`, `name`, `usage`,
 *  `model`, `message.id`) the builders and set-context validation read.
 *  `**` = every string value beneath; `[]` = each element; keys are
 *  never touched. */
export const PAYLOAD_PATHS = [
  "message.content", // when a plain string
  "message.content[].text",
  "message.content[].thinking",
  "message.content[].signature",
  "message.content[].input.**",
  "message.content[].content", // tool_result: string, or blocks:
  "message.content[].content[].text",
  "message.content[].source.data",
  "toolUseResult.**",
  "attachment.**",
] as const;

/** Same shape as `entry` with every string at a PAYLOAD_PATHS leaf
 *  replaced by "" (keys and block skeleton kept, so the result is still
 *  a valid entry for the builders). Strings elsewhere are not inspected.
 *  Uuid-less entries are returned unchanged. */
export function structuralEntry(entry: SessionEntry): SessionEntry;
```

The projection is what the builders read (parent links, block ids,
`usage`/`model`, `compactMetadata` — never payload) and what a
`sessionEntry` event carries for a shared-class entry. It is a
projection, not a truncation: there is no length limit and no
`truncated` mark; a consumer that needs a payload holds its `sdkMessage`
twin or reads the range. The daemon does not retain it: an entry is
pushed into the trees on observation and dropped once every builder
has consumed its node (Session tracker).

### Parser byte ranges (`src/core/session/file.ts`)

```ts
export interface ByteRange {
  offset: number;
  length: number;
}
export interface ParsedEntry {
  entry: SessionEntry;
  range: ByteRange;
}

/** A terminated line that is not a JSON object. */
export interface MalformedLine {
  range: ByteRange;
  lineNumber: number;
  reason: "not-json" | "not-object";
}

export class SessionEntryParser {
  /** The lines terminated within this chunk, in file order, each with its
   *  byte range (line including its terminator). Corruption policy is the
   *  caller's: whole-file readers throw (`entryOrThrow`), the follower
   *  reports and skips. */
  push(chunk: Buffer): Result<ParsedEntry, MalformedLine>[];
}
/** Unchanged signature; maps ParsedEntry → entry. */
export function readSessionEntries(filePath: string): SessionEntry[];
/** The entries at the given ranges (pread + parse; no whole-file read). */
export function readEntriesAt(
  filePath: string,
  ranges: readonly ByteRange[],
): SessionEntry[];
```

### Log follower (`src/core/session/entry-stream.ts`)

`SessionEntryClient` splits into a synchronous byte-level follower and
the existing queue-based client composed on it:

```ts
/** fs.watch + byte offset + torn-suffix parser, delivering every parsed
 *  line synchronously inside the read (no first-wins filtering; that is
 *  the consumer's). A read error is retried from the last offset; a
 *  malformed terminated line is reported through `onMalformedLine` and
 *  skipped (the file keeps being followed); truncation or inode
 *  replacement is a failure (recorded byte ranges would be stale; the
 *  CLI never does this). */
export class SessionLogFollower {
  constructor(
    filePath: string,
    onEntry: (parsed: ParsedEntry) => void,
    onMalformedLine: (line: MalformedLine) => void,
    onFailure: (error: Error) => void,
  );
  /** Read the initial extent (calling onEntry per line) and start following. */
  start(): void;
  /** Consume everything visible right now, synchronously — the caller's own
   *  append is in the session tracker when this returns. Throws the follower failure
   *  (also reported via onFailure) if the read or parse fails. */
  drainVisibleBytes(): void;
  /** Resolves once `quietMs` have passed with no new bytes (the first
   *  quiet window; a drain inside it restarts the window). */
  whenQuiet(quietMs: number): Promise<void>;
  /** Resolves on failure (immediately if already failed). */
  whenFailed(): Promise<Error>;
  close(): void;
  get failure(): Error | undefined;
}

/** Unchanged public surface (subscribe/close/failure/filter,
 *  EntryClientOptions) minus the carried-`filter` constructor parameter
 *  (only AgentObserver's rollover used it); implemented as a
 *  SessionLogFollower whose onEntry runs CanonicalEntryFilter and pushes to
 *  the AsyncQueue. Kept for dormant-agent `tail`/`format`, which read the
 *  log without a daemon. */
export class SessionEntryClient implements StreamClient<
  SessionEntry,
  EntryStreamState
> {
  /* as today */
}
```

The switch itself (close one follower, open another) is the daemon's:
a follower is bound to one path, and the session tracker it feeds is
too, so `switchTo(path)` on the follower would leave the tracker
behind. `whenQuiet` is the only follower-side piece of the switch.

`waitForEntry` and `readEntriesAfterStreamFlush` are deleted (their
daemon uses are replaced by `whenSettled`; no other callers remain).

### Rolling builders (`src/core/tree/`)

Same output types as today; `buildTree`/`toContextTree`/`toDisplayTree`
become `pushAll` + `finish` conveniences over the builders.

```ts
// build-tree.ts
/** The full tree as the dependents read it; a `ParentMap` value is a
 *  finished tree (`finishedTreeView`: nodes = keys, nothing awaited). */
export interface FullTreeView {
  readonly parentMap: ParentMap;
  /** parentMap's keys as an indexable sequence for dependents' cursors
   *  (a Map key iterator cannot be resumed once it has reported done). */
  readonly nodes: readonly TreeNodeStr[];
  readonly awaitingAnchors: readonly UUID[];
}
export class SessionTreeBuilder implements FullTreeView {
  constructor(onInvalid: OnInvalid);
  /** Place `entry` (and flush any deferred block nodes it unblocks). */
  push(entry: SessionEntry): void;
  pushAll(entries: readonly SessionEntry[]): void;
  /** End of input: place nodes still deferred behind an anchor that never
   *  arrived (as buildTree does at end of file). The daemon never calls
   *  it; the live view simply omits such nodes until their anchor arrives. */
  finish(): void;
  /** Live views; grow with push. */
  readonly parentMap: Map<TreeNodeStr, TreeNodeStr | null>;
  readonly nodes: TreeNodeStr[];
  /** Boundaries whose blocks are deferred behind absent anchors, file order. */
  get awaitingAnchors(): readonly UUID[];
}
export function buildTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): ParentMap;

// context-tree.ts
export class ContextTreeBuilder {
  constructor(fullTree: FullTreeView, byUuid: ReadonlyMap<UUID, SessionEntry>);
  /** Consume the full-tree nodes materialized since the last push. */
  push(): void;
  /** End of input: the open tool group ends (its unanswered calls are
   *  dead). The daemon never calls it. */
  finish(): void;
  /** Live view: parentMap/excluded/leaf reflect every push so far. */
  get tree(): ContextTree;
  /** usage/model of the last non-excluded, non-sidechain assistant on
   *  contextAt(ref): a parent walk from ref over the builder's own
   *  per-assistant `{usage, model}` record (taken at push, so the walk
   *  reads no entries; no memo — exclusion is retroactive at group
   *  end); O(distance to the previous eligible assistant). */
  lastAssistantOn(
    ref: TreeNodeRef,
  ): { usage?: NonNullableUsage; model?: string } | undefined;
  /** Delegates to the full tree's. */
  get awaitingAnchors(): readonly UUID[];
}
export function toContextTree(
  fullTree: ParentMap,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): ContextTree;

// display-tree.ts
export class DisplayTreeBuilder {
  constructor(
    fullTree: FullTreeView,
    contextTree: Pick<ContextTreeBuilder, "tree">,
    byUuid: ReadonlyMap<UUID, SessionEntry>,
  );
  push(): void;
  get tree(): DisplayTree;
}
export function toDisplayTree(
  fullTree: ParentMap,
  contextTree: ContextTree,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): DisplayTree;
```

The builders chain: a caller pushes the entry into `byUuid` and the
`SessionTreeBuilder`, then calls `push()` on the dependents, which
consume `nodes` from their own cursor. Nodes are only ever appended
(deferred nodes are absent, not provisional), so a dependent never sees
a node move. `byUuid` is read only when a node is consumed, so a caller
that keeps no entries (the daemon) may delete an entry from it once
its node has been consumed by every dependent; entries deferred behind
an absent anchor stay until then. `ContextTree.excluded` and the display tree's hidden set are
live sets: the bounded retroactive edits (a group's `excluded` at group
end; a boundary hiding a prefix of its own block) mutate them in place.
`TreeNodeStr` (parent-map.ts) types every serialized `TreeNodeRef`.
Phase-1 work log: docs/specs/session-tracker/phase-1-rolling-builders.md.

### Session tracker (`src/core/daemon/session-tracker.ts`)

```ts
export class SessionTracker {
  constructor(filePath: string, onInvalid: OnInvalid);
  /** First-wins on uuid. Records the entry's range and class, pushes it
   *  through the two trees (on observation — structure is a function
   *  of file order; resolution is the fold's concern) and drops it once
   *  consumed, and returns the events to emit, in order: `[]` for a
   *  duplicate uuid; else the `sessionEntry` — the complete entry for a
   *  session-only class, `structuralEntry(entry)` for a shared one,
   *  `expectsSdkMessage` saying which — followed by one `contextChanged` per boundary this entry completed
   *  (its own, or those whose deferred blocks it anchored), in file
   *  order, each with the context leaf right after that boundary's
   *  block materialized. */
  push(
    parsed: ParsedEntry,
  ): readonly Extract<
    AgentEvent,
    { kind: "sessionEntry" | "contextChanged" }
  >[];
  /** Canonical uuids after `since` in file order (throws when the cursor
   *  is unknown). */
  uuidsAfter(since: UUID | undefined): readonly UUID[];
  /** Complete entries for these uuids via readEntriesAt over their
   *  ranges, requested order; throws on an unknown uuid. */
  payloads(uuids: readonly UUID[]): SessionEntry[];
  /** The context at an occurrence, as refs in context order. */
  contextAt(at: TreeNodeRef): readonly TreeNodeRef[];
  /** Every canonical uuid of the file with its byte range and class —
   *  the dedup site's existence/class check and set-context
   *  validation's existence check; entries themselves are read by
   *  range. */
  get index(): ReadonlyMap<
    UUID,
    { range: ByteRange; expectsSdkMessage: boolean }
  >;
  get contextTree(): ContextTree;
  get leaf(): TreeNodeRef | null;
}
```

The tracker retains no entries: the complete entry exists between the
parser and the end of `push`'s sinks; the structural entry lives in the
builders' `byUuid` only until every dependent has consumed its node
(deferred block rows until their anchor). Set-context validation reads
what it needs through `payloads`. Uuid-less entries (no range lookup
could name them) are emitted intact and not retained.

No display tree in the daemon. A `SessionTracker` knows one file only
(its ranges are offsets into that file); the tracked-log module below
replaces it together with the follower at every switch.

### Tracked log (`src/core/daemon/tracked-session-log.ts`)

The daemon's follow of the session log across files: the current
`SessionLogFollower` + `SessionTracker` pair, the startup scan, and the
switch worker (criterion 8, Data flow 3, the failure rescan). The hub
does not own the tracker: it emits the whole agent event stream and
is not bound to a file; it reads the tracker only at the dedup site.

```ts
export class TrackedSessionLog {
  constructor(deps: {
    hub: EventHub;
    /** The request gate; the switch's gated part takes it exclusively. */
    gate: RwGate;
    sessionFilePath(sessionId: UUID): string;
    onInvalid: OnInvalid;
    log(message: string): void;
  });
  /** When the seed file exists: emit `sessionFileChanged {sessionId:
   *  seed}`, build the follower + tracker on it, scan, `scanComplete`
   *  (Data flow 1). Then start the switch worker, which subscribes to
   *  the hub and runs whenever the folded state shows a defined
   *  querySessionId ≠ fileSessionId. */
  start(seedSessionId: UUID | undefined): void;
  /** The tracked file's tracker; replaced at a switch (so handlers read
   *  it after acquiring the gate); undefined before the first file. */
  get tracker(): SessionTracker | undefined;
  /** The follower's drainVisibleBytes (set-context, shutdown). */
  drainVisibleBytes(): void;
  close(): void;
}
```

Its follower's `onEntry` is
`(parsed) => { for (const event of tracker.push(parsed)) hub.emit(event); }`,
its `onMalformedLine` emits a `trackerAnomaly {kind: "malformed-line"}`,
and its `onFailure` emits a `trackerAnomaly {kind: "follower-failure"}`
and redirects the worker to the same-file rescan (merge model,
Anomalies); after `follower.start()` returns it emits `scanComplete`.

### Event hub (`src/core/daemon/event-hub.ts`)

```ts
export interface EventHubOptions {
  seed: AgentState;
  /** Unchanged: hands an accepted user message to the SDK (turnQueue.push)
   *  inside deliverUserMessage, so a delivered-but-unmodeled message cannot
   *  exist. Only user/SDK messages go through deliverUserMessage /
   *  observeSdkMessage (the queue model must see them); everything else —
   *  daemon actions and session entries alike — goes through emit. */
  deliver: (message: SDKUserMessage) => void;
  /** The tracked file's tracker, read only at the dedup site. */
  tracker: () => SessionTracker | undefined;
  log: (message: string) => void;
  anomalies: AnomalyRecorder;
}

export class EventHub {
  constructor(options: EventHubOptions);
  /** Sinks receive every event, post-fold, in order (as today); every
   *  subscriber sees the same sessionEntry the tracker produced. */
  subscribe(sink: (event: AgentEvent) => void): () => void;
  /** Everything with no queue-model involvement, session entries
   *  included. A fold whose state carries `anomaly` logs it at error
   *  and writes the diagnostic bundle. */
  emit(
    event: Extract<
      AgentEvent,
      {
        kind:
          | "interruptSent"
          | "compactSent"
          | "controlApplied"
          | "shutdown"
          | "sessionEntry"
          | "contextChanged"
          | "sessionFileChanged"
          | "scanComplete"
          | "sessionAppended"
          | "trackerAnomaly";
      }
    >,
  ): void;
  /** Dedup (merge model, Query-stream duplicates: needs the tracked
   *  file's index) — a session-only class at the dedup site emits
   *  `trackerAnomaly {kind: "classification"}` and drops the message,
   *  a shared class drops it silently — then fold (same anomaly
   *  handling as emit). */
  observeSdkMessage(message: SDKMessage): void;
  /** Resolves when settled(agentState) — immediately if already; rejects
   *  after SETTLE_TIMEOUT_MS naming the query file's pending("query"). */
  whenSettled(): Promise<void>;
  /** Resolves when `sessionSettled(sessions[sessionId])` (the switch's wait
   *  on the old file); same bound as whenSettled. */
  whenFileSettled(sessionId: UUID): Promise<void>;
}
```

### Anomaly bundles (`src/core/daemon/anomaly-bundle.ts`)

Diagnostics, not state: the hub delegates here; the fold knows nothing
of it.

```ts
/** Events of both streams kept as context for a bundle. */
export const ANOMALY_CONTEXT_EVENTS = 50;

export class AnomalyRecorder {
  constructor(daemonDir: string);
  /** Ring of the last ANOMALY_CONTEXT_EVENTS events as
   *  `{kind, type, subtype, uuid, session_id, apiMessageId, parentUuid}`
   *  (no payloads; stream events and subagent traffic skipped). Called on
   *  every fold. */
  record(event: AgentEvent): void;
  /** Writes `<daemonDir>/anomaly-<timestamp>.json` (merge model,
   *  Anomalies: the anomaly, the merge state before the failing call —
   *  `before.files`, the ring, `claudeCodeVersion`, the tracked and
   *  query session ids); returns the path. */
  write(anomaly: TrackerAnomaly, before: AgentState, after: AgentState): string;
}
```

### Wire (`src/core/sdk-socket.ts`)

```ts
| { type: "subscribe"; attachment?: SubscribeAttachment }              // unchanged
| { type: "get-entries"; payload: "uuids" | "full"; since?: UUID }   // → GetEntriesResponse
| { type: "get-entries"; uuids: UUID[] }                              // → SessionEntry[] complete, requested order
| { type: "get-context"; at?: TreeNodeRef; payload: "uuids" | "full" } // → GetContextResponse

/** `payload: "uuids"`: `uuids` only, no file read; `"full"`: the
 *  complete entries in file order (readEntriesAt over the ranges). */
export interface GetEntriesResponse {
  uuids: UUID[];
  entries?: SessionEntry[];
  leaf: TreeNodeRef | null;
}
/** Same convention: `refs` always (context order), `entries` for "full". */
export interface GetContextResponse { refs: TreeNodeRef[]; entries?: SessionEntry[] }
```

`SetContextResponse` (formerly `SetContextResult`) is unchanged (`boundaryUuid`). sdk-server serializes
whatever event the sink receives, synchronously (the complete entry is
not retained afterwards). A subscriber gets the `AgentState` with its
subscription and asks for history only if it wants it: `get-entries`
with `"full"` for a client that builds trees or prints the log (the
TUI, `tail` with a history range), `"uuids"` for one that only needs
identities (uuid-prefix resolution, scripts), nothing for a live-only
client (`prompt`, `tail` without `--since`).

CLI: `clauctl get-entries` sends `payload: "full"` (complete JSONL for
`format`), `--uuids` sends `"uuids"`; `clauctl context` sends `full`,
`--uuids` sends `"uuids"`; uuid-prefix resolution (`sdk-commands.ts`)
sends `"uuids"`.

### Deleted

`AgentObserver`/`AgentObservation`/`AgentObservationState`
(agent-observer.ts), `seedFromEntries`/`SessionFileSeed` (seed.ts),
`UntilSettlement`'s `consumedUuids`/catch-up machinery (tail.ts; the
class reduces to condition + `settled`), `waitForEntry`,
`readEntriesAfterStreamFlush`, the `contextChanged.request` field and
its `requestAnnotation` in format/events.ts, the stale "no-write
rewinds" comment in sdk-socket.ts, `AgentState.sessionId`/`leaf`/
`lastUsage`/`model` as top-level fields (into `SessionState`). From the
pre-redesign phases: `SLIM_STRING_LIMIT`, `slimEntry`, `SlimProjection`
and slim.ts (renamed structural.ts with `PAYLOAD_PATHS`/
`structuralEntry`), `truncated` on events and snapshots, `EntryPayload`
and the hub's full/slim sink sets, `subscribe`'s `entryPayload`,
`payload: "slim"`, `SessionTracker.entries`.

## Data flow

1. **Startup.** daemon.ts builds `initialAgentState()` (plus the
   settings cascade) and calls `trackedLog.start(seedSessionId)`, which,
   when the seed file exists, emits `sessionFileChanged` (creating the
   `SessionState`), opens `SessionLogFollower(path, onEntry)` on it and
   calls `start()`: every existing line goes through
   `sessionTracker.push(parsed)` → `hub.emit` with no subscribers
   attached; each is a session observation excluded from
   `query` (`scanExcluded` holds — no query message exists yet), so
   the merge stays empty; then `scanComplete`. The fold state after the
   scan _is_ the seed (settled, `treeLeaf`, `leaf` = `treeLeaf`,
   `lastUsage`/`model` from the context's last assistant, version,
   mode). The complete entry is dropped after the sinks run; only the
   structural entry + range are retained.
2. **Live.** Query message → `hub.observeSdkMessage` (dedup; fold:
   route by `session_id`, observe on `query`, class exclusion; dequeues
   follow as today and observe nothing). fs event → follower
   reads new bytes → parser → `sessionTracker.push(parsed)` (index
   range + class, structural entry into the builders' `byUuid`,
   `SessionTreeBuilder.push`, `ContextTreeBuilder.push`, consumed
   entries deleted, leaf, lastAssistant; the entry that
   completes a boundary — its own or its anchor's — returns a
   `contextChanged` after its `sessionEntry`) → `hub.emit` per event
   (fold: observe on `session`, class/scan exclusion). Sinks receive
   events synchronously, post-fold; a shared-class `sessionEntry`
   carries the structural entry, a session-only one the complete
   entry.
3. **Switch.** Criterion 8's sequence, run by `TrackedSessionLog`'s worker,
   which is started when the folded state shows `fileSessionId ≠
querySessionId` after an `sdkMessage` and none is running: `await
hub.whenFileSettled(fileSessionId)` (timeout logged, not fatal),
   `await follower.whenQuiet(SESSION_FILE_QUIET_MS)` — both skipped on
   a fresh spawn (`fileSessionId` undefined: no old file, no
   follower) and both abandoned when the follower fails meanwhile
   (`follower.whenFailed()` wins the race) — then under the exclusive
   gate: `follower.close()`, new `SessionTracker(nextPath)` replaces
   the old one, `hub.emit(sessionFileChanged {sessionId: next})`, new follower
   `start()` (scan → `emit`, excluded from `query` until
   the scan meets a query-reported id), `hub.emit(scanComplete)`;
   release; repeat while `fileSessionId ≠ querySessionId`. The reader
   loop never waits on it. The next file's path is derived from its
   session id as today (`SESSION_FILE_TIMEOUT_MS` bounds waiting for it
   to exist). A follower failure starts the same worker (or redirects
   the running one) with `next = fileSessionId`, gated part only; the
   loop condition then takes over (merge model, Anomalies).
4. **`get-entries` / `get-context`.** `await hub.whenSettled()` outside
   the gate; gate shared; take `trackedLog.tracker`; if no longer
   `settled`, release and repeat; serve
   `sessionTracker.uuidsAfter(since)` /
   `sessionTracker.contextAt(at ?? sessionTracker.leaf)`, mapped through
   `sessionTracker.payloads` (file/context order) for `payload:
"full"`.
5. **`set-context`.** Same protocol as 4 with the exclusive gate:
   `await whenSettled()` outside the gate; gate exclusive; take
   `sessionLog.tracker`; if no longer `settled`, release and repeat;
   validate the requested list against
   `sessionTracker.index`/`sessionTracker.contextTree` (entries via
   `payloads`);
   `teardownQuery`; `appendSessionEntries`; `hub.emit(sessionAppended
{uuids})` with the uuids of what was appended (the boundary and, for
   a summary boundary, its summary); `follower.drainVisibleBytes()`
   (synchronous: the drain consumes both, resolving them, and the
   boundary is complete and `contextChanged` emitted when it returns);
   `restartQuery`; respond. Any failure after `teardownQuery` (append,
   drain, restart) marks the query unavailable
   (`setQueryAvailable(false)`, today's mechanism: Query-bound requests
   refuse, a later `set-context` restarts) and the error names the
   failing step. A `compact_boundary` observed in the log restarts the
   query only if it is down; only `set-context` stops it (natural
   compactions do not restart it today; kept).
6. **Clients.** `subscribe` gives the `AgentState` and the live stream;
   nothing else is assumed of a client. Every event is folded into the
   client's `AgentState` in socket order — the client's fold is the
   daemon's, merge included. A client that wants history (the TUI,
   `tail`) sends `get-entries {payload: "full"}` after subscribing
   (events buffer in the socket meanwhile). What differs before the
   response is the tree: a `sessionFileChanged` received before it
   resets the client's model (so a switch that lands between subscribe
   and response cannot wipe the snapshot afterwards), and
   `sessionEntry` events received before it are not pushed into the
   tree; then the snapshot is applied; then live `sessionEntry` events
   are pushed. Not pushing is sound because the handler computes the
   snapshot and writes the response without yielding, and sinks run
   synchronously inside the follower's read, so no event can fall
   between the snapshot and the response on the socket: everything
   received before the response is in the snapshot, everything after
   it is not. No cursor is needed for the handoff, which is what lets
   uuid-less entries (relevant only to `tail --type entries`) ride
   along without an identity of their own.

   The TUI keeps `byUuid: Map<UUID, SessionEntry>` (complete entries
   from the snapshot, then whatever each live `sessionEntry` carries —
   structural for shared classes) feeding its
   `SessionTreeBuilder`/`ContextTreeBuilder`/`DisplayTreeBuilder`, and
   a separate `Map<UUID, SDKMessage>` of `sdkMessage` payloads by their
   entry uuid for rendering. The trees are a function of the entry
   stream alone — the same function the daemon computes and a restart
   recomputes from the file — so the live structure equals the
   structure after a restart (`compactMetadata` rides intact, so
   boundaries place identically). The two maps hold different
   information for the same uuid (the entry has the links and
   structure, the SDK message the payload), so rendering a node checks
   both: the complete entry (history), the SDK message (live shared
   entry), or the intact entry (live session-only entry: attachments,
   prompts); nothing is refetched. A `queued_command` attachment is a
   display-tree row rendered as a user message (criterion 7). `/tree`
   and `reloadHistory` read local state. On `sessionFileChanged` it
   resets its model and rebuilds it from the scan's events (criterion
   8). `tail --type entries|messages` uses the same handoff: subscribe
   (buffering), `get-entries {payload: "full", since}` (`--since` is a
   uuid cursor, as today), print the snapshot, skip printing the
   `sessionEntry` events received before the response (they are in the
   snapshot), then print live `sessionEntry` events (structural for
   shared classes: `--type entries` prints what the wire carries; the
   payload printed alongside is the `sdkMessage`).
   `--until` order: print the snapshot, then evaluate the condition
   against the state at subscription (an already-idle agent completes
   here), then against buffered/live events in order; once latched,
   completion awaits `settled(state)`. `prompt --type entries|messages`
   stays live-only.

7. **Shutdown.** Criterion 9's sequence under the exclusive gate.

## Cost

- **Daemon resident:** the index (uuid → range + class) + full/context
  trees (+ the `nodes` array, the context tree's per-assistant
  usage/model records) + structural entries deferred behind absent
  anchors. Far below the slim measurement's 40–65 MB for the 167 MB /
  50k-entry fixture (no entries are retained; criterion 10 keeps the
  80 MB bound as a ceiling) versus 240 MB of complete entries.
  Complete entries exist only transiently per parsed chunk. Startup
  remains one full parse (~390 ms on that fixture) — the only
  whole-file read.
- **Per live entry:** one structural walk (proportional to the entry's
  size; serves residency and, for shared classes, the wire) + two
  builder pushes (O(1) placement; `lastAssistantOn` is O(distance to
  the previous eligible assistant)) + one merge observation
  (O(unresolved nodes touched), a handful) + one `JSON.stringify` per
  subscriber.
- **Wire per entry:** structural bytes for shared classes (the payload
  went out once, as the `sdkMessage`); the whole entry for session-only
  classes — attachments are the bulk (16 MB of the 267 MB measured
  log, docs/specs/session-tracker WORK LOG), sent intact once per
  subscriber. Named cost; a client cuts them for display if it wants.
- **Per `get-entries`:** `"uuids"` is a stringify of the uuid list
  (~2 MB on the 50k fixture), no file read. `"full"` re-reads and
  re-parses every range: ~the startup cost, on demand — paid once by a
  TUI at attach (it renders history from these entries) and by
  `clauctl get-entries` for `format`.
- **Payload reads:** O(requested bytes), `pread` at recorded ranges.
  The log is append-only (truncation/replacement is a follower
  failure that discards the ranges), so a served range is never stale.
- **TUI resident:** the complete history entries it fetched + the live
  entries as received + its SDK-message map + three trees — more than
  the daemon (it holds payloads for rendering), per attached TUI; a
  TUI that wants less slims its own copy.
- **Merge residency:** the live lag — unresolved nodes are ids one
  stream has and the other has not passed (a flush's worth), plus
  `awaitingAnchors`. Scan entries never accumulate (excluded from
  `query`, they resolve as folded). A merge is copied per observation
  (structural sharing of untouched nodes; stream-merge.md Cost). One
  merge per file in `sessions`, at most a few files during a switch.
- **The switch's quiet period:** `SESSION_FILE_QUIET_MS` of follower
  latency on every `/clear`/`/fork`, paid only so `tail --type entries`
  sees the old file's log-only trailing rows; requests on the new file
  wait for it. Named cost.

## Edge cases

- **Duplicate uuids in the log** (re-persisted history): first-wins in
  the session tracker as today; the duplicate line is not pushed and
  emits no event; its bytes are skipped. A duplicate that reaches the
  merge (filter bug) is an `order-violation` anomaly.
- **Duplicate uuids on the query stream**: the merge model's dedup
  rule; dropped before the hub.
- **Entries without uuid** (`file-history-snapshot`, `queue-operation`):
  canonical, emitted as `sessionEntry` intact, not retained, no tree
  occurrence, no merge observation.
- **Malformed log line**: `malformed-line` anomaly, skipped; the
  follower continues. A deterministic parse failure therefore never
  triggers a rescan (which would meet the same line again).
- **Follower failure** (truncation, inode replacement): anomaly; the
  switch worker takes the exclusive gate at once and rescans the same
  file while the query keeps running; query-pending ids survive the
  rescan (merge model, Anomalies). A merge error drops one
  observation. Neither needs a daemon restart.
- **Query stream reports a uuid the log never delivers** (crash before
  flush): it stays pending on `query`; `whenSettled` rejects after
  `SETTLE_TIMEOUT_MS` naming the uuids — a diagnosis, not a hang, and
  it persists across query restarts until the uuid appears or the
  daemon restarts.
- **Log delivers a shared uuid the query stream never reports**: it
  stays pending on `session` until the next query item closes it, then
  resolves with a head-mismatch anomaly; harmless for settledness.
- **Old file still writing at the switch**: settlement covers only
  shared ids; log-only trailing rows are covered by the quiet period
  (criterion 8). A row written after the close is lost; the daemon
  logs the settle timeout when the old file never delivers what the
  query reported.
- **Query message for the new file while the old is still tracked**:
  it folds into `sessions[new]` and waits there; the scan of the new file
  resolves it. The follower is never behind by more than one switch
  at a time; several pending files switch in order.
- **Dangling anchor** (a boundary whose anchor never arrives —
  hand-crafted/corrupt): `awaitingAnchors` keeps it, `whenSettled`
  rejects by timeout naming the boundary; the live file cannot
  distinguish "never" from "not yet".
- **Boundary before its anchor in the log** (every up_to compaction;
  also hand-crafted shapes): the block rows stay deferred in the live
  tree until the anchor arrives, the session tracker is incomplete
  meanwhile; `finish()` places them as `buildTree` does at end of file
  (criterion 2 covers every prefix).
- **`compactMetadata`, `cwd`, `gitBranch`, `slug`, uuids, timestamps,
  block ids, `usage`, `model`, `message.id`** are outside
  `PAYLOAD_PATHS` and always present, whatever their length; the
  builders and set-context validation read only untouched fields. A
  boundary's summary lives in the summary entry's `message.content`
  (a shared class: the summary text reaches subscribers as the
  `sdkMessage` twin).
- **A shared-class entry whose twin the client never saw** (client
  attached after the `sdkMessage`, before the entry; or the CLI
  dropped it): the client holds a structural entry and no payload. The
  tree is unaffected; rendering shows an empty payload until the
  client fetches by uuid — the attach handoff makes this a window of
  one flush at most.
- **`get-entries {since}` with an unknown cursor:** error, as
  `canonicalizeEntries` does today. After a switch the cursor is
  resolved against the tracked file's session tracker only.

## Non-goals

- Renaming `SdkSocketClient`/`sdk.sock` or the `sdkMessage` event kind.
- Any truncation or slimming on the daemon side (a display-length cut
  of attachment bodies is the client's).
- Deferring a `sessionEntry` until its merge node resolves (the daemon
  emits on observation; a client that wants resolved-only rendering
  reads its own fold).
- Incremental TUI redraw on `contextChanged` (diffing the preserved list
  against the previous path) — the boundary now carries what is needed;
  the redraw itself stays whole.
- Replaying entries inside `subscribe`; the daemon serving tree deltas.
- Token estimates for rewind-and-append boundaries (`lastAssistant`
  reports the rewind part's usage; the appended messages are not
  counted) — follow-up.
- Any change to `loadedContext`, the wire normalization stage, or
  set-context validation semantics.
- Driving the queue model from `command_lifecycle` messages
  (queued/started/completed per stamped uuid; docs/derisk/uuid-stamping/)
  instead of dequeue inference — noted for later.

## Follow-up work

Not in this spec's phases; each gets its own spec afterwards. Done
earlier only if it simplifies the work at hand.

- **daemon.ts factoring.** daemon.ts is the composition root and should
  only wire modules together. Candidates that still carry logic there:
  the query lifecycle (Query + TurnQueue + reader loop +
  `teardownQuery`/`restartQuery`/`watchReader`/`daemonStreamDone`, three
  mutable slots) as a `query-runner.ts` module with `start(resume?)`,
  `teardown()`, `restart(resume)`, `get query`, `get turnQueue`,
  `whenEnded()`; and startup classification (agent.json vs
  spawn-options.json → record + resume id) as a pure function in
  registry.ts.

# IMPLEMENTATION IDEAS

Phases (each leaves the suite green; the AGENTS.md one-pass bullet is
retired with phase 1):

1. **Rolling builders.** Convert the three functions into builders with
   `finish()`; keep the functions as `pushAll` + `finish` wrappers; add
   the per-prefix equivalence test over the corpus (criterion 2); add
   `lastAssistantOn`. Pure, no daemon changes.
2. **Parser ranges + slim + follower split.** `ParsedEntry`,
   `readEntriesAt`, `slimEntry`, `SessionLogFollower` (with
   `whenQuiet`, offset retry, failure conditions) under the unchanged
   `SessionEntryClient` surface. (Done before the redesign; phase 3
   turns `slimEntry` into `structuralEntry`.)
3. **Fold + session tracker.** `AgentEvent`/`AgentState`/`SessionState`,
   `excludedFromSession`/`excludedFromQuery` (from the classification
   table; the stream-classification test becomes its fixture),
   `nextAgentState`, `SessionTracker` (structural residency, per-class
   event shape), `structuralEntry` replacing `slimEntry`, `EventHub`
   single sink set, `whenSettled`/`whenFileSettled`/dedup, anomaly log
   - bundle, daemon.ts composition (startup scan, the switch incl. the
     failure rescan, shutdown drain), request handlers served from the
     session tracker, set-context drain, delete seed.ts and the
     flush-wait helpers.
4. **Wire + clients.** `get-entries`/`get-context` shapes (`payload:
"uuids" | "full"`, `GetEntriesResponse`, `GetContextResponse`); `tail`/`prompt`
   on the agent event stream (delete `AgentObserver`); TUI entry +
   SDK-message maps, rolling trees, the `queued_command` display row,
   and the anomaly banner; CLI `--uuids`; format annotation.
5. **Docs.** `docs/socket-interface.md` (the interface and its
   observability philosophy) and `docs/stream-merging.md` (deep dive:
   the classification table moves there); session-views.md takes the
   tree-maintenance discussion; docs/claude-agent-sdk.md brought up to
   date: references to the deleted `AgentObserver` removed, links to
   the new docs, anything covered in depth elsewhere trimmed to a
   pointer, "tested by" pointers into tests/sdk/; status headers on
   every completed spec; remove the AGENTS.md one-pass bullet. Plan and
   log: docs/specs/session-tracker/phase-5-docs.md.

Notes:

- The dedup check lives in `EventHub.observeSdkMessage` (it needs the
  tracked file's `index` — read through a `tracker: () =>
SessionTracker | undefined` dependency, the hub's only contact with
  the tracker — and the query file's merge) and doubles as
  the classification check. Anomaly reporting is one place: the hub
  reads `anomaly` off each folded state and logs + writes the bundle
  when present; the TUI latches it into the banner, so it needs no new
  wire event — every subscriber folds the same events.
- The scan-exclusion site in the fold carries the O(n²) rationale
  (merge model, Observations) as a comment; it is the one place a
  reader would otherwise "simplify" by observing scan entries.
- The bundle's stream trail is a ring of `ANOMALY_CONTEXT_EVENTS` (50)
  `{kind, type, subtype, uuid, session_id}` records kept by
  `AnomalyRecorder` (not the fold: it is diagnostics, not state).
- `whenSettled` timeout value: reuse `CATCHUP_TIMEOUT_MS` (10 s) as
  `SETTLE_TIMEOUT_MS`; it is the same bound with the same meaning.
- `SESSION_FILE_QUIET_MS` (old-file quiet period before the switch,
  criterion 8): 500 ms to start. Nothing signals that it is too short
  (rows written after the close are lost silently); `tail --type
entries` across a `/clear` is the only observer.
- `lastAssistantOn` needs no entry read: the context tree builder
  records `{usage, model}` per assistant node at push (phase-1 builder
  change, done in phase 3 step 1b).
- The switch holds the request gate exclusively for the scan of the new
  file (the one whole-file read criterion 1 permits after startup); a
  50k-entry scan is ~400 ms, comparable to today's per-request read.
  Every scanned entry is also broadcast (per-class shape) to
  subscribers — a snapshot's worth of bytes per subscriber, once per
  switch.
- Leaf-eligibility for `pendingLeaf` is the predicate the fold uses
  for `leaf` today (uuid-bearing, non-meta, non-sidechain / no
  `parent_tool_use_id`, user/assistant).

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

Each phase keeps its own work log at `docs/specs/session-tracker/phase-N-<name>.md`
(created when the phase starts); this section holds only the derisk
summary, cross-phase decisions, and the phase checklist.

## Redesign: payload-free shared entries (2026-09-12)

Full report with evidence and motivation:
docs/specs/session-tracker/redesign-2026-09-12.md. Decisions (Anton,
now expressed in the body):

1. Dual stream stays; the file stream is required (attachments are in
   assistant context and in native preserved lists; the query stream
   carries no `parentUuid`). No dependence on CLI properties such as
   honoring stamped uuids.
2. `sessionEntry` is emitted on observation, never held for
   resolution; clients fold the merge themselves.
3. Per-class wire shape: session-only entries intact (attachments
   whole), shared entries as `structuralEntry` (payload strings
   emptied; block skeleton, `usage`/`model`/`message.id`,
   `compactMetadata` kept — the builders read them). Slimming
   (`SLIM_STRING_LIMIT`, `truncated`, `payload: "slim"`, full/slim
   sink sets) is deleted; `slim.ts` becomes `structural.ts`.
4. Trees are a function of the entry stream: live structure == restart
   structure; the TUI builds from its subscription and never calls
   `get-context` for `/tree`.
5. Daemon residency: index (uuid → range + class) + trees; entries are
   pushed on observation (structure is a function of file order;
   resolution is the fold's concern) and dropped once consumed;
   payloads by range only. `get-entries`/`get-context` take `payload:
"uuids" | "full"`; a subscriber gets `AgentState` and asks for
   history only if it needs it.
6. A steered prompt (`queued_command` attachment) is a display-tree
   user row keyed by the attachment's own uuid — an ordinary
   in-context node, no relink — live and from history.
7. Classification fix: `/compact`'s `<local-command-stdout>` `user`
   entry is shared (query replays it with `isReplay`); the table row
   and `excludedFromQuery` are corrected.
8. `sessionEntry.expectsSdkMessage`: the tracker classifies the complete entry
   once and the fold reads the flag — a structural entry has lost the
   `message.content` the stdout rule reads, so a subscriber cannot
   reclassify it.

## Rewrite on stream-merge (2026-09-10/11)

Reviewer rounds 6–9 kept finding blockers in the ad-hoc pending-list
model (history prefixes, `/fork` copies, rollover truncation). Anton
re-founded the design on a general N-stream merge
(docs/specs/stream-merge.md, implemented, pure `MergeState`) and
rewound to this spec. Decisions taken for the rewrite (settled with
Anton; now expressed in the body):

1. Merge is plain data in `AgentState`, one per file; the fold stays
   pure; clients fold the same events.
2. Scan entries are excluded from `query` until the scan meets a
   query-reported id (replaces `historyReplayed`/`historyPending`).
3. One leaf per file: pending query leaf else tree leaf (replaces
   `queryLeaf` seeding).
4. Daemon actions are query observations (`sessionAppended`; not
   dequeue — revised 2026-09-11, below).
5. Per-file `SessionState`; query items routed by `session_id`; a new id
   makes its file active at once; the reader never pauses.
6. Switch = settle + quiet → close → `sessionFileChanged` → scan;
   `system/init` resets nothing.
7. Merge errors are anomalies (revised 2026-09-11, below; originally
   "fail the tracker").
8. A log boundary restarts the query only if down; only `set-context`
   stops it.
9. Handoff: every event folds; builders get snapshot then live entries.
10. Query duplicates: first-wins dedup before the merge using `byUuid`
    - merge nodes (Anton 2026-09-11; the `/cost`-after-`/compact`
      case).

Derisk: docs/derisk/stream-classification/ (table),
docs/derisk/uuid-stamping/ (stamped prompt uuid persisted; steer
caveat; `/clear` persists its command entry in the new file);
tests/sdk/stream-classification.test.ts pins the table.

Deviations from the decision list as written, for round 10: the fold
tracks `followed` beside `active` (session entries must route to the
follower's file); the scan's end is a `scanComplete` event (decision
2's exclusion is a fold rule, so clients need the boundary); the
follower exposes `whenQuiet` and the daemon performs the switch
(`switchTo` would deliver the new file's entries into the old
tracker); duplicates are dropped before the hub (not broadcast);
`contextChanged` folds nothing.

Anton's review of the rewrite (2026-09-11, ffdf712) resolved the two
open items and revised the list: prompts are session-only and never
query observations — clauctl keeps not stamping `SDKUserMessage.uuid`
(the `/clear` command entry lands in the new file, so the fold could
not name the file to observe it on; cost: a request right after
`prompt --append` does not wait for the entry). Merge errors,
head-mismatch, `awaiting-anchor` and follower failure are non-fatal
anomalies: state-carried (`AgentState.anomalies`), logged, bundled
(`anomaly-<timestamp>.json`), shown as a TUI banner asking for the
bundle; recovery is merge reset (re-armed scan exclusion) / nothing /
same-file rescan. Also: "pending" now means the library's (observed,
unresolved); `active`/`followed` → `querySessionId`/`fileSessionId`
("query file"/"tracked file"); `SessionId` → `UUID`; classification
functions return booleans; `FoldStep`/`foldAgentEvent` dropped for
`nextAgentState`; `longOutsideAllowlist` and the query-duplicate debug
log removed (both noise).

Round 10 (six blockers, all accepted): `excluded-observed` is
unreachable with two streams (exclusion resolves and forgets the
node), so the table is falsified at the dedup site instead — a
`byUuid` hit with no merge node is a `classification` anomaly when the
entry's class is session-only, a duplicate otherwise; the query-only
direction is not checked. A merge reset also clears `pendingLeaf`; a
follower failure (truncation/replacement only — malformed lines are
skipped with an anomaly, so a deterministic parse failure cannot loop
the rescan) takes the exclusive gate at once and replaces the
`SessionState`. `querySessionId`/`fileSessionId` are optional (fresh
spawn has no file); `sessions` is a record, not a Map (wire). One anomaly
per fold, detected by reference; the banner names the daemon dir's
`anomaly-*.json`. The `/clear` example had the prompt as a query
observation; fixed.

Round 11 (six blockers, all accepted): the resident-node
classification check (an observation finding its node already there
while its class says the other stream never carries it); the merge
reset is gone — the only reachable `MergeError` is a same-stream
repeat, so the failing observation is dropped and nothing else
changes (the reset's re-armed exclusion made a log-first query copy
look like a duplicate); the same-file rescan carries
`pending("query")` and `pendingLeaf` into the fresh `SessionState`; a
fresh spawn's first `system/init` runs the gated part only; the hub
emits `trackerAnomaly {classification}` before dropping the message;
one switch worker handles failures too (`whenFailed` races the
waits).

Round 12 (four blockers, all accepted): `excluded-observed` is
reachable for a resident excluded node and is the query-first
classification detector, reported as `classification` with the
observation dropped; one anomaly per fold by precedence; the rescan
rebuild reapplies each carried node's `excludeFrom(["session"])` and
carries `lastUsage`/`model` with `pendingLeaf`.

Anton's second review (5872b9f): `anomalies` list → `anomaly?` on the
state that detected it (history is the log and the bundles; the TUI
latches the banner); the round-11 resident contradicting-class check
dropped — head-mismatch already covers a wrong "shared" row and the
dedup site / `excluded-observed` a wrong "one-sided" row, laid out as
a matrix in the Classification table section.

## Derisk summary (2026-09-08)

Measurements (real logs): 40 MB/15k entries: parse 107 ms, trees 15 ms,
stringify 138 ms, heap 58 MB. 167 MB/50k: parse 389 ms, trees 28 ms,
stringify 558 ms, heap 240 MB. 1.2 GB/363k: parse 3.9 s, heap 1.67 GB.
Conclusion: trees are cheap; the cost is re-reading and shipping the
file, concentrated in the long-lived daemons.

Slim allowlist measurement (267 MB + 273 MB logs, strings > 200 chars,
bytes): user `message.content[].content` 102 M, user `toolUseResult.*`
132 M (file.content, originalFile, stdout, content, new/oldString,
structuredPatch, results, task.output), assistant
`message.content[].signature` 66 M, user `message.content` (string)
20 M, assistant `message.content[].text` 18 M, `attachment.*` 16 M,
assistant `message.content[].input.*` 11 M (content, new/old_string,
command), queue-operation `content` 0.3 M. Nothing else exceeded 200
chars; `cwd`/`slug`/uuids/`file_path` are all short.

Decisions:

- Slim cuts only beneath `SLIM_PATHS` (Anton: an allowlist cannot
  accidentally cut `cwd`-like fields); over-limit strings elsewhere are
  logged, not cut.

Review rounds 1–5 (reviewer 250edc4d, 2026-09-08/09), still standing:
full-payload subscribers need the complete entry → hub sink gets
event + slim projection; `get-entries full` needs uuid-less entries →
`entries(since, payload)`; snapshot/stream handoff → events received
before the response are folded, not pushed (socket ordering; no
cursor); `payloads` in requested order; deferred rows vs prefix
equivalence → `finish()`; "every assistant between boundaries is on
the context" was false (boundary-less forks) → `lastAssistant`
computed on the context tree per row; drain throws; the switch is
serialized under the gate; uuid-less entries never slimmed;
`boundaryUuid` kept; up_to boundaries are incomplete until their
anchor (`awaitingAnchors`; `contextChanged` on completion); requests
await settlement outside the gate; failures after teardown mark the
query unavailable; slim targets payload leaves, never block ids;
shutdown under the gate; `completedBoundaries` sidecar on
`SessionTracker.push`; `--until` seed evaluation after the snapshot
print. Superseded by the rewrite: the symmetric pending lists and
their truncation rule, `historyReplayed`/`historyPending`, `queryLeaf`
on `sessionEntry`, `sharedUuidOf*`, the cross-file tracker question.
Declined: TUI full-payload cache for live messages.

- Terminology query stream / session log / agent event stream; new
  `docs/agent-events.md`; `AgentObservation` → `AgentEvent` with
  `sessionEntry` variant, `SdkEvent` removed, `AgentObserver` deleted;
  `SdkSocketClient` rename deferred (Anton).
- `contextChanged` emitted on the boundary's arrival in the log, carrying
  `{boundary, leaf}`; `request` dropped (Anton, after considering
  incremental redraw: the boundary's preserved list is the diff, the
  request is not).
- Slim = same entry structure, all strings cut to 200, entry-level
  `truncated`; per-field marks deferred; TUI fetches on ctrl+o expansion
  only (Anton/me).
- `get-context` SessionTracker API returns refs; payload chosen by the request
  (Anton).
- TUI owns one `DisplayTreeBuilder` composing the other two, plus its
  own slim copy (Anton: acceptable).
- Stale "no-write rewinds" comment in sdk-socket.ts to be fixed here.
- `lastUsage` reports the estimated context of the next request, like
  `contextAt`: after a boundary it is the last assistant's usage on the
  context (Anton). Open: token estimate for rewind-and-append's appended
  messages (tokenizer choice) — follow-up, not in this spec's phases.

Tasks:

- [x] Phase 1 rolling builders + per-prefix equivalence test
      (docs/specs/session-tracker/phase-1-rolling-builders.md, 2026-09-11)
- [x] Phase 2 parser ranges, slim, follower split
      (docs/specs/session-tracker/phase-2-parser-ranges-slim-follower.md, 2026-09-11)
- [x] Phase 3 fold + session tracker + daemon composition
      (docs/specs/session-tracker/phase-3-fold-session-tracker.md, 2026-09-13)
- [x] Phase 4 wire + clients (tail/prompt/TUI/CLI)
      (docs/specs/session-tracker/phase-4-wire-clients.md, 2026-09-13)
- [x] Phase 5 docs
      (docs/specs/session-tracker/phase-5-docs.md, 2026-09-16)

_Work log entries go here_
