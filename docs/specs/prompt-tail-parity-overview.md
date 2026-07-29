# Prompt/tail parity roadmap

> Status: **planning overview**, not an implementation-ready spec. This document
> records the cross-cutting ontology, settled command behavior, constraints, and
> proposed sequence of follow-up specs. Each phase below gets its own spec and
> review before implementation. Return here when beginning a later phase so its
> spec is based on the whole plan rather than only the previous phase.

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

This is a multi-spec effort because the three observable data types come from
separate sources and are not mutually convertible.

## Ontology

The names describe what the records _are_, not where a command happens to use
them.

### Messages

Messages are the context-facing conversation units: user input, assistant
output, tool calls/results, summaries, and other values that can be presented
as what the assistant sees. A message stream may also contain explicitly typed
control records needed to explain changes such as navigation, compaction, or
model selection; controls are not mislabeled as messages.

Messages are a projection. They may be derived from persisted entries or from
live events where the source exposes equivalent context-facing information.
The two projections need semantic parity where their sources contain the same
facts, but exact equivalence is impossible for source-specific facts.

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
queue, control, interrupt, and context-change facts. Events include transient
facts that are not persisted.

`events` replaces the proposed CLI name `raw`. Events are formatted by default
like the other types; `--json` emits their canonical JSONL framing.

### Trees

A tree is a presentation of entries, not a fourth source ontology. Tree
construction consumes entries and interprets their parent links, compaction
boundaries, and current leaf.

Unlike the other formatters, a stable final tree cannot generally emit
incrementally: a later entry can add a branch or change active path markers and
connectors. `format tree` may consume a streaming input but buffers until EOF
before emitting the final tree.

## Conversion graph

For both clauctl and pictl, events and entries are sibling sources that can each
project to messages:

```text
entries ────────> messages <──────── events
   │
   └────────────> tree
```

There is no `events -> entries` conversion in either project:

- pictl events lack persisted entry IDs and other entry information;
- clauctl events carry many message UUIDs but still lack complete persisted
  entry records.

The implementations should expose explicit source adapters into common message
records rather than fabricate entries from events. Event-to-message and
entry-to-message adapters share downstream formatting, not an artificial
intermediate source type.

## Format command contract

The JSON input accepted by each formatter follows the conversion graph:

| Formatter         | Canonical JSON inputs        |
| ----------------- | ---------------------------- |
| `format events`   | events                       |
| `format entries`  | entries                      |
| `format messages` | messages, entries, events    |
| `format tree`     | entries or an entry snapshot |

Each formatter invocation consumes one homogeneous canonical input ontology.
`format messages`, `format entries`, and `format events` parse and emit
incrementally: they do not buffer the complete input until EOF, but bounded
conversion state and deferred emission are allowed. State such as tool-use IDs,
model state, and duplicate UUID tracking is retained across records and flushed
at EOF. `format tree` is the deliberate whole-input exception described above.

Prompt and tail must call the same adapters and record formatters as the
standalone `format` commands. Default output for a finite command should be
byte-equivalent to its `--json` output passed through the corresponding
formatter with default options.

Finer formatting options remain on `format`; callers request JSONL and pipe it
when they need non-default formatting.

## Canonical entry stream

### Duplicate UUIDs

The Claude CLI can re-persist previous entries with the same UUID. These are
copies of existing history, not new canonical entries. Entry-producing paths
must use one policy:

- first UUID occurrence wins;
- later entries carrying the same UUID are omitted entirely;
- every UUID-less entry occurrence is retained;
- deduplication happens over the complete session append sequence before
  applying `--since`.

Applying `--since` first would allow a later re-persisted copy of an earlier
entry to leak into output. A cursor UUID always identifies the retained first
occurrence.

Current clauctl behavior is not fully consistent: tree placement is first-wins,
while `entriesByUuid` uses the last serialization for payload lookup and
`get-entries` returns every copy. The first entry-stream spec must decide which
existing consumers adopt canonical first-wins behavior and pin any deliberate
exceptions.

