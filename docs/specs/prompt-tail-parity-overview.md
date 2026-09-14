# Prompt/tail parity roadmap

> Status: **implemented (all three specs landed).** Not an implementation-ready spec. This document
> records the cross-cutting ontology, settled command behavior, constraints, and
> proposed sequence of follow-up specs. Each phase below gets its own spec and
> review before implementation. Return here when beginning a later phase so its
> spec is based on the whole plan rather than only the previous phase.
>
> Rewritten 2026-07-29 after Spec 1
> ([canonical-session-entry-stream.md](canonical-session-entry-stream.md)) was
> implemented: messages are now projected from entries only, which removed the
> dual-adapter design, the history/live handoff, and most cursor machinery from
> the earlier revision of this document.

## Goal

Bring `clauctl prompt` and `clauctl tail` to the same composable observation
model as pictl:

- rename `query` to `prompt`;
- make `prompt` stream by default while retaining fire-and-forget as
  `-d`/`--detach`;
- let `prompt` and `tail` select messages, entries, or events;
- render human-readable output by default and expose canonical JSONL with
  `--json`;
- let `tail --since <uuid>` replay persisted activity after a previous cursor
  and then continue following;
- make all non-tree format conversions consume and emit incrementally.

## Ontology

The names describe what the records _are_, not where a command happens to use
them.

### Messages

Messages are the context-facing conversation units: user input, assistant
output, tool calls/results, summaries, and other values that can be presented
as what the assistant sees. A message stream may also contain explicitly typed
control records needed to explain changes such as navigation, compaction, or
model selection; controls are not mislabeled as messages.

In clauctl, messages are a projection of persisted entries — the only
projection. Both history and live output come from the same entry stream
through the same entry→message conversion; there is no event-derived message
path and therefore no history/live seam. The cost is that live message output
lags the sdk stream by the CLI's persistence delay (observed ~100–180 ms),
which was judged acceptable. Facts that are never persisted remain the domain
of `--type events`.

### Entries

Entries are records written to the Claude session JSONL file. They are the
durable, append-ordered history and include both conversation records and
bookkeeping records. Most carry a stable `uuid`; some legitimate entry kinds do
not.

Entries cannot be reconstructed exactly from the current sdk.sock event stream.
Message UUIDs do not supply omitted `parentUuid` links, transcript metadata,
queue operations, file-history records, titles, or other persisted payloads.
Augmenting sdk.sock with exact persisted-entry events is explicitly out of
scope and is not an acceptable implementation strategy.

### Events

Events are records observed across sdk.sock: the subscription snapshot and the
augmented `SdkEvent` stream. They include live SDK messages and daemon-known
queue, control, interrupt, and context-change facts — including transient facts
that are never persisted.

`--type events` is a required part of the surface, not a convenience: sdk.sock
can only be treated as 100% internal if the full event stream is accessible and
the full public command surface is exposed through the sdk server. clauctl
users must never have to speak to the socket directly. Events are formatted by
default like the other types; `--json` emits their canonical JSONL framing.

### Trees

A tree is a presentation of entries, not a fourth source ontology. Tree
construction consumes entries and interprets their parent links, compaction
boundaries, and current leaf.

Unlike the other formatters, a stable final tree cannot generally emit
incrementally: a later entry can add a branch or change active path markers and
connectors. `format tree` may consume a streaming input but buffers until EOF
before emitting the final tree.

## Conversion graph

```text
entries ────────> messages
   │
   └────────────> tree

events            (no conversions; formatted directly)
```

There is no `events -> messages` conversion in clauctl and no
`events -> entries` conversion in either project. pictl retains its own two
message adapters (entries and events); that asymmetry is pictl's design and is
not imported here.

## Format command contract

The JSON input accepted by each formatter follows the conversion graph:

| Formatter         | Canonical JSON inputs        |
| ----------------- | ---------------------------- |
| `format events`   | events                       |
| `format entries`  | entries                      |
| `format messages` | messages, entries            |
| `format tree`     | entries or an entry snapshot |

Each formatter invocation consumes one homogeneous canonical input ontology.
`format messages`, `format entries`, and `format events` parse and emit
incrementally: they do not buffer the complete input until EOF, but bounded
conversion state and deferred emission are allowed. State such as tool-use IDs
and duplicate UUID tracking is retained across records and flushed at EOF.
`format tree` is the deliberate whole-input exception described above.

Prompt and tail must call the same projection and record formatters as the
standalone `format` commands. Default output for a finite command should be
byte-equivalent to its `--json` output passed through the corresponding
formatter with default options.

Finer formatting options remain on `format`; callers request JSONL and pipe it
when they need non-default formatting.

## Canonical entry stream (Spec 1 — implemented)

