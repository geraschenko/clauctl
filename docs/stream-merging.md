# Merging the query stream and the session file

Deep dive behind [`protocol.md`](protocol.md): how the
daemon turns two unsynchronized views of one `claude` process into the
single event stream a client folds. The specs are
[`specs/stream-merge.md`](specs/stream-merge.md) (the library) and
[`specs/session-tracker.md`](specs/session-tracker.md) (the daemon's use
of it); this page is the living explanation.

## Two views of one process

The `claude` process does things in some order we cannot see. We observe
it through two streams, each faithful and ordered but lossy:

- the **query stream** — the `SDKMessage`s the `Query` yields (plus the
  entries `set-context` appends, which are serialized with it);
- the **file stream** — the canonical entries of the session jsonl,
  delivered by a `tail -f`-style follower
  (`src/core/session/entry-stream.ts`).

Neither suffices alone. The query stream never echoes a prompt, never
shows a steered prompt or an attachment, and cannot be replayed after the
fact; the file has all of that but lags the query stream by a flush,
omits everything that is not persisted (`result`, `stream_event`, status
and rate-limit messages, hook events), and cannot tell a client what the
model is doing _now_. Together they can, if we know which stream carries
what and can correlate the shared items.

Correlation is by uuid: every `SDKMessage` carries one, and every
persisted entry of a shared class carries the same uuid in the file. The
**assumption** the whole design rests on, and which the daemon actively
tries to falsify (anomalies, below): the two streams are two views of one
process **in the same order**.

## The classification table

Which streams carry an id of a given class. A class with both columns
populated is **shared**: the same uuid appears on both streams. A class
with one column is **one-sided**: the fold can promise the merge that the
other stream will never show it.

| class                                                                                                                                                     | query                        | session | note                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `assistant`                                                                                                                                               | ✓                            | ✓       |                                                                                                                                           |
| `system/local_command` (slash-command output)                                                                                                             | ✓ as `assistant`             | ✓       | same uuid, different class on each side                                                                                                   |
| `user` tool results, compaction summary                                                                                                                   | ✓                            | ✓       |                                                                                                                                           |
| `user` `<local-command-stdout>` (a slash command's output logged as a `user` entry; `/compact`'s "Compacted")                                             | ✓ with `isReplay: true`      | ✓       | never `isMeta`; the CLI replays the entry to the SDK consumer                                                                             |
| `system/compact_boundary`                                                                                                                                 | ✓                            | ✓       |                                                                                                                                           |
| `user` prompts (ours and the CLI's `<command-name>` entries)                                                                                              |                              | ✓       | the query stream never echoes a prompt; clauctl does not stamp `SDKUserMessage.uuid` (the CLI would persist it — `derisk/uuid-stamping/`) |
| local-command input entries: `<local-command-caveat>` (`isMeta`), `<command-name>` (not `isMeta`)                                                         |                              | ✓       |                                                                                                                                           |
| `attachment`                                                                                                                                              |                              | ✓       |                                                                                                                                           |
| `system/{stop_hook_summary, turn_duration, api_error, away_summary, informational, model_*_fallback}`                                                     |                              | ✓       |                                                                                                                                           |
| uuid-less sidecars: `queue-operation`, `last-prompt`, `mode`, `permission-mode`, `ai-title`, `custom-title`, `file-history-*`, `agent-*`, `atis-latch`, … |                              | ✓       | no uuid, so they never enter the merge                                                                                                    |
| `result`, `system/init`, `system/status`, `system/thinking_tokens`, `stream_event`, `tool_progress`, `rate_limit_event`, task/notification/session_state  | ✓                            |         |                                                                                                                                           |
| `hook_*`                                                                                                                                                  | ✓ (declared; never observed) |         |                                                                                                                                           |

Evidence: the SDK's `sdk.d.ts` (every `SDKMessage` variant carries `uuid`;
optional only on host-pushed `SDKUserMessage`), real session files,
the echoed-message-placement captures, live `/compact`s, and the probes
under `docs/derisk/stream-classification/` and `docs/derisk/uuid-stamping/`.
`tests/sdk/stream-classification.test.ts` pins the table and the same
relative order of shared uuids on both streams, and is where a new row
goes when an anomaly report adds one.

