# Canonical session-entry stream

> Status: **draft implementation spec**, revised after owner review. This is
> Spec 1 from
> [prompt-tail-parity-overview.md](prompt-tail-parity-overview.md). It defines
> fixed-session historical reading and following only. Agent lifecycle,
> sdk.sock settlement, session rollover, and command behavior remain in the
> later prompt/tail specs and must compose through the existing `runStream`.

## Problem

Claude session entries are newline-delimited JSON objects persisted in a local
session file. Two writers append to that file:

- the Claude subprocess writes transcript and bookkeeping entries;
- clauctl writes synthetic compact-boundary entries directly for `set-context`.

Future `tail --type entries` and `prompt --type entries` need the actual entry
source. sdk.sock events cannot reconstruct entries, and exact persisted entries
must not be added to the event protocol.

The current `readSessionEntries()` reads a whole file. It tolerates an
unterminated final line, but cannot incrementally follow appends or preserve a
history/follow byte cutoff. A first draft of this spec mixed file following with
sdk.sock lifecycle, timeout, rollover, registry observation, and condition
settlement. That duplicated `runStream` and produced a second streaming engine.
This revision keeps the module at the file seam.

## Goals

1. Define one canonical duplicate policy for entry output and tree payloads.
2. Read canonical history, optionally after a UUID cursor.
3. Follow one existing session file from an exact initial byte cutoff.
4. Preserve every UUID-less occurrence.
5. Parse complete JSONL records incrementally and retain a torn final line until
   it is completed.
6. Let a caller establish a graceful final byte cutoff and drain through it.
7. Use Node's filesystem primitives rather than reimplement file watching or
   adopting an off-the-shelf tail package with incompatible semantics.
8. Leave sdk.sock subscription, timeout/until, dormancy, and rollover with the
   modules that already own those concerns.

## Non-goals

- Consuming `SdkEventSubscription` or replacing `runStream`.
- Defining `tail`, `prompt`, `--timeout 0`, or `--until` behavior.
- Selecting an agent's current session or waiting for `agent.json` updates.
- Following session rollover. One follower instance follows one file.
- Watching a not-yet-created session file.
- Recovering from truncation or replacement.
- Installing the SDK's alpha `SessionStore`.
- Adding exact entry records to sdk.sock.
- Formatting entries, messages, events, or trees.
- A cursor for UUID-less entries.

## Source decision

The local session JSONL file is the entry source of truth.

The focused SDK experiment is recorded in
[session-store-entry-observation/FINDINGS.md](../derisk/session-store-entry-observation/FINDINGS.md).
`SessionStore.append()` was a strong ordered observer for the probed subprocess
writes, but:

- clauctl's direct synthetic writes bypass it;
- supplying a SessionStore participates in query resume through `load()`;
- dormant history still comes from the local file;
- snapshot/callback overlap is especially ambiguous for UUID-less entries.

Following the file observes both writers and gives the history/live cutoff in
the same byte coordinate system. SessionStore is therefore not installed.

## Duplicate UUID policy

The Claude CLI can re-persist entries already present in the file. The observed
production session contained 237 duplicated UUIDs immediately before a later
compaction. These are copies of existing history, not new canonical entries.

### Canonical and display policy: first occurrence wins

For canonical entry output:

- emit the first occurrence of each UUID;
- ignore every later occurrence carrying that UUID entirely;
- preserve every UUID-less occurrence;
- perform deduplication before applying `since`.

The same first-occurrence payload policy applies to tree/history display.
`entriesByUuid()` changes from last-wins to first-wins. `buildTree()` already
uses first-wins placement, so the displayed position and displayed payload now
come from the same occurrence. This supersedes the payload-lookup decision in
[repersisted-duplicates-handoff.md](repersisted-duplicates-handoff.md) and the
corresponding duplicate edge case in [session-tree.md](session-tree.md); their
loader-specific last-wins analysis remains valid.

This policy is intentionally simpler than the earlier
“first-position/last-content” proposal. The later copy is not demonstrably
fresher or better. In the observed session:

