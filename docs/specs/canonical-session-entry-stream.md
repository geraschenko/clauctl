# Canonical session-entry stream

> Status: **draft implementation spec**. This is Spec 1 from
> [prompt-tail-parity-overview.md](prompt-tail-parity-overview.md). It defines
> the persisted-entry foundation only; command flags, formatting, and the
> messages history/live handoff belong to later specs.

## Problem

Claude session entries are durable JSONL records written by two producers:

- the Claude subprocess writes ordinary transcript and bookkeeping entries;
- clauctl writes synthetic compact-boundary entries directly for
  `set-context`.

`clauctl tail --type entries` and `prompt --type entries` need one ordered
source that can replay existing entries and then follow new entries without a
history/live gap. sdk.sock events cannot reconstruct entries, and the SDK's
alpha `SessionStore.append()` hook does not observe clauctl's direct writer.
Even if supplemented, SessionStore would still require snapshot/callback overlap
reconciliation and would participate unnecessarily in query resume.

The focused experiment is recorded in
[session-store-entry-observation/FINDINGS.md](../derisk/session-store-entry-observation/FINDINGS.md).
Its conclusion is to follow the local session JSONL file directly, by byte
position, with observation established before the initial snapshot.

The current `readSessionEntries()` is a whole-file snapshot reader. It tolerates
an unterminated final line, but has no persistent byte position, no change
observation, and no canonical duplicate handling. `get-entries` returns every
raw occurrence. Those behaviors are useful for tree reconstruction but are not
the canonical entry stream required by prompt and tail.

## Goals

1. Read a session file to a stable byte cutoff and optionally continue from
   that exact byte position.
2. Emit complete JSON objects in file-append order without losing an append at
   the snapshot/follow seam.
3. Preserve every UUID-less occurrence.
4. Canonicalize duplicate UUIDs as first-position/last-content for historical
   output, with the accepted no-revision behavior after live emission.
   TDC: Let's look into why last-content was decided in the first place. A simple first-wins for everything seems more logical to me. I remember being confused by this at the time and not really understanding the argument, but I *do* remember there being an argument for it. Have a look at docs/specs/repersisted-duplicates-handoff.md and docs/derisk/cli-history-repersistence/FINDINGS.md, loadedContext in src/core/tree/loader.ts, and docs/specs/session-tree.md.
5. Apply a UUID cursor only after canonicalization and error when the cursor is
   absent from the selected session.
6. Follow session rollover while an agent remains live.
7. Use the same entry-stream interface for live and dormant agents.
8. Settle and test corruption, torn tails, file creation, replacement,
   truncation, cancellation, and daemon exit without clock sleeps.

## Source of truth

The session JSONL file is the only entry source.

SessionStore is not installed on SDK queries. No exact entry records are added
to sdk.sock. sdk.sock remains useful only as the live-agent lifecycle and
session-identity signal: its atomic subscribe seed identifies the current
session, subsequent folded states identify rollover, and socket close identifies
normal end of live observation.

The registry remains the authority for mapping a session ID to its file path.
For an already-recorded session this is `AgentRecord.sessions`. On rollover,
the daemon queues the updated `agent.json` write before broadcasting the
session-changing `system/init`; the live adapter waits, using filesystem
observation, until that session ID appears in the registry rather than deriving
or guessing the path.

## Terminology

- **Raw occurrence**: one complete newline-terminated JSON object in the
  session file. Duplicate UUID occurrences remain distinct at this level.
- **File epoch**: one identity of one path while it grows append-only. Replacing
  the path's inode or truncating it ends the epoch with an error.
- **Session epoch**: the selected current session from its beginning until the
  live agent announces another session or exits. Rollover starts a new session
  epoch and resets duplicate tracking.
- **Historical cutoff**: the file size captured for the initial read after
  observation has been established.
- **Canonical entry**: one UUID-bearing entry at its first raw position carrying
  the last content available in the complete historical cutoff, or one
  preserved UUID-less raw occurrence.

## Public module shape

Add `src/core/session-entry-stream.ts`. Its external seam is one
`AsyncIterable<SessionEntry>`; callers should not coordinate file watches,
byte offsets, torn tails, duplicate sets, or rollover themselves.

