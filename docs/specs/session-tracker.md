# Spec: session tracker — the daemon follows the session log and merges it into the agent event stream

> Status: **DRAFT, rewritten on top of docs/specs/stream-merge.md
> (2026-09-11); reviewer-approved at round 13, awaiting Anton's
> review.** Follow-up to
> docs/specs/get-context.md (its Cost section anticipated this) and
> docs/thoughts/get-entries-caching.md. Derisk rounds and the rewrite's
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
  **session tracker** — slim entries, byte ranges, the rolling full tree
  and context tree — from startup on. It never re-parses the log and
  never rebuilds a tree; full payloads are re-read by byte range on
  request.
- **One agent event stream.** sdk.sock emits the union of query-stream
  messages, log entries, and daemon bookkeeping — "the interface we wish
  the claude CLI provided". `AgentObserver` (client-side merge) goes
  away.
- **Settledness is a fold fact**, not a file re-read: the two streams
  are merged by docs/specs/stream-merge.md's library inside the fold,
  and the state says whether the log has caught up with the query
  stream.
- **Slim entries by default.** Strings in the fields known to carry
  bulk (message content, tool results, attachments) are cut to
  `SLIM_STRING_LIMIT`; full payloads are fetched by uuid only when a
  view renders beyond the cut. Trees and default rendering need nothing
  more.
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
- **`FileState`** — the per-file part of `AgentState`: merge, tree
  leaf, pending leaf, `awaitingAnchors`, `lastUsage`/`model`.
- **settled** — a `FileState` with nothing pending on `query` and no
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
from `query` while `FileState.scanExcluded` holds — from the file's
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

| side    | class                                                                                                                                                              | other side                                                                                                                                                                               | evidence                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| query   | `assistant`                                                                                                                                                        | session `assistant`, or session `system/local_command` (slash-command output; same uuid, different class)                                                                                | captures, probe                                      |
| query   | `user` (tool results, compaction summary)                                                                                                                          | session `user`                                                                                                                                                                           | captures, probe                                      |
| query   | `system/compact_boundary`                                                                                                                                          | session `system/compact_boundary`                                                                                                                                                        | live compact, probe                                  |
| query   | `result`, `system/init`, `system/status`, `system/thinking_tokens`, `stream_event`, `tool_progress`, `rate_limit_event`, task/notification/session_state, `hook_*` | none (query-only)                                                                                                                                                                        | probe (`hook_*` never observed on either stream)     |
| session | `assistant`, `user` tool results / summaries, `system/compact_boundary`, `system/local_command`                                                                    | query (above)                                                                                                                                                                            | probe                                                |
| session | `user` prompts (ours and the CLI's `<command-name>` entries)                                                                                                       | none (session-only): the query stream never echoes a prompt; clauctl does not stamp `SDKUserMessage.uuid` (the CLI would persist it — docs/derisk/uuid-stamping/ — but see Observations) | docs/derisk/uuid-stamping/                           |
| session | local-command `user` entries (`isMeta`: `<local-command-caveat>`, `<local-command-stdout>`)                                                                        | none (session-only)                                                                                                                                                                      | probe                                                |
| session | `attachment`, `system/{stop_hook_summary, turn_duration, api_error, away_summary, informational, model_*_fallback}`                                                | none (session-only); `turn_duration`/`api_error` not yet observed                                                                                                                        | probe (`stop_hook_summary`, `attachment`), 349 files |
| —       | uuid-less log classes (`last-prompt`, `queue-operation`, `mode`, `permission-mode`, `ai-title`, `file-history-*`, `agent-*`, `atis-latch`, …)                      | never enter the merge                                                                                                                                                                    | 349 files                                            |

Evidence: SDK 0.3.258 `sdk.d.ts` (every `SDKMessage` variant carries
`uuid`; optional only on host-pushed `SDKUserMessage`); 349 real
session files; echoed-message-placement captures (11/11
assistant/user uuids in the paired file); a live `/compact` on
2026-09-10; docs/derisk/stream-classification/ and
docs/derisk/uuid-stamping/ (probes, 2026-09-11).
tests/sdk/stream-classification.test.ts pins the table and the same
relative order of shared uuids on both streams. `excludedFromQuery` on
a `user` entry is "no `tool_result` block and not a compaction
summary" — tool results and summaries are the shared `user` classes.

Unknown rows are treated as **session-only** (excluded from `query`).
A wrong row surfaces as an anomaly (below) in one of two ways:

| table says           | reality   | detected by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared               | one-sided | **head-mismatch**: the id resolves only when a successor closes it, with `seenOn ∪ excludedFrom` missing the absent stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| one-sided (excluded) | shared    | the excluded node resolves at once and is forgotten, so there is no `Resolved` to inspect when the other stream shows the id. Resident behind a pending predecessor: the library's `excluded-observed`. Forgotten: on the query side the **dedup site** — a `byUuid` hit with no merge node whose entry class is session-only (a shared class is a duplicate, Query-stream duplicates); on the session side the fresh node pends and closes as a **head-mismatch** unless the entry's own class is also session-only, in which case nothing fires — both sides agree it is one-sided, and the merge is unharmed. |

A `system/init` never carries a shared id; `sessionFileChanged` is a
daemon event, not an SDK message.

### Query-stream duplicates

The CLI re-emits a shared uuid on the query stream in at least one
case (`/cost` output re-sent after a `/compact` that preserved it as
tail; docs/derisk/stream-classification/README, 2/2; the copies are
equal modulo `message.id`). Unresolved, a repeat is an
`order-violation`; resolved, it would create a node that never
resolves. The daemon dedups query uuids **first-wins before the merge**:
a query item is a duplicate iff its uuid is in its file's `byUuid`
(available only while its file is the tracked one) and the merge has
no node for it (it resolved, which needed a query observation). `byUuid` alone is not enough — the file may lead
the query for a shared uuid, and that first query observation is what
resolves the node. A duplicate is neither folded nor broadcast (like a
duplicate log line): the agent event stream is the interface we wish
the CLI provided, and it would not repeat itself. The same check
separates duplicates from classification errors (Classification
table): the class of the `byUuid` entry decides. Caveat, accepted: a
repeat on a file the follower has not reached yet (no `byUuid`) is an
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
fold clears it, so the field means "this event was anomalous"), the
daemon logs it at error and writes a diagnostic bundle, and the TUI
latches the last one it saw into a banner
("Observed unexpected behavior: <detail>. Please send
<daemon dir>/anomaly-*.json to geraschenko@gmail.com"). Anomalies are
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
failed tracker). The fold keeps the `FileState`'s query-side facts —
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
`ANOMALY_TRAIL` (50) events of both streams as `{kind, type, subtype,
uuid, session_id}` (no payloads), `claudeCodeVersion`, and the tracked
and query session ids. It is what a reproduction needs: the trail
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
several); the fold keeps them in the `FileState`, and `contextChanged`
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
   (`parentMap`, `nearestVisibleRow` for every occurrence) against
   `toDisplayTree` — the per-prefix check docs/specs/get-context.md
   deferred to "the rolling builder". The per-prefix sequence is
   `session.pushAll(prefix); session.finish(); context.push();
display.push()`; pushing into a finished builder throws. Without
   `finish()`, a builder's live view omits rows deferred behind an
   anchor that has not arrived (their placement is unknowable until it
   does).