### UUID-less entries

UUID-less entries are legitimate and remain visible in entry output. Observed
categories include:

- queue/cursor bookkeeping: `queue-operation`, `last-prompt`;
- mode/configuration: `mode`, `permission-mode`, `agent-setting`;
- presentation metadata: `ai-title`, `custom-title`, `agent-name`;
- file checkpointing: `file-history-snapshot`, `file-history-delta`;
- session/worktree metadata: `pr-link`, `worktree-state`;
- other observed records such as `started` and `result`.

Known types may receive concise entry summaries; unknown types degrade to a
generic summary rather than disappearing.

A UUID-less entry cannot advance a UUID cursor. If a session appends only
UUID-less records after a cursor, a later invocation or reconnection resumed
from that UUID can replay those trailing records. This limitation is accepted
in preference to introducing a second cursor type.

### Reading and following entries

`tail --type entries` must read and then follow the underlying session entry
source; it cannot use sdk.sock events as a substitute. The implementation
mechanism remains unresolved:

1. Derisk whether the SDK's `SessionStore.append` is a complete, ordered,
   SDK-supported observation point for the local session file without changing
   normal resume/load behavior.
2. If not, implement a daemon- or client-owned incremental JSONL follower using
   filesystem notifications, persistent byte position, torn-tail handling, and
   explicit handling of session replacement, truncation, or file replacement.

The follower must await actual file changes rather than sleep-polling. It must
establish observation before taking its initial snapshot so appends cannot fall
between history and follow. This synchronization is an implementation detail;
it need not appear as a boundary record in user output.

## Message sources and the history/live seam

Messages have two adapters:

- persisted entry -> message/control records, used for historical replay;
- sdk.sock event -> message/control records, used for live observation.

For `tail --type messages`, history is projected from entries and subsequent
live activity is projected from events. The follow-up spec must define the
handoff so no context-facing message is lost or shown twice. Unless a source
provides an atomic equivalent, tail must establish and buffer live event
observation before taking the history snapshot; the subscription snapshot
participates in overlap reconciliation. Exact persisted entries are not
required on sdk.sock, but overlapping event- and entry-derived representations
need stable matching or an ordered cutoff.

Echoed/queued user messages are the difficult case: daemon queue events do not
necessarily carry the eventual persisted UUID, and a demoted steer may persist
as a queued-command attachment rather than an ordinary user entry. The message
projection spec must define when such input is emitted and how historical and
live adapters produce semantically compatible records.

`prompt --type messages` subscribes before submitting the prompt and uses the
event adapter for live output. `prompt --type entries` observes the session
entry source across the prompt. `prompt --type events` emits sdk.sock events.
Concurrent activity from other clients may appear in any prompt stream; prompt
is an observation window, not an ownership filter.

## Cursor model

Canonical JSON records should carry their natural identities rather than adding
a synthetic final cursor record:

- UUID-bearing entries expose `uuid`;
- clauctl message records should retain their source entry/message UUID when
  known;
- event records expose message UUIDs and context-change leaves where available.

Human-readable message formatting hides those IDs, so a finite formatted
message stream ends with a cursor only when that UUID is known to identify a
retained canonical entry usable by `tail --since`:

```text
[cursor: <last-stable-uuid>]
```

The standalone streaming formatter emits the same line when it reaches EOF.
Entry formatting already displays UUIDs where present, and event formatting can
show the identities carried by its records; whether either also prints a final
cursor is unnecessary by default and can be settled in its implementation
spec.

An indefinitely followed stream has no natural EOF and therefore emits no
promised final cursor when externally interrupted. `--timeout 0`, a met
`--until`, or a successful finite prompt gives the formatter a normal flush
point.

The message-projection spec must establish how event observations become known
to identify retained canonical entries before their UUIDs can be printed as
resumable cursors. The exact fallback when the newest context-facing record has
no such UUID, especially an echoed user message, may retain the previous stable
cursor until a canonical persisted identity is confirmed.