In code the table is two predicates in `src/core/agent-state.ts`:
`excludedFromSession(message)` and `excludedFromQuery(entry)`. The `user`
rule is the subtle one: a `user` entry is shared iff it has a
`tool_result` block, is a compaction summary, or its content starts with
`<local-command-stdout>`; every other `user` entry is a prompt and
session-only. Unknown rows are treated as **session-only** — the safe
direction, since the entry then goes out on the wire whole.

The table decides two things: what the merge may exclude (a one-sided id
resolves as soon as its predecessors have, without waiting on the other
stream), and what crosses the wire — a session-only entry goes out
complete, a shared one as its structural projection because the subscriber
already has the payload from the `sdkMessage` twin.

## `MergeState`

`src/core/stream-merge.ts` is a general-purpose online topological merge of
N ordered lossy views. Each observation of an id on
a stream appends it to that stream's chain; the union of the chains is a
DAG, and the DAG's ancestor relation is all the order the streams jointly
establish. A node is **resolved** once it has been observed somewhere,
every non-excluded stream has moved past it, and all its predecessors are
resolved, so resolution order is a topological sort and, once resolved,
no future observation can precede it. **Pending** on a stream means
observed there and unresolved. Resolved nodes are forgotten: the state
holds only unresolved nodes, so memory is proportional to the lag between
the streams, not to the session.

The fold keeps one `MergeState<UUID, "query" | "session">` per session
file in `SessionState.merge`. Every uuid-bearing query message is observed
on `query`; every canonical uuid-bearing entry of the tracked file on
`session`; at an id's first observation the fold excludes the stream the
table says never carries it. Exclusion is extra information handed to the
merge: without it the id would wait for the other stream to move past it;
with it the id resolves as soon as its predecessors do. Prompts the daemon
submits are _not_ query observations: nothing on the query stream will
ever name them.

**Settled.** A session file is settled when nothing is pending on `query`
and no boundary awaits its anchor: the file has caught up with everything
the SDK has said. The agent is settled when the query file is the tracked
file and is settled. `EventHub.whenSettled()` is what `get-entries`,
`get-context` and `set-context` await before reading the file, bounded by
`SETTLE_TIMEOUT_MS`. Settlement is stronger than these reads need: it
would suffice for everything pending at request time to resolve. Waiting
on the leaf alone would not — a boundary's anchor, or a shared entry that
is not leaf-eligible, can still be in flight behind a resolved leaf.

**Leaf.** The context leaf a client cuts history at is per file: the last
leaf-eligible query observation still pending on `query`, else the file's
context-tree leaf. Live query messages own the leaf until the log catches
up; after a restart the scan resolves at once and the tree leaf wins.

**Duplicates.** Both streams repeat uuids, and the policy on both is
first-wins: a repeat is neither folded nor broadcast — the socket is the
interface we wish the CLI provided, and it would not repeat itself. The
CLI re-emits a shared uuid on the query stream in at least one case
(`/cost` output re-sent after a `/compact` that preserved it); the daemon
treats a query item whose uuid is in the tracked file's index with no
merge node as a duplicate. The file re-persists entries it already wrote,
always right after a compact boundary and not always byte-identically
(`derisk/cli-history-repersistence/FINDINGS.md`: of 237 pairs, copies
differed in `gitBranch`, `toolUseResult`, `promptId`, attachment payload,
`usage`, and twice in `parentUuid` — the boundary's relink baked into the
raw pointer); `SessionTracker.push` drops a line whose uuid it has already
indexed. The CLI's own loader is last-wins, which is why the `loadedContext`
oracle is too ([`session-views.md`](session-views.md)).