- 73 of the 237 duplicate pairs differed;
- 50 had changed `toolUseResult`;
- one had changed `message` data, including zeroed usage;
- two had materialized different `parentUuid` links;
- other copies were restamped or normalized.

Using the later payload can therefore degrade display data and combine content
from one occurrence with placement from another. Ignoring the copy preserves
the entry as it originally happened.

### Loader-model exception

`loadedContext()` remains last-wins internally. It models Claude's actual
load-time UUID map, not canonical output or display. Its last-wins map and
`lastIndexOf` calculations are documented loader fidelity in
[session-tree.md](session-tree.md).

This is a semantic exception, not an inconsistent entry policy:

- canonical entry producer: first occurrence;
- tree placement and payload lookup: first occurrence;
- raw session snapshot: every occurrence;
- Claude loader model: whatever Claude loads, currently last occurrence.

On the real 237-duplicate session, removing duplicate occurrences before
calling `loadedContext()` produced the same current 152-entry context as the raw
last-wins loader model. That observation supports first-wins display but does
not justify changing the loader model: another legal shape could make the
loader's result differ.

### Raw snapshots remain raw

`readSessionEntries()` and `SessionSnapshot.entries` continue to preserve the
raw append sequence, including duplicates. Tree construction, loader modeling,
set-context, and forensic inspection need the source file shape.

Consumers must choose deliberately:

- canonical entry output uses the new canonical reader/follower;
- tree structure uses `buildTree(rawEntries)`;
- tree payload lookup uses first-wins `entriesByUuid(rawEntries)`;
- loader behavior uses `loadedContext(rawEntries, ...)`.

`get-entries` therefore remains a raw snapshot command; later entry-stream
commands must not print `SessionSnapshot.entries` directly.

## Cursor semantics

A cursor is a UUID in the selected session file.

To apply `since`:

1. Scan raw entries from the beginning while recording UUIDs already seen.
2. The first occurrence equal to `since` establishes the cursor position.
3. Emit canonical entries after that position.
4. Continue suppressing every UUID already seen before or after the cursor.

This prevents a re-persisted copy of an entry before the cursor from leaking
into output. A later physical copy never creates a canonical position.

A missing cursor is an error naming the UUID and file. It never means “from the
beginning.” No entry is emitted before a supplied cursor is found, so a missing
cursor fails without partial output.

UUID-less entries after the cursor are emitted. They cannot advance a UUID
cursor, so a later invocation can replay trailing UUID-less entries if no newer
UUID-bearing entry exists. This limitation is accepted.

## Module interface

Add `src/core/session-entry-stream.ts`.

The public shape should be equivalent to:

```ts
import type { UUID } from "node:crypto";
import type { SessionEntry } from "./session-file.ts";

export interface SessionEntryFollower extends AsyncIterable<SessionEntry> {
  /** Resolves after the initial file extent has been scanned and emitted or
   *  deliberately skipped. Rejects on parse/cursor/file errors. Iteration must
   *  have started for this promise to make progress. */
  readonly historyDone: Promise<void>;

  /** Capture the current EOF, stop accepting later appends, drain complete
   *  entries through that byte, and finish iteration. Idempotent. */
  stop(): Promise<void>;
}

export function readCanonicalSessionEntries(
  filePath: string,
  since?: UUID,
): AsyncIterable<SessionEntry>;

export async function openSessionEntryFollower(
  filePath: string,
  options:
    | { readonly history: "emit"; readonly since?: UUID }
    | { readonly history: "skip" },
): Promise<SessionEntryFollower>;
```

The finite reader captures its EOF when iteration begins and never reads beyond
that extent. Its behavior is:

- without `since`, emit incrementally as complete canonical entries parse;
- with `since`, emit nothing until the cursor is found;
- if the captured extent ends without the cursor, reject without output;
- first-wins state spans the complete captured extent.

Follower ownership:

- `openSessionEntryFollower()` establishes observation and captures the initial
  extent before resolving;
- exactly one consumer iterates it;
- the caller starts iteration before awaiting `historyDone`;
- `stop()` is graceful and resolves only after the consumer has drained the
  frozen extent;