## Command behavior

### `prompt`

`query` is renamed to `prompt`. Backward compatibility is not required unless a
later spec explicitly adds an alias.

By default, prompt:

1. subscribes before submitting input so a fast turn cannot be missed;
2. submits the prompt;
3. streams until the prompted turn ends;
4. formats messages unless another type or `--json` is selected;
5. flushes any formatted cursor on finite completion.

`-d`/`--detach` preserves today's fire-and-forget behavior: submit and return
without streamed output. `--detach` combined with flags expressing an intent to
wait is a usage error. The prompt spec must define `--no-query`, queue priority,
and already-busy-agent behavior explicitly rather than assuming every accepted
input produces its own result.

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
- entries follow the session entry source.
- events follow sdk.sock and have no historical backlog. Whether
  `events --timeout 0` emits the subscription snapshot, emits nothing, or is
  rejected is deferred to the tail spec.
- messages replay entry-derived history and then follow event-derived messages.

Dormant or archived agents:

- entries and messages read the latest session file and return after history;
- events fail because no live sdk.sock event source exists;
- tail never revives an agent merely to observe it.

Session rollover and a cursor not present in the current session need explicit
behavior in the tail spec. At minimum, a missing cursor must be an error rather
than silently meaning “from the beginning.” The same spec must classify an
active-to-dormant transition during the history/live handoff or later follow as
normal finite completion, retryable loss, or an error.

## Pictl symmetry

A later pictl spec should:

- rename `--type raw` to `--type events`;
- add human-readable event formatting;
- make `--json` emit canonical event JSONL;
- use the same ontology terminology and formatter acceptance rules;
- retain pictl's two independent message adapters from entries and events.

This is a behavioral/interface change in pictl and is deliberately separate
from clauctl implementation specs.

## Follow-up sequence

### Spec 1: canonical session-entry stream

Before drafting, run the focused SessionStore experiment described above. Then
specify:

- the selected read/follow mechanism;
- watch-before-read and flush ordering;
- torn tails, replacement, truncation, and session rollover;
- canonical first-wins UUID deduplication;
- UUID-less entry preservation;
- `since` slicing and missing-cursor errors;
- live and dormant adapters behind one small interface;
- incremental tests driven by observable conditions rather than sleeps.

This foundation should be useful independently of prompt/tail formatting.

### Spec 2: streaming conversions and formatters

Specify:

- canonical message and control record types;
- provenance and stable matching fields required by resumable cursors and the
  later tail history/live handoff;
- entry-to-message and event-to-message adapters;
- echoed/queued/steered user-message semantics;
- the subscription snapshot's canonical event representation and ordering;
- incremental JSONL decoders and writers;
- `format entries`;
- incremental `format messages` and `format events`;
- EOF cursor formatting;
- the buffered `format tree` exception and expanded accepted inputs.

### Spec 3: tail parity

Build tail on the canonical entry stream, message adapters, format writers, and
existing generic stream driver. Specify all type/JSON/since/timeout/until,
dormancy and active-to-dormant transitions, rollover, and history/live handoff
behavior. Classify every settlement path as graceful completion or external /
transport interruption so formatter flushing and cursor emission follow
mechanically.

### Spec 4: prompt parity

Rename query, add subscribe-before-submit streaming, default turn-end behavior,
`--detach`, output selection, prompt-specific queue/no-query semantics, and
session selection or rollover while the submitted prompt is being observed.

### Spec 5: pictl event terminology and formatting

Apply the shared ontology to pictl, rename raw to events, and add event
formatting without claiming that pictl events can reconstruct entries.

## Non-goals of this overview

- Selecting SessionStore versus filesystem following without an experiment.
- Defining every session-file entry formatter.
- Fabricating persisted entries from sdk.sock messages.
- Adding a second cursor-position type.
- Making tree output incrementally revise already-emitted lines.
- Preserving the `query` command name by default.
- Implementing clauctl and pictl changes in one cross-repository spec.