## Anomalies

An anomaly is an observation our model says cannot happen. Kinds:

- `order-violation`: an id observed on a stream that already passed it — a missed duplicate
- `classification`: the table is wrong for this uuid
- head-mismatch: an id resolved with a stream that should have carried it but didn't
- `awaiting-anchor`: a boundary's anchor did not arrive as the very next entry after the boundary
- `malformed-line`: a jsonl line is not valid json
- follower failure: file truncation, inode replacement, or read error

None is fatal. The fold sets `AgentState.anomaly` on the state it
produces, which means "the event just folded was anomalous" and the next
fold clears it. The daemon logs it and writes a diagnostic bundle
(`<agent dir>/anomaly-<timestamp>.json`: the anomaly, the merge state
before the failing observation, the last 50 events of both streams as
identities), and the TUI shows a banner. A merge error leaves the failing
observation unapplied and nothing else; the message or entry is still
folded and broadcast. A follower failure re-opens and rescans the file as
a switch to the same session id.

Anomalies are the falsifiers of the order assumption and the table. A
report's fixture goes into `tests/sdk/stream-classification.test.ts`.

## The daemon's resident view: `SessionTracker`

`src/core/daemon/session-tracker.ts` is the daemon's view of one session
file. It keeps an index (uuid → byte range and class), the rolling full
tree and context tree (`src/core/tree/`), and nothing else. Entry
payloads are never retained — `get-entries {payload: "full"}` re-reads
them by byte range. This is what lets the daemon follow a 100 MB session
with memory proportional to the tree, not the file. Each pushed line
becomes the socket's `sessionEntry` event, with the leaf and last
assistant computed here so clients can fold them without owning a tree;
the entry that completes a compact boundary also yields `contextChanged`.

The TUI's `SessionModel` (`src/tui/session-model.ts`) is the same
function of the entry stream with the opposite retention policy: it keeps
every entry (complete from the snapshot, structural from live shared
events) plus the SDK message payloads, and adds the display tree. Both
compute the same structure from the same stream, which is what makes a
live tree equal the tree a restart recomputes from the file. When
[`thoughts/fold-resolved-events.md`](thoughts/fold-resolved-events.md)
lands, the merge-and-`byUuid` half of `SessionModel` is the
clauctl-specific piece that joins the library described here.

## Startup, live, switch

**Startup.** The daemon opens the file follower on the seed session's file and
scans it: every existing line is pushed through the tracker and folded
with no subscribers attached. Scan entries are excluded from `query`
(`SessionState.scanExcluded`) until the scan meets an id the query stream
already reported or `scanComplete` arrives. A resumed `Query` never
re-reports the file, so the startup scan resolves entirely at once. The
fold state after the scan _is_ the seed: settled, with the tree leaf, the
last assistant's usage and model, and nothing pending.

**Live.** A query message is deduped, folded (routed by `session_id`,
observed on `query`, class exclusion applied) and broadcast. A file
change wakes the follower, which reads the new bytes, parses them, pushes
each entry through the tracker and folds and broadcasts the resulting
events (observed on `session`). Sinks run synchronously inside the read,
which is what makes the snapshot/stream handoff cursor-free
(protocol.md, Requests).

**Switch.** When the folded state shows `fileSessionId ≠ querySessionId`
(a `/clear` or `/new`; the query stream announced a new session id), a
worker waits for the old file to settle and go quiet, then under the
writer gate closes the follower, replaces the tracker, emits
`sessionFileChanged`, opens the new file, scans it (excluded from `query`
until the scan meets a live id — a `/clear`'s first turn is on the query
stream before the file exists), and emits `scanComplete`. Clients reset
their per-file model on `sessionFileChanged` and rebuild it from the
scan. `set-context` is a restart on the same file, not a switch.