The implementation may use private helpers and internal seams, but the public
shape should remain equivalent to:

```ts
import type { UUID } from "node:crypto";
import type { AgentState } from "./agent-state.ts";
import type { AgentRecord } from "./registry.ts";
import type { SdkEvent, SdkEventSubscription } from "./sdk-socket.ts";
import type { SessionEntry } from "./session-file.ts";

// TDC: This interface doesn't look like it has anything to do with session entries. It looks like an attempt to reimplement src/core/until.ts. Why are you proposing this at all? Is this something to do with trying to line up the entries from the file with events in the stream?
export interface LiveSessionEntrySource {
  /** Exclusively consumed by streamSessionEntries. */
  readonly subscription: SdkEventSubscription;
  /** Return true to establish a normal cutoff at the seed/event. */
  readonly stopAtSeed?: (seed: AgentState) => boolean | Promise<boolean>;
  readonly stopAfterEvent?: (
    event: SdkEvent,
    state: AgentState,
  ) => boolean | Promise<boolean>;
}

export interface SessionEntryStreamOptions {
  readonly since?: UUID;
  readonly follow: boolean;  // TDC: why are we introducing `follow`? I thought we agreed to make this the default and use `--timeout 0` for no-follow.
  /** Present only for a followed live agent. The caller owns the socket. */
  readonly live?: LiveSessionEntrySource;
  /** External normal cutoff (for example a deadline or command failure). */
  readonly signal?: AbortSignal;
}

export function streamSessionEntries(
  agent: AgentRecord,
  options: SessionEntryStreamOptions,
): AsyncIterable<SessionEntry>;
```

`streamSessionEntries` is the sole consumer of `subscription.events`. It
processes the seed and events in order, invokes the supplied stop predicates,
and derives session rollover from the same post-fold states. A caller may send
requests on the owning `SdkSocketClient` but must not pass the subscription to
`runStream` or start another iterator over its `AsyncQueue`. Specs 3 and 4 will
supply their until/turn-end predicates through these callbacks rather than
split event consumption.
TDC: huh? why on earth would we not use runStream? The only argument I can imagine is that you want to ignore the sdk stream entirely and just focus on the file stream or something, writing state-tracking logic that is based on entries only. That would be fine, but that's just a different application of runStream. What is the point of reimplementing something we've carefully extracted an abstraction for?

This signature is normative for this phase. Callers consume one entry async
iterable and do not receive a second record ontology. File-change, lifecycle,
and rollover signals stay internal.

Interface invariants:

- `live` is required when `follow` is true for an agent classified as running;
  the caller subscribes before constructing/iterating the stream. Supplying
  `live` with `follow: false`, or omitting it for a running followed agent, is
  an immediate interface error before output.
- A dormant or archived source has no `live` subscription. It emits history
  from the latest recorded session and ends, regardless of `follow`.
- `follow: false` reads the latest session recorded in the supplied agent
  snapshot, does not consume a live subscription, and accepts no later file or
  registry activity.
- The caller owns the SDK client. Returning from or cancelling entry iteration
  does not close it; it does close every filesystem watcher and file handle
  owned by this module.
- Iteration and the supplied subscription are single-consumer. Producer
  completion drains accepted entries while consumer `return()` may discard
  queued entries.

## Historical canonicalization

Canonicalization is per session epoch and runs over every complete raw
occurrence ending at the historical cutoff.

For each UUID-bearing entry:

1. The first occurrence fixes its position among canonical entries.
2. Each later occurrence replaces the payload stored for that position.
3. Exactly one entry is emitted for the UUID.

Every UUID-less occurrence occupies its own position and is never deduplicated.
Its object is emitted unchanged.

A direct implementation is a single scan that builds an ordered array of
slots plus `uuid -> slot index`; UUID-less entries append a new slot, first UUID
occurrences append and register a slot, and later UUID occurrences replace that
slot's payload. This is `O(n)` time and `O(n)` memory for the historical
snapshot. Buffering is required here because the last content is unknowable
until the cutoff; after canonicalization, entries are emitted incrementally.