- iterator `return()` is immediate consumer cancellation: discard pending
  output and close the watcher/file handle;
- follower errors reject iteration, `historyDone` when still pending, and
  `stop()`.

`history: "emit"` is for live tail: scan from byte zero, emit canonical history,
then follow.

`history: "skip"` is for prompt observation windows: scan the initial extent to
seed the seen-UUID set and retain any torn suffix, but emit nothing from that
extent. New unique entries and UUID-less occurrences are emitted after
`historyDone`. Scanning rather than merely seeking to EOF prevents a later
re-persisted copy of old history from appearing as a new canonical entry.

Finite/history-only callers use `readCanonicalSessionEntries()`; they do not
open a follower with a hidden `follow: false` option. In particular,
`--timeout 0` remains command policy, not a file-source mode.

## Follower algorithm

The follower handles one existing append-only file. Session selection, missing
file creation, and switching to another session are caller concerns.

### Observation before snapshot

Use callback `watch()` from `node:fs` with the existing generated
`AsyncQueue` as a latched wake bridge:

1. Construct the watcher with its permanent callback before reading or statting
   the file.
2. The callback records whether any `rename` was observed and pushes one typed
   wake token into `AsyncQueue` when no token is already pending.
3. Open the file and record its file-handle identity.
4. Capture `historyEnd = fileHandle.stat().size`.
5. Read exactly `[0, historyEnd)`.

The callback remains installed continuously. If an append races the snapshot,
its token is either delivered to a parked queue consumer or retained in the
queue. Notifications are wakeups only; after each wake, inspect the file and
drain all bytes currently available.

Coalesce redundant wakes with a boolean rather than queueing one token per
filesystem event. When consuming a token, capture/reset the accumulated event
flags and clear the boolean before statting or reading. A callback arriving
during that drain then queues the next token. This is the only notification
state needed; do not recreate the first draft's generation counters,
filesystem adapter hierarchy, or lifecycle coordinator.

### Byte reading and JSONL parsing

Track a byte offset, not a JavaScript string index.

- Read appended byte ranges from the retained file handle.
- Split only on byte `0x0a` (`\n`). JSON strings cannot contain a literal
  unescaped newline, so each newline terminates one record.
- Decode and parse only complete line buffers. This naturally handles a UTF-8
  code point split across read chunks.
- Ignore blank/whitespace-only lines, matching `readSessionEntries()`.
- A complete malformed JSON line or non-object JSON value is corruption and
  rejects with `file:line` context.
- Preserve unknown fields verbatim as `SessionEntry` already does.

If the current extent ends without a newline, retain that byte suffix. Advance
the file offset past the bytes already retained; when more bytes arrive,
concatenate them to the suffix rather than rereading old bytes. Parse it only
once a newline arrives.

At a graceful final cutoff, an unterminated suffix is not an entry and is
omitted. Do not wait on a timer for it.

### Deduplication

Maintain a `Set<string>` of UUID values encountered while scanning.

- An entry with a string `uuid` not in the set: record and, if in the output
  region, emit it.
- An entry with a string `uuid` already in the set: suppress it.
- An entry without a string UUID: preserve every occurrence.

Do not add stricter entry-schema validation in this phase. Existing raw parsing
accepts any object and preserves unknown producer fields; cursor input itself is
already a UUID type. A malformed/non-string `uuid` field therefore has no stable
cursor identity and is preserved like a UUID-less occurrence rather than
silently discarded.

### Wake/drain loop

After the initial scan, stat and drain once before parking; this catches bytes
that became visible during setup even if the host coalesced their notification
with an earlier event.

Then consume wake tokens:

1. capture/reset the coalesced event flags and make the queue eligible for the
   next callback token;
2. if `rename` was observed, verify the watched path still names the retained
   file identity;
3. stat the retained file handle;
4. reject if its size is below the consumed/retained byte offset;
5. drain through the captured size;
6. repeat immediately if another token arrived during the drain, otherwise park
   on the queue.