The entry source shared by everything above is specified and implemented in
[canonical-session-entry-stream.md](canonical-session-entry-stream.md):
`SessionEntryClient` (a `StreamClient` over one session file, watch-before-read,
byte-offset incremental follow, driven by the existing generated `runStream`)
and `canonicalizeEntries` for finite reads. Summary of the canonical semantics,
normative text in the spec:

- **First-wins UUID deduplication**: the CLI re-persists prior entries under
  the same UUID; the first occurrence supplies both position and content, later
  occurrences are omitted, and deduplication scans from the file start before
  applying `since`. `loadedContext()` stays last-wins because it models
  Claude's actual UUID-keyed loader, not canonical output.
- **UUID-less entries** (`queue-operation`, `last-prompt`, `mode`,
  `file-history-*`, titles, …) are legitimate and retained in position. They
  cannot advance a UUID cursor; a session appending only UUID-less records
  after a cursor replays them on the next `since` invocation — accepted rather
  than adding a second cursor type. Known types may receive concise entry
  summaries; unknown types degrade to a generic summary rather than
  disappearing.
- **A missing cursor is an error** naming the UUID and file — never "from the
  beginning".
- **Truncation, replacement, and corruption fail the stream**; it never
  restarts from byte zero.

### Cost: full-file reads

Every subscription (and every finite read) scans the whole session file, so
file-derived display costs O(file bytes) per invocation and grows with session
length. Accepted for now; if it becomes expensive, the escape hatch is a
daemon-maintained entry stream that serves the latest entries to observers
without each one re-reading the file. Cross that bridge when we come to it —
nothing in the command surface would change.

## Message projection

One entry→message projection serves history, live following, and prompt
output. `entryToSessionMessage` (the SDK-compatible mapping) is its core; the
message-projection spec extends it with the typed control records (compaction
boundaries, navigation, model changes) and decides which bookkeeping entries
surface as controls versus being dropped from message output.

Echoed/queued/steered user input, previously the hard case of the dual-adapter
design, mostly dissolves: input appears in message output when the CLI persists
its user entry. Queue submission and dequeue are visible as UUID-less
`queue-operation` entries (enqueue carries the text); whether the message
formatter renders them (e.g. as a queued-input control) or drops them is a
Spec 2 decision, not an architectural one.

## Turn-end signal

`prompt` streams until the prompted turn ends. The turn-end signal comes from
the sdk.sock `result` event, not from entries: prompt already holds a socket
subscription to submit through, and the socket is authoritative. A user
interrupt counts as turn-end.

Empirical findings (2026-07-29, this project's transcripts), recorded so the
alternative is not re-derived: turn-end is _nearly_ detectable from entries —
`result` records are not persisted, but every persisted assistant entry carries
the response's final `message.stop_reason` (observed: 5432 `tool_use`,
515 `end_turn`, 5 `stop_sequence`, 2 `null`), so a non-`tool_use` stop_reason
marks the turn's last response. The edge cases decided against it: interrupts
leave no terminal assistant entry (only a user entry containing
"[Request interrupted by user]"), and the rare `null` stop_reasons are
unexplained. Displaying from entries while settling from the socket is the same
split `--until idle` uses.

## Cursor model

Canonical JSON records carry their natural identities rather than a synthetic
final cursor record: entries expose `uuid`, and message records retain their
source entry's UUID. Because every message comes from an entry, a message
cursor _is_ an entry cursor — no reconciliation between event- and
entry-derived identities exists or is needed.

Human-readable message formatting hides those IDs, so a finite formatted
message stream ends with a cursor line usable by `tail --since`:

```text
[cursor: <last-stable-uuid>]
```

The standalone streaming formatter emits the same line when it reaches EOF.
Entry formatting already displays UUIDs where present; whether it also prints a
final cursor is unnecessary by default and can be settled in its implementation
spec. Events carry no resumable identity — sdk.sock has no historical event
log — so event output has no cursor and `--since` is rejected for events.

An indefinitely followed stream has no natural EOF and therefore emits no
promised final cursor when externally interrupted. `--timeout 0`, a met
`--until`, or a successful finite prompt gives the formatter a normal flush
point.

## Command behavior

### `prompt`

`query` is renamed to `prompt`. Backward compatibility is not required.

By default, prompt:

1. subscribes — sdk.sock (turn-end signal, and the event stream when
   `--type events`) and the session entry stream (`history:"skip"`, when
   displaying messages or entries) — before submitting input, so a fast turn
   cannot be missed;
2. submits the prompt;
3. streams until the prompted turn ends (sdk.sock `result`; interrupt counts);
4. formats messages unless another type or `--json` is selected;
5. flushes any formatted cursor on finite completion.