This buffering is an entry-producer responsibility. Downstream non-tree
formatters remain incremental and require no future knowledge.

### Raw snapshots remain raw

`SessionSnapshot.entries` and `readSessionEntries()` remain the raw append
sequence. They are inputs to tree construction, forensic inspection, and
set-context loading, not the canonical stream interface.

This distinction is necessary rather than backward compatibility:
`buildTree(rawEntries)` uses the first serialization of a UUID to establish its
raw parent/relink placement, while `entriesByUuid(rawEntries)` supplies the
last serialization as rendered payload. Replacing `SessionSnapshot.entries`
with the single canonical object would make the last serialization's
`parentUuid` overwrite first-occurrence tree placement. `format tree` therefore
continues to consume raw entries/snapshots and applies its existing
first-placement/last-payload split.
TDC: Explain this to me. What exactly would go wrong if we ignore repersisted instances of a uuid entirely?

Entry-producing CLI paths introduced by later specs use
`streamSessionEntries`; they do not print `SessionSnapshot.entries` directly.

## Cursor slicing

`since` is interpreted within the initially selected session epoch:

1. Canonicalize the complete historical cutoff.
2. Find the UUID-bearing canonical entry whose `uuid` equals `since`.
3. Emit every canonical entry after that slot, including UUID-less entries.

If no retained canonical entry has that UUID, reject before emitting any
history with an error naming both the cursor and session. A session with no
current ID also rejects a supplied cursor. Missing cursor never means “from the
beginning.”

Because duplicate UUID copies never create positions, a repeated copy after the
cursor cannot leak into output. A cursor identifies the first retained
position, even though the emitted historical payload is the last copy available
at the cutoff.

UUID-less entries cannot be cursors. If only UUID-less records follow the last
UUID, reconnecting with that UUID can replay those trailing records. This is an
accepted limitation; no second cursor type is introduced.

`since` is consumed by the initial session only. If a followed agent rolls over,
the new session is emitted from its beginning; the old cursor is not searched
for there.

## Watch-before-read algorithm

Filesystem notifications are wakeups, not records. Correctness comes from
checking file identity and size and draining bytes by position after every
wake; it does not assume one notification per append.

For an existing selected session file:

TDC: Do we really have to implement this tailing logic? Surely there already exists a library for efficiently `tail -f`ing a file. Let's do some research.
1. Establish observation on the containing directory before inspecting the
   file. Directory observation survives atomic path replacement and also
   supports a session file that does not exist yet.
2. Open the selected path and record its file identity (`dev` + `ino`).
3. Capture `historicalEnd = fstat(handle).size`.
4. Read exactly byte range `[0, historicalEnd)` from that handle.
5. Parse every newline-terminated record in that range. Retain an unterminated
   suffix in memory and set `readOffset = historicalEnd`: every byte before
   `readOffset` is represented either by a parsed line or by that suffix and is
   never read again. A later read starts at `readOffset`, appends new bytes to
   the suffix, and parses the combined buffer.
6. Re-stat both the open handle and selected path. They must still have the
   same recorded identity, and the handle must still cover `historicalEnd`.
   Perform this validation before emitting any buffered history.
7. Canonicalize and apply `since`; emit that history.
8. If following, drain from `readOffset` to the current EOF.
9. Before parking, re-stat and re-check the selected path after observation is
   active. If bytes appeared during setup/drain, continue draining instead of
   waiting for another notification.
10. Thereafter, each relevant notification wakes the drain loop. The loop reads
    to a captured EOF, parses complete lines, preserves a torn suffix, then
    rechecks identity and size before parking again.

An append can therefore fall either before or after `historicalEnd`, but not
between unobserved history and follow. Coalesced notifications are harmless
because one wake drains all available bytes.

Wakeups must be latched. The Node watcher adapter records a monotonically
increasing generation (or queues one coalesced token) even when no consumer is
parked. The drain loop captures the generation before its final predicate
checks and parks only through a wait operation that first compares that
captured generation with the current one. An event between the final stat and
parking therefore causes an immediate next drain rather than a lost wakeup.