3. **Same fold everywhere.** An observer seeded from `subscribe` and
   folding the pushed `AgentEvent`s holds the same `AgentState` as the
   daemon, whichever payload variant it subscribed with: the fold reads
   only fields slimming never touches (`uuid`, `type`, `subtype`,
   `isMeta`, `isSidechain`, `version`, `permissionMode`, and the event's
   own `leaf`/`lastAssistant`/`awaitingAnchors`). The merge is part of
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
6. **Slim by default.** `get-entries {payload: "slim"}` on the 167 MB
   fixture returns < 25% of the file's bytes; every string at a
   `SLIM_PATHS` leaf of a uuid-bearing entry is ≤ `SLIM_STRING_LIMIT`,
   every other value — structural fields like block `type`, `id`,
   `tool_use_id`, `name` included — and every uuid-less entry is
   JSON-equal to the file; `truncated` lists exactly the uuids where
   something was cut. `get-entries {uuids}`
   returns those entries complete (JSON-equal to the file), in requested
   order.
7. **TUI never refetches for `/tree`.** The TUI's trees are extended from
   `sessionEntry` events; `/tree` and `reloadHistory` read local state.
   `reloadHistory` fetches the `truncated` user/assistant
   (non-tool-result) entries on the rendered path in one `get-entries
{uuids}` before rendering (their text is always expanded); ctrl+o
   expansion fetches the truncated tool results/summaries it uncovers.
   Live messages render from the query stream as today.