`-d`/`--detach` preserves today's fire-and-forget behavior: submit and return
without streamed output. `--detach` combined with flags expressing an intent to
wait is a usage error. The prompt spec must define `--no-query`, queue priority,
and already-busy-agent behavior explicitly rather than assuming every accepted
input produces its own result. Concurrent activity from other clients may
appear in any prompt stream; prompt is an observation window, not an ownership
filter.

### `tail`

Tail follows by default; no `--follow` flag is needed.

```text
clauctl tail [--type messages|entries|events]
             [--json]
             [--since <uuid>]
             [--until <condition>]
             [--timeout <seconds>]
```

- `messages` is the default.
- `--timeout 0` emits available history and exits without accepting live
  activity, matching pictl.
- `--since <uuid>` starts after the retained first occurrence of that UUID.
- `--since` applies to messages and entries and is rejected for events because
  sdk.sock has no historical event log.
- messages and entries both follow the session entry stream; messages apply the
  projection.
- events follow sdk.sock and have no historical backlog. Whether
  `events --timeout 0` emits the subscription snapshot, emits nothing, or is
  rejected is deferred to the tail spec.
- `--until idle` composes the entry stream with a side sdk.sock subscription:
  the side subscription records the idle leaf, and the entry handler stops when
  that UUID is observed in `seenUuids` (which also covers the leaf entry
  hitting disk before the sdk reports idle). Pure command-level composition;
  details in the tail spec.

Dormant or archived agents:

- entries and messages read the latest session file and return after history;
- events fail because no live sdk.sock event source exists;
- tail never revives an agent merely to observe it.

Session rollover and a cursor not present in the current session need explicit
behavior in the tail spec. At minimum, a missing cursor must be an error rather
than silently meaning “from the beginning.” The same spec must classify an
active-to-dormant transition during a follow as normal finite completion,
retryable loss, or an error.

## Pictl symmetry

Done — pictl's `docs/specs/format-streaming.md` (see Spec 5 below) did:

- rename `--type raw` to `--type events`;
- add human-readable event formatting;
- make `--json` emit canonical event JSONL;
- use the same ontology terminology and formatter acceptance rules;
- retain pictl's two independent message adapters from entries and events.

This is a behavioral/interface change in pictl and is deliberately separate
from clauctl implementation specs.

## Follow-up sequence

### Spec 1: canonical session-entry stream — **implemented**

See [canonical-session-entry-stream.md](canonical-session-entry-stream.md):
`src/core/session/` (file.ts with `SessionEntryParser` and first-wins
`entriesByUuid`; entry-stream.ts with `SessionEntryClient`,
`canonicalizeEntries`, `waitForEntry`).

### Spec 2: streaming conversions and formatters

Specify:

- canonical message and control record types;
- the entry→message projection (extending `entryToSessionMessage` with control
  records; queued/steered input rendering);
- incremental JSONL decoders and writers;
- `format entries`;
- incremental `format messages` and `format events` (event formatting only —
  no event→message adapter exists);
- EOF cursor formatting;
- the buffered `format tree` exception and expanded accepted inputs.

### Spec 3: tail parity

Build tail on the canonical entry stream, the message projection, format
writers, and the existing generic stream driver. Specify all
type/JSON/since/timeout/until behavior — including the `--until idle`
composition above — plus dormancy and active-to-dormant transitions and
rollover. Classify every settlement path as graceful completion or external /
transport interruption so formatter flushing and cursor emission follow
mechanically.

### Spec 4: prompt parity

Rename query, add subscribe-before-submit streaming, default turn-end behavior
(sdk.sock `result`; interrupt counts as turn-end), `--detach`, output
selection, prompt-specific queue/no-query semantics, and session selection or
rollover while the submitted prompt is being observed.

### Spec 5: pictl event terminology and formatting — **done in pictl**

Fulfilled by pictl's own `docs/specs/format-streaming.md` (2026-07-30 survey):
`--type raw` is renamed to `--type events` on `tail` and `prompt`, events are
formatted by default (`format events` / `formatEvent`) with canonical JSONL
behind `--json`, the ontology above is adopted verbatim, and pictl retains its
two message adapters. The two repos' events formatters remain deliberately
independent (not in the sync set): pictl's stream carries pi's
`RpcSocketBroadcastEvent` union with no subscribe snapshot, so its formatter
is stateless, unlike clauctl's. Small documentation/guard residue is handed
off to a pictl-side session rather than specced here.

## Non-goals of this overview

- Fabricating persisted entries from sdk.sock messages, or an event→message
  adapter in clauctl.
- Defining every session-file entry formatter.
- Adding a second cursor-position type.
- Making tree output incrementally revise already-emitted lines.
- Preserving the `query` command name by default.
- Implementing clauctl and pictl changes in one cross-repository spec.
- The daemon-maintained entry stream (the large-file escape hatch) — deferred
  until file-derived display is measurably expensive.