The implementation must read bytes (`Buffer`), not slice decoded strings by
byte offset. UTF-8 code points may span read chunks. JSON parsing happens only
after a newline terminates the complete byte sequence; `Buffer.toString`
therefore never needs to decode a partial record.

### File creation

No recorded session:

- finite/dormant history emits nothing;
- a supplied `since` errors;
- a live followed source waits for the subscription to announce a session.

A recorded or newly announced session whose path does not yet exist is normal
only while the agent is live. Keep the containing-directory observation active
and open it when it appears. A dormant agent whose recorded latest file is
missing errors as registry/session-file inconsistency.

### Torn tails and malformed records

An unterminated final byte suffix is not emitted and is retained across wakes.
When later bytes complete its newline, parse and emit the resulting record once.

A newline-terminated line that is malformed JSON, parses to a non-object, or
contains a present `uuid` that is not a UUID string is corruption and rejects
the stream with `path:line` context. Only an absent `uuid` field is UUID-less;
`null`, numbers, and malformed strings do not silently enter that category.
Blank lines are ignored consistently with `readSessionEntries()` but still
advance byte and line positions. Other known fields retain the existing
lenient `SessionEntry` treatment.

At a normal finite cutoff or daemon exit, an unterminated suffix remains
unemitted. It is an incomplete write, not an entry. Do not wait on a timer for
it to become complete after the source has ended.

### Replacement and truncation

After the initial open, the selected file is append-only for the duration of
its file epoch.

Reject explicitly if:

- the path is removed after it was opened;
- the path resolves to a different `dev`/`ino`;
- its size becomes smaller than the highest byte extent already observed;
- a read expected within the observed extent reaches unexpected EOF;
- the directory or file watcher reports an error or closes unexpectedly;
- stat/open/read fails for permissions or another non-transient I/O reason.

Do not reopen and replay from byte zero. That would duplicate UUID-less entries
or hide data loss. Include the session ID and path in the error.

Atomic creation of a previously missing file is not replacement. Session
rollover to a different registered path is also not replacement; it starts a
new session epoch.

On ordinary local filesystems `fs.watch` is the supported notification
mechanism. Its notifications may coalesce, but the implementation cannot repair
an operating-system watcher overflow or a filesystem for which Node documents
`fs.watch` as unreliable (for example some network filesystems) without
polling. Watcher errors are therefore loud. A truncate-and-regrow that restores
or exceeds the old size on the same inode entirely between two observations is
also not detectable; the append-only contract and identity/size checks catch
observable violations, not impossible-to-observe intermediate states.

## Live coordination state machine

The implementation starts the SDK lifecycle pump, a background coordinator,
and all relevant directory watchers before awaiting a file or registry
predicate. The lifecycle pump is the sole iterator of `subscription.events`;
it never waits for file creation, registry persistence, entry parsing, or
consumer demand. It converts the seed/events into an internal, latched control
queue consumed by the coordinator.

The coordinator also runs independently of async-iterator pulls. It owns session
selection, registry/file availability, identity checks, watcher generations,
and EOF capture. The entry iterator owns byte reading, parsing, canonicalizing,
and yielding, but consumes immutable file-epoch plans produced by the
coordinator. A consumer suspended at `yield` therefore cannot delay a rollover
or terminal cutoff.

Internal controls are equivalent to:

- `session(sessionId)`: seed or authoritative post-fold session selection;
- `fileDirty` / `registryDirty`: coalesced watcher wakeups;
- `cutoff`: a stop predicate or external signal fired;
- `sourceEnd`: the subscription queue closed after its accepted events drained;
- `sourceError(error)` / `watchError(error)`: reject.

Control acceptance order resolves races. Accepting `session(newId)`, `cutoff`,
or `sourceEnd` synchronously freezes the currently open epoch before queuing the
control: compare path/handle identity and capture EOF with the synchronous stat
operations while JavaScript control cannot interleave another callback. The
control carries that immutable cutoff. If an announced epoch is still waiting
for its registry mapping or file, control acceptance synchronously reads and
validates `agent.json`, resolves the mapping, and opens/stats the file. If that
cannot complete immediately, reject the stream as an unavailable announced
session; do not defer the check or weaken the cutoff. This small synchronous
metadata operation is deliberate: deferring EOF capture until a slow consumer
or later coordinator turn would make output depend on formatter speed.