8. **Switches are serialized and settle first.** A query message with a
   new `session_id` creates that file's `FileState` and makes it the
   query file at once; the reader never pauses. The daemon then
   switches the follower, outside the request gate: it waits for the
   tracked file to settle (its merge holds only that file's items, so
   this is reachable; bounded by `SETTLE_TIMEOUT_MS` — on timeout the
   pending uuids are logged as lost and the switch proceeds) and then
   for `SESSION_FILE_QUIET_MS` without a write (the old file has no end
   marker; log-only trailing rows — `stop_hook_summary`,
   `turn_duration` — arrive after the last shared id and matter only to
   `tail --type entries`; named cost). Then, under the exclusive gate:
   close the old follower, drop its `SessionTracker` and `FileState`,
   emit `sessionFileChanged {sessionId}` (the fold sets
   `fileSessionId`; clients reset their trees), open the next file in
   `files` order and scan it (every scanned entry is folded and
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
  the SDK then reports `t`: `t` is in `byUuid`, has no merge node, and
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
- `/clear`: query reports `system/init` with new id `F2` → `files[F2]`
  created (empty merge, `scanExcluded: true`), `querySessionId = F2`,
  `fileSessionId = F1`. The old file `F1` has `pending(q) = [a]` (its last
  assistant): the follower delivers `a`, `F1` settles, goes quiet, is
  closed; `files[F1]` dropped; `sessionFileChanged {F2}`
  (`fileSessionId = F2`); meanwhile the query stream has already reported `F2`'s first
  turn `Q: a1` into `files[F2].merge` (the prompt `p1` is never a
  query observation). The scan of `F2` reads `p1` first: session-only
  and `scanExcluded`, resolves at once; then `a1`: the merge holds it
  → `scanExcluded = false`, plain `S: a1` resolves it;
  `scanComplete`; live proceeds.
- `/fork`: as `/clear`, but the new file opens with a copy of the old
  one: the scan's copied entries are excluded from `query` (the merge
  has no node for them) and resolve at once; the first entry the
  query reported for `F2` ends the exclusion.
- Query duplicate: after a `/compact` the CLI re-sends the preserved
  `/cost` assistant message `c`; `c` is in `byUuid` and has no merge
  node → dropped before the merge.
- TUI start: `subscribe` (events buffer), then `get-entries {payload:
"slim"}` → `SessionSnapshot {entries, truncated, leaf}`; every
  `sessionEntry` event received before the response is folded but not
  pushed into the tree (the snapshot contains it — see Data flow 6); no
  gap, no replay in `subscribe`.
- `reloadHistory` on a path with 40 `truncated` entries, 12 of them
  user/assistant text: one `get-entries {uuids: [12]}`, render; the 28
  tool results render their 200-char heads. User presses ctrl+o: one
  `get-entries {uuids: [28]}`, re-render. (Per-message expansion is a
  later change; it only shrinks the second fetch.)

## Type design

### Agent events (`src/core/sdk-socket.ts`)

`SdkEvent` and `AgentObservation` are replaced by:

```ts
export type AgentEvent =
  | { kind: "sdkMessage"; message: SDKMessage }
  // One per canonical log entry of the tracked file, in file order.
  // `entry` is complete inside the daemon; on the wire it is the
  // subscriber's payload variant, with `truncated` present iff slimming
  // cut something. `leaf` is the context tree's leaf after this entry and
  // `lastAssistant` the usage/model of the last non-excluded,
  // non-sidechain assistant on contextAt(leaf) (absent when none; each
  // field independently optional) — daemon-computed, so clients fold
  // them without owning a tree. `awaitingAnchors` lists the boundaries
  // whose blocks are still deferred (session tracker incomplete).
  | {
      kind: "sessionEntry";
      entry: SessionEntry;
      truncated?: true;
      leaf: TreeNodeRef | null;
      lastAssistant?: { usage?: NonNullableUsage; model?: string };
      awaitingAnchors: readonly UUID[];
    }
  // Emitted after the sessionEntry that completes a compact_boundary —
  // the boundary's own, or its anchor's when the block was deferred —
  // whatever wrote it (native compaction or set-context). `leaf` is the
  // final post-boundary context tip (null after a wipe).
  | { kind: "contextChanged"; boundary: UUID; leaf: TreeNodeRef | null }
  // The follower moved to `sessionId`: the old file's FileState is
  // dropped and the new file is about to be scanned.
  | { kind: "sessionFileChanged"; sessionId: UUID }
  // The follower's start() has returned for the tracked file: every
  // entry the file held when it was opened has been folded.
  | { kind: "scanComplete" }
  // The daemon appended these uuid-bearing entries to the query file
  // (set-context); emitted before the drain that delivers them.
  | { kind: "sessionAppended"; uuids: readonly UUID[] }
  // A daemon-detected anomaly (follower failure, malformed line,
  // classification at the dedup site, awaiting-anchor); the fold sets
  // `anomaly`. Fold-detected ones (merge errors, head-mismatch) need
  // no event: every fold computes them.
  | { kind: "trackerAnomaly"; anomaly: TrackerAnomaly }
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
/** The fold's view of one session file. */
export interface FileState {
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
  /** Usage/model of the last assistant on the context (query-side while
   *  unsettled, log-side once settled). */
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
  // `leaf` move into FileState / derive from it...
  /** Plain record (it crosses the wire in `subscribe`). */
  readonly files: Readonly<Record<UUID, FileState>>;
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

/** `sessionId` is the resumed session on restart; absent on a fresh
 *  spawn (no file exists until the first prompt's `system/init`). */
export function initialAgentState(sessionId?: UUID): AgentState;

export const queryFile = (state: AgentState): FileState | undefined;
/** The query-side leaf of the query file (merge model, Leaf); null
 *  without a file. */
export const leaf = (state: AgentState): TreeNodeRef | null;
export const fileSettled = (file: FileState): boolean;   // !hasPending(merge, "query") && awaitingAnchors empty
/** False without a file: requests on a fresh spawn fail as today. */
export const settled = (state: AgentState): boolean;

/** The classification table, one function per side: whether the other
 *  stream never carries this occurrence. Uuid-less occurrences are not
 *  asked. */
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
  `session_id` creates its `FileState` (empty merge, `scanExcluded:
true`) and sets
  `querySessionId`. Then `observe("query", uuid)`; on a first
  observation, `excludeFrom(["session"])` when
  `excludedFromSession(message)`; a leaf-eligible message sets
  `pendingLeaf`; `lastUsage`/`model` from an assistant message as
  today. `system/init` touches nothing else. Per-agent fields fold as
  today.
- `sessionEntry`: routed to `fileSessionId`. Uuid-bearing entries:
  `observe("session", uuid)`; on a first observation,
  `excludeFrom(["query"])` when `excludedFromQuery(entry)` or
  `scanExcluded`; a session observation that finds the node already
  in the merge clears `scanExcluded`. Then `treeLeaf = event.leaf`,
  `awaitingAnchors = event.awaitingAnchors`; when the file is settled
  after the observation, `lastUsage`/`model` from
  `event.lastAssistant` (each unset when absent) — an unsettled fold
  holds fresher query-side values a lagging entry must not overwrite;
  `claudeCodeVersion` from `version`; `permissionMode` from
  `permission-mode` entries.
- any resolution (either stream) of the id in `pendingLeaf` clears it.
- `userMessageQueued`/`userMessageDequeued`: queue bookkeeping as
  today; no merge observation (prompts are session-only).
- `sessionAppended`: `observe("query", uuid)` for each uuid, on the
  query file.
- `sessionFileChanged`: delete `files[fileSessionId]`; when
  `sessionId` is that same id (a follower-failure rescan) replace it
  with `{merge: rebuilt from pending(old.merge, "query") — each
observed on "query" in order, excludeFrom(["session"]) where
old.merge.nodes[id].excludedFrom had it; pendingLeaf, lastUsage,
model: old; treeLeaf: null; awaitingAnchors: []; scanExcluded:
true}`; then `fileSessionId = sessionId`. A new file's `FileState` exists —
  the query message that named the id created it — with
  `scanExcluded` still true: only session observations clear it, and
  none have been routed to it.
- `scanComplete`: `files[fileSessionId].scanExcluded = false`.
- `trackerAnomaly`: set `anomaly`.
- `contextChanged`: nothing (the boundary's `sessionEntry` already
  folded the leaf; the event exists for consumers).

### Slim projection (`src/core/session/slim.ts`)

```ts
/** Strings under a slimmed path are at most this many UTF-16 code units
 *  (a surrogate pair is never split). */
export const SLIM_STRING_LIMIT = 200;

/** The leaves that carry bulk, measured over real logs (WORK LOG). Within
 *  message content only payload leaves are cut — never structural fields
 *  (`type`, `id`, `tool_use_id`, `name`) the builders and set-context
 *  validation read. `**` = every string value beneath; `[]` = each
 *  element; keys are never touched. */