One notification can represent any number of appends. A wake never corresponds
to one line or one write.

### Graceful stop

`stop()` establishes a source cutoff independently of consumer speed:

1. on the first call, stat the retained file handle and freeze that size as
   `finalEnd`;
2. close the filesystem watcher and cancel the internal wake queue so a parked
   consumer resumes without accepting later notifications;
3. let iteration drain exactly through `finalEnd`;
4. omit an unterminated suffix and close the file handle;
5. resolve `stop()` when iteration finishes.

An append after `finalEnd` is outside this follower. Repeated `stop()` calls
return the same promise.

The cutoff is the EOF observed by the stop operation's stat. An operating-system
write can race that stat; whichever side of the observed size it lands on
determines whether it is included. No stronger atomic relation exists between
an independent file writer and sdk.sock.

### Truncation, replacement, and watcher failure

Session files are expected to be append-only.

- If retained-handle size becomes smaller than the byte extent already
  observed, reject as truncation.
- If the watcher reports `rename`, stat the path and compare its identity with
  the retained handle. Removal or a different identity rejects as replacement.
- A watcher error, read/stat error, or unexpected EOF rejects.
- Do not restart from byte zero: that would duplicate UUID-less entries and
  conceal data loss.

After `stop()` freezes `finalEnd`, drain only the retained handle. Path changes
after that cutoff are outside the source and do not retroactively fail the
stream.

Node documents platform/filesystem caveats for `fs.watch`. clauctl supports
ordinary local session files. It does not add sleep polling to compensate for
notification mechanisms that the host filesystem does not support reliably.

## Why not an off-the-shelf tail package?

This decision was researched during owner review because byte-positioned
following is common functionality. The leading relevant npm packages were
inspected at their published versions, not rejected from descriptions alone.

### `@logdna/tail-file` 4.0.2

Strengths:

- maintained through 2024;
- typed;
- byte-positioned `Readable` with backpressure;
- keeps an old file handle through log rotation.

Rejected because:

- it polls file size on a timer (default 1000 ms; retry default 200 ms);
- polling pauses under backpressure;
- truncation and replacement restart from byte zero instead of failing;
- graceful quit performs another poll rather than exposing the exact cutoff
  contract needed by `runStream.onStop`.

The timer-driven design conflicts with this project's “await the condition, not
the clock” policy and would add latency to entry streaming.

### `tail` 2.2.6

Strengths:

- widely used and based on `fs.watch` by default;
- line splitting and from-beginning support.

Rejected because:

- its initial forced size read happens before watcher installation, leaving a
  history/follow gap;
- rename recovery waits on a one-second timer;
- truncation resets its cursor rather than failing;
- it is an old CommonJS/event-emitter interface without bundled TypeScript
  declarations.

### `tail-file-stream` 0.2.0

Strengths:

- small, typed, and maintained through 2024;
- `Readable` byte stream with explicit start offsets and `fs.watch`.

Rejected because its `_read()` first observes EOF and only then installs a
one-shot `watcher.once("change")`. An append between those operations can lose
the only wakeup and leave unread bytes parked until another append. It also does
not define the truncation/replacement failure semantics needed here.

### `tail-file` 1.4.16

Strengths:

- uses directory `fs.watch` without a normal polling interval;
- handles missing files and log rotation extensively.

Rejected because it is a large rotation/recovery module centered on character
positions, secondary log files, restart events, and starting-line search. Its
truncation/rotation behavior intentionally restarts, while a Claude session
file violation must fail. Adapting it would retain more irrelevant machinery
than the small fixed-file follower requires.

### Chokidar 5.0.0

Chokidar is a maintained cross-platform watcher, not a tail reader. It would
normalize file notifications but clauctl would still own byte offsets, reads,
torn lines, final cutoffs, and replacement policy. Its `awaitWriteFinish`
feature polls for size stability and would unnecessarily delay complete JSONL
records. Adding it does not remove the core implementation.

### Node promise-watcher probe