Once a terminal control (`cutoff`, `sourceEnd`, or error) is accepted, later
controls are not accepted. An accepted error rejects; a watcher error occurring
after a normal cutoff is not part of the source. The coordinator never blocks
while resolving one predicate: a pending registry/file-open operation remains
interruptible by a newer `session`, terminal control, or error.

Lifecycle processing order is:

1. enqueue the seed's defined `sessionId`;
2. invoke `stopAtSeed`; if it returns true, enqueue `cutoff`;
3. for each queued event, enqueue a defined post-fold session ID when it differs
   from the last authoritative ID, then invoke `stopAfterEvent` and enqueue
   `cutoff` if it returns true;
4. after event iteration ends, enqueue `sourceEnd`.

The stop callbacks are awaited, preserving SDK event order. When one returns
true, cancel `subscription.events` immediately after enqueuing `cutoff`; queued
later SDK events are discarded and no later stop callback runs. A thrown or
rejected callback enqueues `sourceError`, cancels the subscription queue, and
rejects the entry iterable.

If an external `AbortSignal` cutoff is accepted while an async stop callback is
pending, the external cutoff wins: cancel lifecycle consumption and ignore the
callback's eventual value or rejection (attach a rejection handler so it cannot
become unhandled). The normal cutoff does not wait for callback settlement.

A repeated init for the same session does nothing. A transient
`conversation_reset` state with no session ID does not unset the authoritative
file selection; the subsequent init supplies any new ID.

## Accepted byte cutoffs

Each open file epoch tracks:

- `readOffset`: the end of bytes already read into parsed records or the torn
  suffix;
- `acceptedEnd`: the greatest EOF this stream has committed to drain;
- `drainEnd`: the immutable EOF captured for an in-progress drain.

On a normal dirty wake, the coordinator validates path/handle identity,
captures `drainEnd = fstat(handle).size`, and raises `acceptedEnd` to that value.
The pull-driven reader may drain through accepted extents at its own rate; an
append after capture waits for another wake/recheck.

The synchronous acceptance path for a terminal or rollover control computes the
immutable epoch cutoff as `max(acceptedEnd, drainEnd, captured EOF)`. The
coordinator then closes that epoch's watchers, records the frozen cutoff in the
epoch plan, and never recaptures its EOF. Freeze acceptance is the final
path-name identity check: replacement after the accepted cutoff is outside the
source and must not retroactively fail it. The reader later drains exactly
through the retained handle, validating only that the handle still has the
opened identity, still covers the frozen extent, and does not return unexpected
EOF. It ignores later appends and never resolves the frozen path again.

The resulting precedence is mechanical:

- `session(newId)`: freeze the old epoch immediately, then resolve/open and
  coordinate the new session from byte zero without waiting for the consumer
  to drain the old one. The iterator still drains epoch plans in order and
  resets UUID tracking between them. A later queued cutoff applies to the new
  epoch; a cutoff dequeued first suppresses the rollover.
- `cutoff`: do not process later lifecycle or watcher controls; drain the
  current epoch through its cutoff and finish normally.
- `sourceEnd`: all SDK events accepted before close have already been processed;
  cut off the current epoch through its final captured EOF and finish normally.
- error: reject immediately, except that records already yielded cannot be
  rolled back.

If no session has been announced at a normal terminal control, finish empty
unless a `since` cursor still needs resolution, in which case error. If an
announced live session is still waiting for its registry mapping or initial
file when cutoff, source close, or rollover away from it is accepted,
synchronously resolve and open it at that control. Use it if immediately
present; otherwise reject for an announced but unavailable session. Never
abandon such an epoch as empty, admit bytes from a later check, or hang behind
it.

The SDK ordering established by the SessionStore probe is relevant to event
cutoffs: transcript mirror batches were flushed before a turn's `result`, and
clauctl's synthetic writer completes synchronously before its `contextChanged`
event. Capturing the file EOF after processing that event therefore includes
entries accepted before the condition without sleeping.