export const SLIM_PATHS = [
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

/** Same shape as `entry`; string values at SLIM_PATHS leaves cut to the
 *  limit; `truncated` iff something was cut. Strings elsewhere are not
 *  inspected. Uuid-less entries are returned unchanged (nothing could
 *  refetch them). */
export function slimEntry(entry: SessionEntry): {
  entry: SessionEntry;
  truncated: boolean;
};
```

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

export class SessionEntryParser {
  /** Complete entries terminated within this chunk, with their byte range
   *  in the file (line including its terminator). */
  push(chunk: Buffer): ParsedEntry[];
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
    onMalformedLine: (range: ByteRange, error: Error) => void,
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
   *  contextAt(ref): a parent walk from ref (no memo — exclusion is
   *  retroactive at group end); O(distance to the previous eligible
   *  assistant). */
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
a node move. `ContextTree.excluded` and the display tree's hidden set are
live sets: the bounded retroactive edits (a group's `excluded` at group
end; a boundary hiding a prefix of its own block) mutate them in place.
`TreeNodeStr` (parent-map.ts) types every serialized `TreeNodeRef`.
Phase-1 work log: docs/specs/session-tracker/phase-1-rolling-builders.md.

### Session tracker (`src/core/daemon/session-tracker.ts`)

```ts
export class SessionTracker {
  constructor(filePath: string, onInvalid: OnInvalid);
  /** First-wins on uuid. Returns the event to emit (complete entry, plus
   *  the slim projection for the wire) or undefined for a duplicate uuid.
   *  Extends entries, byUuid, ranges and the two trees. `completedBoundaries`
   *  lists, in file order, every boundary this entry completed (its own,
   *  or those whose deferred blocks it anchored) with the context leaf
   *  right after that boundary's block materialized. */
  push(parsed: ParsedEntry):
    | {
        event: Extract<AgentEvent, { kind: "sessionEntry" }>;
        slim: SessionEntry;
        truncated: boolean;
        completedBoundaries: readonly {
          boundary: UUID;
          leaf: TreeNodeRef | null;
        }[];
      }
    | undefined;
  /** Canonical entries after `since` (throws when the cursor is unknown):
   *  slim from memory, or complete via readEntriesAt over their ranges. */
  entries(since: UUID | undefined, payload: "slim" | "full"): SessionSnapshot;
  /** Complete entries for these uuids, requested order; throws on an
   *  unknown uuid. */
  payloads(uuids: readonly UUID[]): SessionEntry[];
  /** The context at an occurrence, as refs in context order. */
  contextAt(at: TreeNodeRef): readonly TreeNodeRef[];
  get byUuid(): ReadonlyMap<UUID, SessionEntry>; // slim
  get contextTree(): ContextTree;
  get leaf(): TreeNodeRef | null;
}
```

No display tree in the daemon. daemon.ts composes `SessionTracker` with a
`SessionLogFollower` whose `onEntry` is
`(parsed) => { const pushed = sessionTracker.push(parsed); if (pushed) events.observeSessionEntry(pushed); }`
whose `onMalformedLine` emits a `trackerAnomaly {kind:
"malformed-line"}`, and whose `onFailure` emits a `trackerAnomaly
{kind: "follower-failure"}` and starts the same-file switch (merge
model, Anomalies); after `follower.start()` returns it emits
`scanComplete`.

### Event hub (`src/core/daemon/event-hub.ts`)

```ts
export class EventHub {
  /** Sinks receive the event plus, for sessionEntry, its slim projection;
   *  serialization per subscriber variant moves to sdk-server. */
  subscribe(
    sink: (
      event: AgentEvent,
      slim?: { entry: SessionEntry; truncated: boolean },
    ) => void,
  ): () => void;
  emit(
    event: Extract<
      AgentEvent,
      {
        kind:
          | "interruptSent"
          | "compactSent"
          | "controlApplied"
          | "shutdown"
          | "sessionFileChanged"
          | "scanComplete"
          | "sessionAppended"
          | "trackerAnomaly";
      }
    >,
  ): void;
  /** Dedup (merge model, Query-stream duplicates: needs the tracked
   *  file's byUuid) — a session-only class at the dedup site emits
   *  `trackerAnomaly {kind: "classification"}` and drops the message,
   *  a shared class drops it silently — then fold. A fold whose state
   *  carries `anomaly` logs it at error and writes the diagnostic
   *  bundle. */
  observeSdkMessage(message: SDKMessage): void;
  /** Fold the entry event (same anomaly handling), then emit one
   *  contextChanged per `completedBoundaries` element, in order. */
  observeSessionEntry(
    pushed: NonNullable<ReturnType<SessionTracker["push"]>>,
  ): void;
  /** The tracked file's SessionTracker; replaced at a switch (criterion
   *  8), so handlers read it after acquiring the gate. */
  get sessionTracker(): SessionTracker;
  /** Resolves when settled(agentState) — immediately if already; rejects
   *  after SETTLE_TIMEOUT_MS naming the query file's pending("query"). */
  whenSettled(): Promise<void>;
  /** Resolves when `fileSettled(files[sessionId])` (the switch's wait
   *  on the old file); same bound as whenSettled. */
  whenFileSettled(sessionId: UUID): Promise<void>;
}
```

### Wire (`src/core/sdk-socket.ts`)

```ts
| { type: "subscribe"; attachment?: SubscribeAttachment; entryPayload?: "slim" | "full" }  // default slim
| { type: "get-entries"; payload: "slim" | "full"; since?: UUID }   // → SessionSnapshot
| { type: "get-entries"; uuids: UUID[] }                            // → SessionEntry[] complete, requested order
| { type: "get-context"; at?: TreeNodeRef; payload: "slim" | "full" } // → ContextSlice

export interface SessionSnapshot {
  entries: SessionEntry[];
  /** Uuids of entries slimming cut (empty for payload "full"). */
  truncated: UUID[];
  leaf: TreeNodeRef | null;
}
export interface ContextSlice { entries: SessionEntry[]; truncated: UUID[] }
```

`SetContextResult` is unchanged (`boundaryUuid`). sdk-server serializes
each `sessionEntry` once per payload variant a connected subscriber
uses, synchronously inside the sink (the complete entry is not
retained afterwards).

CLI: `clauctl get-entries` sends `payload: "full"` (complete JSONL for
`format`), `--slim` sends slim; `clauctl context` sends `full`; the TUI
and uuid-prefix resolution (`sdk-commands.ts`) send slim.

### Deleted

`AgentObserver`/`AgentObservation`/`AgentObservationState`
(agent-observer.ts), `seedFromEntries`/`SessionFileSeed` (seed.ts),
`UntilSettlement`'s `consumedUuids`/catch-up machinery (tail.ts; the
class reduces to condition + `settled`), `waitForEntry`,
`readEntriesAfterStreamFlush`, the `contextChanged.request` field and
its `requestAnnotation` in format/events.ts, the stale "no-write
rewinds" comment in sdk-socket.ts, `AgentState.sessionId`/`leaf`/
`lastUsage`/`model` as top-level fields (into `FileState`).

## Data flow

1. **Startup.** daemon.ts builds `initialAgentState(seedSessionId)`,
   opens `SessionLogFollower(path, onEntry)` on the seed session file
   and calls `start()`: every existing line goes through
   `sessionTracker.push(parsed)` → `hub.observeSessionEntry` with no
   subscribers attached; each is a session observation excluded from
   `query` (`scanExcluded` holds — no query message exists yet), so
   the merge stays empty; then `scanComplete`. The fold state after the
   scan _is_ the seed (settled, `treeLeaf`, `leaf` = `treeLeaf`,
   `lastUsage`/`model` from the context's last assistant, version,
   mode). The complete entry is dropped after the sinks run; only slim
   - range are retained.
2. **Live.** Query message → `hub.observeSdkMessage` (dedup; fold:
   route by `session_id`, observe on `query`, class exclusion; dequeues
   follow as today and observe nothing). fs event → follower
   reads new bytes → parser → `sessionTracker.push(parsed)` (slim,
   byUuid, range, `SessionTreeBuilder.push`, `ContextTreeBuilder.push`,
   leaf, lastAssistant) → `hub.observeSessionEntry` (fold: observe on
   `session`, class/scan exclusion; the entry that completes a
   boundary — its own or its anchor's — additionally emits
   `contextChanged`). Sinks receive events synchronously, post-fold.
3. **Switch.** Criterion 8's sequence, run by one worker in daemon.ts
   that is started when the folded state shows `fileSessionId ≠
querySessionId` after an `sdkMessage` and none is running: `await
hub.whenFileSettled(fileSessionId)` (timeout logged, not fatal),
   `await follower.whenQuiet(SESSION_FILE_QUIET_MS)` — both skipped on
   a fresh spawn (`fileSessionId` undefined: no old file, no
   follower) and both abandoned when the follower fails meanwhile
   (`follower.whenFailed()` wins the race) — then under the exclusive
   gate: `follower.close()`, new
   `SessionTracker(nextPath)` installed on the hub,
   `hub.emit(sessionFileChanged {sessionId: next})`, new follower
   `start()` (scan → `observeSessionEntry`, excluded from `query` until
   the scan meets a query-reported id), `hub.emit(scanComplete)`;
   release; repeat while `fileSessionId ≠ querySessionId`. The reader
   loop never waits on it. The next file's path is derived from its
   session id as today (`SESSION_FILE_TIMEOUT_MS` bounds waiting for it
   to exist). A follower failure starts the same worker (or redirects
   the running one) with `next = fileSessionId`, gated part only; the
   loop condition then takes over (merge model, Anomalies).
4. **`get-entries` / `get-context`.** `await hub.whenSettled()` outside
   the gate; gate shared; take `hub.sessionTracker`; if no longer
   `settled`, release and repeat; serve
   `sessionTracker.entries(since, payload)` /
   `sessionTracker.contextAt(at ?? sessionTracker.leaf)` mapped through
   `sessionTracker.byUuid` (slim) or `sessionTracker.payloads` (full,
   context order).
5. **`set-context`.** Same protocol as 4 with the exclusive gate:
   `await whenSettled()` outside the gate; gate exclusive; take
   `hub.sessionTracker`; if no longer `settled`, release and repeat;
   validate the requested list against
   `sessionTracker.byUuid`/`sessionTracker.contextTree`;
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
6. **Clients.** `subscribe` first (events buffer in the socket), then
   `get-entries {payload: "slim"}`. Every event is folded into the
   client's `AgentState` in socket order — the client's fold is the
   daemon's, merge included. What differs before the response is the
   tree: a `sessionFileChanged` received before it resets the client's
   model (so a switch that lands between subscribe and response cannot
   wipe the snapshot afterwards), and `sessionEntry` events received
   before it are not pushed into the tree; then the snapshot is
   applied; then live `sessionEntry` events are pushed. Not pushing is
   sound because the handler computes the snapshot and writes the
   response without yielding, and sinks run synchronously inside the
   follower's read, so no event can fall between the snapshot and the
   response on the socket: everything received before the response is
   in the snapshot, everything after it is not. No cursor is needed for
   the handoff, which is what lets uuid-less entries (relevant only to
   `tail --type entries`, never slimmed) ride along without an identity
   of their own. The TUI pushes snapshot entries then live
   `sessionEntry` events into its own `byUuid` +
   `SessionTreeBuilder`/`ContextTreeBuilder`/`DisplayTreeBuilder`;
   `/tree` and `reloadHistory` read them. `reloadHistory` fetches the
   truncated user/assistant entries of the path before rendering;
   ctrl+o expansion fetches the truncated tool results/summaries it
   uncovers. On `sessionFileChanged` it resets its model and rebuilds
   it from the scan's events (criterion 8). `tail --type
entries|messages` uses the same handoff: subscribe with
   `entryPayload: "full"` (buffering), `get-entries {payload: "full",
since}` (`--since` is a uuid cursor, as today), print the snapshot,
   skip printing the `sessionEntry` events received before the response
   (they are in the snapshot), then print live `sessionEntry` events.
   `--until` order: print the snapshot, then evaluate the condition
   against the state at subscription (an already-idle agent completes
   here), then against buffered/live events in order; once latched,
   completion awaits `settled(state)`. `prompt --type entries|messages`
   stays live-only.
7. **Shutdown.** Criterion 9's sequence under the exclusive gate.

## Cost

- **Daemon resident:** slim entries + byte ranges + full/context trees
  (+ the `nodes` array). ≈ 40–65 MB for the
  167 MB / 50k-entry fixture (criterion 10 bounds it at 80 MB) versus
  240 MB of complete entries. Complete entries exist only transiently
  per parsed chunk. Startup remains one full parse (~390 ms on that
  fixture) — the only whole-file read.
- **Per live entry:** slim walk (proportional to the entry's size) +
  two builder pushes (O(1) placement; `lastAssistantOn` is O(distance
  to the previous eligible assistant)) + one merge observation
  (O(unresolved nodes touched), a handful) + one serialization per
  payload variant in use. A `full` subscriber costs one extra
  `JSON.stringify` of the complete entry per entry.
- **Per `get-entries` slim:** stringify of the slim list — ~30 MB /
  ~100 ms on the 50k fixture at TUI start; zero thereafter (`/tree` is
  local). `payload: "full"` re-reads and re-parses every range: ~the
  startup cost, on demand (`clauctl get-entries` for `format`).
- **Payload reads:** O(requested bytes), `pread` at recorded ranges.
  The log is append-only (truncation/replacement is a follower
  failure that discards the ranges), so a served range is never stale.
- **TUI resident:** its own copy of the slim entries + three trees —
  the same order as the daemon, per attached TUI.
- **Merge residency:** the live lag — unresolved nodes are ids one
  stream has and the other has not passed (a flush's worth), plus
  `awaitingAnchors`. Scan entries never accumulate (excluded from
  `query`, they resolve as folded). A merge is copied per observation
  (structural sharing of untouched nodes; stream-merge.md Cost). One
  merge per file in `files`, at most a few files during a switch.
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
  canonical, emitted as `sessionEntry`, never slimmed, no tree
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
  it folds into `files[new]` and waits there; the scan of the new file
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
  block ids** are outside `SLIM_PATHS` and never cut, whatever their
  length; the builders and set-context validation read only untouched
  fields. A boundary's summary lives in the summary entry's
  `message.content`, so it is cut like any message.
- **`get-entries {since}` with an unknown cursor:** error, as
  `canonicalizeEntries` does today. After a switch the cursor is
  resolved against the tracked file's session tracker only.

## Non-goals

- Renaming `SdkSocketClient`/`sdk.sock` or the `sdkMessage` event kind.
- Per-field truncation marks (`truncatedPaths`) — deferred; the
  entry-level flag over-fetches at most one entry per expansion.
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
   `SessionEntryClient` surface.
3. **Fold + session tracker.** `AgentEvent`/`AgentState`/`FileState`,
   `excludedFromSession`/`excludedFromQuery` (from the classification
   table; the stream-classification test becomes its fixture),
   `nextAgentState`, `SessionTracker`,
   `EventHub.observeSessionEntry`/`whenSettled`/`whenFileSettled`/dedup,
   anomaly log + bundle, daemon.ts composition (startup scan, the
   switch incl. the failure rescan, shutdown drain), request handlers
   served from the session tracker, set-context drain, delete seed.ts
   and the flush-wait helpers.
4. **Wire + clients.** `get-entries`/`get-context`/`subscribe` shapes,
   `SessionSnapshot.truncated`, `ContextSlice`; sdk-server
   per-variant serialization; `tail`/`prompt` on the agent event stream
   (delete `AgentObserver`); TUI rolling trees, fetch policy and the
   anomaly banner; CLI flags; format annotation.
5. **Docs.** `docs/agent-events.md`, session-views.md cross-reference,
   update get-context.md/canonical-session-entry-stream.md/
   daemon-architecture.md status notes, remove the AGENTS.md bullet.

Notes:

- The dedup check lives in `EventHub.observeSdkMessage` (it needs the
  tracked file's `byUuid` and the query file's merge) and doubles as
  the classification check. Anomaly reporting is one place: the hub
  reads `anomaly` off each folded state and logs + writes the bundle
  when present; the TUI latches it into the banner, so it needs no new
  wire event — every subscriber folds the same events.
- The scan-exclusion site in the fold carries the O(n²) rationale
  (merge model, Observations) as a comment; it is the one place a
  reader would otherwise "simplify" by observing scan entries.
- The bundle's stream trail is a ring of `ANOMALY_TRAIL` (50)
  `{kind, type, subtype, uuid, session_id}` records kept by the hub
  (not the fold: it is diagnostics, not state).
- `whenSettled` timeout value: reuse `CATCHUP_TIMEOUT_MS` (10 s) as
  `SETTLE_TIMEOUT_MS`; it is the same bound with the same meaning.
- `SESSION_FILE_QUIET_MS` (old-file quiet period before the switch,
  criterion 8): 500 ms to start. Nothing signals that it is too short
  (rows written after the close are lost silently); `tail --type
entries` across a `/clear` is the only observer.
- `lastAssistantOn` needs no payload read: slimming cuts strings under
  `message.content` only, so `message.usage`/`message.model` survive in
  the slim entries.
- The switch holds the request gate exclusively for the scan of the new
  file (the one whole-file read criterion 1 permits after startup); a
  50k-entry scan is ~400 ms, comparable to today's per-request read.
  Every scanned entry is also broadcast (slim) to subscribers — a
  snapshot's worth of bytes per subscriber, once per switch.
- Leaf-eligibility for `pendingLeaf` is the predicate the fold uses
  for `leaf` today (uuid-bearing, non-meta, non-sidechain / no
  `parent_tool_use_id`, user/assistant).

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

Each phase keeps its own work log at `docs/specs/session-tracker/phase-N-<name>.md`
(created when the phase starts); this section holds only the derisk
summary, cross-phase decisions, and the phase checklist.

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
5. Per-file `FileState`; query items routed by `session_id`; a new id
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
`FileState`. `querySessionId`/`fileSessionId` are optional (fresh
spawn has no file); `files` is a record, not a Map (wire). One anomaly
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
`pending("query")` and `pendingLeaf` into the fresh `FileState`; a
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
- [ ] Phase 2 parser ranges, slim, follower split
- [ ] Phase 3 fold + session tracker + daemon composition
- [ ] Phase 4 wire + clients (tail/prompt/TUI/CLI)
- [ ] Phase 5 docs

_Work log entries go here_