The initial revision proposed `fs.promises.watch()` as an intrinsically queued
source. A focused probe on Node 23.11.1 falsified that assumption: after one
`next()` resolved, an append performed while no next call was pending did not
survive for the subsequent `next()`. Its `maxQueue`/`overflow` options do not
remove the need to keep iteration continuously armed.

A carefully re-armed promise iterator could still work, but the invariant is
fragile and adds no value here. A permanent callback listener plus the existing
`AsyncQueue` states the actual requirement directly: callbacks push; one
consumer pulls; values arriving before a pull remain queued.

### Decision

Use existing Node/project primitives:

- callback `fs.watch()` supplies permanent filesystem observation;
- the already-shipped generated `AsyncQueue` latches/coalesces wakeups and
  supports parked-consumer cancellation;
- `FileHandle` supplies stable byte-positioned reads and stats;
- the clauctl-specific remainder is the JSONL parser, first-wins filter, cursor
  scan, and graceful cutoff.

This is narrower than the packages above, avoids a new dependency, and does not
implement a general log rotation or SDK lifecycle system.

## Composition with `runStream` (later specs)

This section constrains later integration so Spec 1 is not accidentally grown
back into a second lifecycle engine.

For a live entry tail:

- the command passes its `SdkSocketClient` to `runStream`;
- `onSeed` selects the seed session, opens a follower with
  `history: "emit"`, starts consuming it, and awaits `historyDone`;
- sdk.sock events arriving during history remain queued by the existing
  `AsyncQueue`;
- `onEvent` handles command conditions and, when `state.sessionId` changes,
  gracefully stops the old fixed-file follower before opening the new session
  from its beginning;
- `onStop` calls the current follower's `stop()` and awaits its consumer pump;
- `onEnd` flushes the record writer/formatter;
- the tail spec must account for `runStream`'s timeout/quiet behavior: `onStop`
  starts at source cutoff while already-queued sdk.sock events still drain, so
  follower rollover and finalization must be serialized rather than assuming no
  `onEvent` can run after `onStop` begins;
- daemon socket close remains a `runStream` outcome, not a filesystem event.

For streaming prompt entries:

- subscribe first through `runStream`;
- `onSeed` opens `history: "skip"` and awaits `historyDone` before the prompt is
  submitted;
- the prompt spec defines turn-end/queue semantics;
- `runStream.onStop` freezes and drains the follower.

For `tail --timeout 0` or a dormant/archived agent:

- call `readCanonicalSessionEntries()` on the selected latest session;
- do not open a follower merely to disable it;
- no command revives an agent for history.

The tail/prompt specs still must settle session-file selection, rollover path
resolution, missing files, daemon-close classification, and exact command
settlement. Those are intentionally absent from this fixed-file module.

## Existing code changes

### `src/core/session-file.ts`

- Keep `SessionEntry` and raw `readSessionEntries()` semantics.
- Change `entriesByUuid()` to first-wins (`set` only when absent) and update its
  comment/tests.
- Keep `appendSessionEntries()`, `readEntriesAfterStreamFlush()`, and
  `waitForEntryOnDisk()` unchanged.
- Factor shared complete-line object validation only if it makes both raw and
  incremental paths clearer; do not force the whole-file reader through the
  follower.

### `src/core/tree/loader.ts`

No behavior change. Keep and document its loader-specific last-wins exception.
Tests continue to pin loader fidelity.

### `src/core/session-entry-stream.ts`

Own only:

- finite canonical history and cursor scanning;
- one-file watch-before-read setup;
- byte offsets and torn JSONL suffixes;
- first-wins filtering;
- graceful final cutoff and immediate iterator cancellation;
- append-only violation/error handling.

It does not import sdk.sock, `AgentState`, registry, until conditions, or
`runStream`.

## Tests

Tests synchronize on watcher installation, queued wake tokens, yielded records,
`historyDone`, and `stop()` settlement. A bounded test timeout may expose a
hang; elapsed sleeps are not the coordination mechanism.

### Canonical history