Consumer iterator `return()` is stronger cancellation than `cutoff`: cancel the
lifecycle queue, close watchers/handles, and allow queued entries to be
discarded so a broken downstream pipe does not force a drain. The external
`AbortSignal` and true stop predicates produce normal draining `cutoff`, not
this destructive cancellation.

## Live following and rollover

The seed's session is resolved through the supplied `AgentRecord.sessions`. If
the caller's record is stale, registry observation runs concurrently with the
lifecycle controls until the ID appears. On rollover, the coordinator freezes
the old epoch and starts coordinating the new registered path from byte zero;
the iterator later drains those plans in order. UUID identity and cursor state
reset because they are session-scoped.

The stream does not emit a synthetic rollover record. Consumers see the old
session's final entries followed by the new session's entries. Writes after the
old epoch cutoff are ignored. Message/control formatting may explain rollover
later using the independent event projection.

Daemon exit is `sourceEnd`, not an entry-stream error. It turns a live followed
source into the same finite state as dormant history. Corruption discovered in
the final accepted extent still rejects.

## Live duplicate behavior

The historical cutoff has complete knowledge only up to that cutoff. After
history emission, retain a set of every UUID seen in the session epoch,
including UUIDs suppressed during historical canonicalization.

For each newly completed raw occurrence:

- UUID absent: emit it;
- UUID not seen: add it and emit its then-current content;
- UUID already seen: suppress it entirely.

A later duplicate does not revise already-emitted output and does not emit an
update record. A later historical invocation may show that duplicate's content
at the original position. This temporal difference is accepted because
observed Claude re-persistence preserves semantic content while normalizing or
restamping sidecar fields.

## Ordering and backpressure

- History emits before every post-cutoff entry from the same session.
- Complete live entries emit in file order.
- Rollover drains accepted old-session bytes before new-session history.
- Writes occurring after the rollover cutoff in the abandoned old file are not
  followed; that file is no longer the agent's current entry source.
- Parsing and entry emission are pull-driven by the async-iterator consumer;
  parsed live entries are not accumulated by an independent producer. The
  background coordinator continues to freeze accepted extents and rollover
  epochs while the consumer is slow. Later pulls read only those recorded
  extents.
- Memory is `O(historical entries + largest unconsumed live line + queued
control signals + session epochs awaiting drain)`. A slow consumer across
  repeated rollovers retains one open file handle and immutable plan per epoch;
  it does not buffer those files' bytes. Historical first-position/last-content
  semantics require the `O(history)` portion.

Use a local queue to combine filesystem and lifecycle controls, not to create a
second unbounded entry stream. Preserve producer-close/consumer-cancel
semantics; do not modify the generated pictl `AsyncQueue` for clauctl-specific
records.

## Existing code changes

### `src/core/session-file.ts`

Keep these existing interfaces and semantics:

- `SessionEntry`;
- `readSessionEntries()` as raw whole-file reading;
- `entriesByUuid()` as last-content lookup;
- `appendSessionEntries()` as the direct synthetic writer;
- `waitForEntryOnDisk()` for existing get-messages/get-entries flush gates.

Move shared validation/parsing into a pure helper only if both snapshot and
incremental paths can use it without making byte/line state implicit. Do not
rewrite the existing loader consumers onto the canonical stream.

### `src/core/session-entry-stream.ts`

Own:

- raw incremental byte parsing and line accounting;
- file identity/position state;
- historical canonicalization and `since` slicing;
- live duplicate suppression;
- watcher lifecycle;
- live/dormant selection and rollover orchestration.

Keep semantically separate pure operations separate from effects. In
particular, historical canonicalization/slicing should be directly testable
without filesystem setup, while watcher orchestration remains behind the async
iterable interface.

The effectful implementation has an internal `FileObservation` seam covering
watch installation, open/read/stat, and latched wake delivery. It has two real
adapters: Node's filesystem and a deterministic fake used by race tests. This
seam is private to the module; production callers still see only the entry
async iterable. The fake exposes barriers immediately before/after open, stat,
read, wake delivery, and park so tests can force interleavings without sleeps.

### Registry observation

Add a condition-based helper that observes `agent.json` atomically replacing
until its latest session mapping includes the requested session ID. Establish
the directory watch before the first read and re-read after watch setup, just as
with the session file. Extract the existing `readAgentRecord()` validation into
a shared pure parser used by both its asynchronous path and the synchronous
terminal-cutoff read; do not create divergent registry parsers. Then validate
the selected `SessionHistoryEntry`: `sessionId` and `sessionFile` must both be
strings, IDs must be unique, and two distinct IDs must not map to the same file
path. Invalid mappings reject as registry corruption.

A watcher event is only a wakeup. If an unrelated agent-record write occurs,
re-check the predicate and continue waiting. The wait remains interruptible by
rollover, cutoff, source close, or watcher error. Daemon/socket close before the
mapping appears triggers one final registry read, then errors because an
announced session without a durable registry mapping is inconsistent.

A removed agent directory/record or a registry watcher error also rejects.
Permission and other I/O errors are not treated as “not written yet.”

### No command changes yet

Do not add `tail --type`, `prompt`, formatter changes, or new sdk.sock entry
records in this phase. A focused internal test harness or an unadvertised core
export may exercise the stream. Command wiring belongs to Specs 2–4.

## Tests

Tests use temporary directories and observable conditions. Do not use sleeps to
“give fs.watch time”; await watcher installation, a yielded entry, a callback,
or iterator settlement. Timeouts may bound a failed test but are not the
synchronization mechanism. Race tests use the fake `FileObservation` barriers
to place appends/replacements/cutoffs at the exact open/stat/read/park step;
they do not attempt to probabilistically schedule real `fs.watch`.

### Pure canonicalization

- unique UUID entries preserve order and content;
- duplicate UUID: first slot, last payload, one output;
- interleaved UUID-less occurrences retain every occurrence and relative slot;
- three or more duplicate copies remain one slot with final payload;
- `since` slices after the first retained position and includes following
  UUID-less entries;
- a duplicate copy physically after `since` does not leak;
- missing cursor errors before any output;
- empty history plus cursor errors.

### Incremental parser/follower

- initial complete lines emit in order;
- append after watcher setup emits without restarting the read;
- append racing the historical snapshot appears exactly once;
- multiple lines in one write and one line split across writes;
- multibyte UTF-8 split across read chunks;
- torn historical tail is retained and emitted only after newline completion;
- malformed terminated JSON, non-object JSON, and malformed present UUIDs
  reject with path/line;
- blank lines advance positions but emit nothing;
- a wake arriving after final stat but before park is latched and drains;
- coalesced notification drains every available line;
- cancellation while parked closes watchers and settles;
- consumer `return()` discards pending output and settles;
- dormant finite read creates no persistent watcher.

### File lifecycle

- initially missing live file is observed when created;
- missing dormant recorded file errors;
- replacement between open and historical emission errors before output;
- path removal or replacement after open but before freeze errors without
  replay;
- replacement after a frozen cutoff does not retroactively fail delayed
  handle-based draining;
- truncation errors without replay;
- watcher error/unexpected close and permission errors reject;
- append after rollover cutoff in the old file is not emitted;
- unrelated directory events neither emit nor fail.

### Duplicate live semantics

- duplicate present wholly in history uses last content at first position;
- first live UUID emits;
- later live duplicate is suppressed and does not revise output;
- UUID first seen historically and repeated live is suppressed;
- every live UUID-less occurrence emits;
- rollover resets duplicate tracking.

### Agent lifecycle

Use a fake live-session signal at the internal seam rather than a real daemon
for exhaustive cases; add one sdk.sock integration test to prove seed/event
ordering maps correctly.

- dormant and archived agents emit latest-session history then finish;
- fresh dormant agent emits an empty stream;
- live seed history is selected before queued events;
- lifecycle rollover/source-close interrupts a missing seed file or registry
  mapping and synchronously rejects if it remains unavailable;
- with A open and B pending, accepting session C or a terminal cutoff performs
  B's synchronous final check; it never admits B bytes from a later check;