- unique UUID entries preserve order and payload;
- duplicate UUID entries emit only the first payload;
- a later copy with changed parent/message/tool result is ignored;
- every UUID-less occurrence is retained in position;
- `since` starts after the first occurrence and suppresses later copies;
- UUID-less entries after `since` are emitted;
- missing `since` rejects without partial output;
- `entriesByUuid()` is first-wins;
- `buildTree(raw)` plus `entriesByUuid(raw)` uses one first occurrence for both
  placement and payload;
- `loadedContext(raw)` retains its existing last-wins tests.

### Watch-before-read and appends

- observation is armed before the initial stat/read;
- an append racing the initial scan is emitted exactly once;
- a callback token queued before the drain loop parks is not lost;
- a callback arriving during a drain queues the next coalesced wake;
- one coalesced wake drains multiple writes/lines;
- appends continue from the exact byte offset, not by rereading history;
- watcher error rejects.

### JSONL parsing

- multiple lines in one byte chunk;
- one line split across several reads;
- a multibyte UTF-8 character split across reads;
- a torn initial tail completes after a later append;
- graceful stop omits a still-torn tail;
- blank lines are ignored but line numbers remain correct;
- malformed complete JSON and non-object JSON reject with file/line context;
- unknown fields and non-string/malformed `uuid` values are preserved.

### Start modes and settlement

- `history: "emit"` emits canonical history before followed entries;
- `history: "skip"` emits no history but seeds deduplication;
- a duplicate old UUID appended after `history: "skip"` remains suppressed;
- an initially torn line under `history: "skip"` emits when completed because
  it was not yet an entry at the initial cutoff;
- `historyDone` settles only after the initial extent is processed;
- `stop()` freezes EOF, excludes a later append, drains prior complete entries,
  and is idempotent;
- stopping while consumer output is paused does not move the frozen cutoff;
- iterator `return()` cancels without requiring a graceful drain.

### File violations

- truncation below the observed byte position rejects;
- removal/replacement before stop rejects;
- path replacement after stop's frozen cutoff does not invalidate retained
  handle draining;
- unexpected EOF and read/stat failures reject.

### Integration/regression

- a real `appendSessionEntries()` synthetic write is observed;
- a live smoke test observes ordinary subprocess entries without SessionStore;
- existing session-tree, set-context, get-entries, and TUI tests pass after
  `entriesByUuid()` becomes first-wins;
- `npm run presubmit` passes.

## Success criteria

1. An append racing initial history is neither lost nor emitted twice.
2. Canonical history and live following use first-wins UUID semantics while
   preserving every UUID-less occurrence.
3. `since` cannot be bypassed by a later duplicate copy.
4. A caller can freeze EOF and await a complete final drain without involving
   sdk.sock logic.
5. Torn lines, truncation, replacement, watcher failure, and malformed complete
   lines have explicit tested behavior.
6. Tree display uses the original occurrence's placement and payload, while
   `loadedContext()` remains loader-faithful.
7. The implementation uses permanent `fs.watch` observation plus the existing
   `AsyncQueue`, rather than timer polling or a second stream driver.
8. Full presubmit passes.

## Implementation sequence

1. Change `entriesByUuid()` to first-wins and update tree/display regression
   tests.
2. Implement the pure/incremental line parser and canonical first-wins filter.
3. Implement finite history plus `since`.
4. Implement fixed-file watch-before-read following with `fs.watch()` and the
   existing `AsyncQueue`.
5. Add graceful stop/cancellation and append-only violation handling.
6. Run focused tests after each logical change, then full presubmit.
7. Run the ordinary-write and synthetic-write live smoke tests.
8. Record implementation-time decisions and verification below.

## Work log

- [x] SessionStore observation experiment completed; selected the local file as
      source of truth.
- [x] Owner review rejected the first draft's duplicate policy and duplicated
      SDK lifecycle/coordinator design (`fca061d`).
- [x] Researched five off-the-shelf tail/watch options; none supplies the needed
      no-gap, no-polling, append-only, graceful-cutoff contract.
- [x] Revised duplicate policy to first-wins for canonical output and display,
      retaining last-wins only inside the Claude loader model.
- [ ] Owner review of this revision.
- [ ] Implementation.