- a stale supplied `AgentRecord` waits for the atomically replaced registry
  record containing the announced session;
- malformed session mappings and two session IDs mapped to one path reject;
- same-session init is ignored;
- conversation reset without authoritative init does not switch files;
- rollover drains old accepted bytes then emits the new session from byte zero;
- daemon close drains queued lifecycle events and final file bytes, then
  completes normally;
- registry never recording an announced session errors after source close;
- stop-predicate/abort cutoff during an in-progress drain includes the previous
  `drainEnd`, synchronously captures one final EOF, and completes normally;
- pause after one yielded entry, trigger a stop event, wait for cutoff
  acceptance, append another complete entry, resume, and verify the later entry
  is excluded;
- repeat that paused-consumer pattern for rollover (late old-session append
  excluded) and source close (post-close append excluded);
- queued rollover before cutoff switches sessions; cutoff before rollover does
  not;
- a rejected stop callback cancels lifecycle consumption and rejects; a true
  callback discards queued later events without invoking their callbacks;
- external abort while an async stop callback is pending wins and ignores the
  callback's handled eventual value/rejection;
- consumer iterator `return()` cancels without the normal final drain.

### Regression coverage

- `SessionSnapshot.entries` still contains raw duplicate occurrences;
- `buildTree(raw)` plus `entriesByUuid(raw)` retains first placement and last
  payload;
- existing set-context/get-entries/session-tree tests remain green;
- `npm run presubmit` passes.

## Success criteria

1. A history/follow seam race test appends while the snapshot is being taken
   and observes every complete raw occurrence exactly once after canonical
   duplicate handling.
2. A real set-context synthetic append and a subprocess append are both
   observed through the same file source.
3. A file containing re-persisted UUIDs emits one canonical UUID entry at its
   first position with last historical content, while preserving all UUID-less
   occurrences.
4. A live re-persisted UUID is suppressed without revising prior output.
5. `since` cannot be bypassed by a duplicate copy and a missing cursor fails
   loudly.
6. A live rollover emits the old session through its accepted cutoff and the
   new session from its beginning; a later old-session cursor is invalid for
   the new current session.
7. Replacement/truncation reject; daemon exit and dormant history complete
   normally.
8. Tests synchronize on conditions rather than elapsed sleeps, and full
   presubmit passes.

## Non-goals

- SessionStore integration.
- Persisting exact entries on sdk.sock.
- Formatting entries, messages, events, or trees.
- Changing `SessionSnapshot` into a canonical entry list.
- Defining message projection or the messages history/live handoff.
- Adding `tail --type`, `tail --since`, or streaming `prompt` command surfaces.
- Following old session files after rollover.
- Revising already-emitted records when a later duplicate appears.
- A cursor for UUID-less entries.
- Recovering automatically from file replacement or truncation.
- Polling the filesystem on a sleep interval.

## Implementation sequence

1. Add pure historical canonicalization and cursor slicing with focused tests.
2. Add the byte-oriented incremental line reader and append-only file epoch
   follower; test creation, races, torn tails, corruption, and identity errors.
3. Add dormant selection and finite history through the public iterable.
4. Add live subscription/session selection, registry observation, rollover,
   cutoff, and daemon-close draining.
5. Run focused tests after each step, then full presubmit.
6. Run a live smoke test that observes one ordinary turn, one synthetic
   set-context append, and session rollover without sleeps.
7. Update this work log with implementation-time decisions and verification.

## Work log

- [x] SessionStore observation derisk completed; selected direct file following.
- [x] Settled rollover: drain old accepted bytes, then emit the new current
      session from its beginning.
- [x] Settled replacement/truncation: explicit error, never replay from zero.
- [x] Settled daemon exit: final drain and normal finite completion.
- [x] Fresh-context review (reviewer `2efb3fd4`): resolved torn-tail position,
      single subscription ownership, concurrent lifecycle coordination,
      latched wakeups, immutable consumer-independent cutoffs, unavailable
      pending epochs, and post-freeze path identity; approved as
      implementation-ready.
- [ ] Owner approval.
- [ ] Implementation.
