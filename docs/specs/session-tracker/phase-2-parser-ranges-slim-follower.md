# Phase 2: parser ranges + slim + follower split

> Work log for phase 2 of docs/specs/session-tracker.md (IMPLEMENTATION
> IDEAS, "Parser ranges + slim + follower split"). Status: **implemented,
> awaiting review** (2026-09-11).

## Scope

Type design sections "Slim projection", "Parser byte ranges", "Log
follower". Three deliverables under the unchanged `SessionEntryClient`
surface, no daemon changes:

1. `SessionEntryParser.push` returns `ParsedEntry {entry, range}`;
   `readEntriesAt(filePath, ranges)` (pread + parse, no whole-file
   read); `readSessionEntries` unchanged.
2. `src/core/session/slim.ts`: `SLIM_STRING_LIMIT`, `SLIM_PATHS`,
   `slimEntry`.
3. `SessionLogFollower` (fs.watch + offset + torn-suffix parser,
   synchronous delivery, `start`/`drainVisibleBytes`/`whenQuiet`/
   `whenFailed`/`close`/`failure`) extracted from `SessionEntryClient`,
   which becomes a `CanonicalEntryFilter` + `AsyncQueue` composed on it.

Stays until later phases: `waitForEntry`/`readEntriesAfterStreamFlush`
(phase 3 replaces their daemon uses with `whenSettled`) and the client's
carried-`filter` constructor parameter (`AgentObserver` rollover uses
it; `AgentObserver` is deleted in phase 4).

## Plan

1. **Byte ranges.** `LineReader` (generated from pictl) yields
   `{text, lineNumber}` only; it skips blank lines silently, so the
   caller cannot recover a line's byte offset from the texts it gets
   back. The splitter must report `{byteOffset, byteLength}` per line
   (length including the terminator); see Implementation-Time Decisions.
   `SessionEntryParser` tracks the running file offset of the bytes it
   has been fed and maps each line to `range`. `readEntriesAt`: one
   `openSync`, `readSync` per range into a buffer, parse each buffer
   through a fresh parser (a range always holds one terminated line);
   throws on a malformed line as the whole-file read does.
2. **Slim.** Path grammar over `SLIM_PATHS`: `a.b` object key, `[]`
   each array element, `**` every string beneath. One recursive walk
   per entry that rebuilds only the branches it touches (structural
   sharing elsewhere: unslimmed subtrees are the same objects), cutting
   strings over `SLIM_STRING_LIMIT` code units without splitting a
   surrogate pair; `truncated` iff any cut. Uuid-less entries returned
   as-is.
3. **Follower.** Move the watcher/fd/offset/parser/identity machinery
   out of `SessionEntryClient` verbatim, changing only: `onEntry` per
   parsed line synchronously inside the read; `onMalformedLine` + skip
   instead of throw; `whenQuiet(quietMs)` — a timer armed on every
   read that yielded bytes, resolving when it fires (the first quiet
   window); `whenFailed()`. `start()` = watch, open, scan the initial
   extent, kick the follow loop. The read error retry: a failing
   `readSync`/`fstatSync` leaves `offset` where it was and the next
   wake retries; only truncation, replacement and watcher errors fail.
4. **Client on follower.** `subscribe()` builds the follower with
   `onEntry = filter.accept → queue.push (when emitting)`,
   `onMalformedLine = fail`, `onFailure = fail`; the "skip" mode and
   the `since` cursor logic stay in the client. Existing client tests
   are the behavior guard (unchanged).
5. **Tests.** `file.test.ts`: ranges round-trip through `readEntriesAt`
   (multibyte, CRLF, blank lines, torn tail across pushes).
   `slim.test.ts`: one case per `SLIM_PATHS` shape, structural fields
   untouched, surrogate pair kept whole, uuid-less unchanged,
   `truncated` flag. `entry-stream.test.ts`: follower unit tests
   (scan + follow, malformed line skipped and reported, truncation /
   replacement fail, `whenQuiet` restarts on a drain, `whenFailed`,
   `drainVisibleBytes` after close is a no-op). Criterion 6's size
   bound measured once by a script on a real large log (the 267 MB
   taptych log), not a unit test.

## Implementation-Time Decisions

### Byte offsets come from pictl's `LineReader`

`LineReader` (generated from pictl) yields `{text, lineNumber}` and
skips blank lines silently, so a caller cannot recover a line's byte
offset from the texts it gets back; the splitter is the only place that
knows where the skipped bytes went. Anton (2026-09-11): extend pictl's
`LineReader` with `byteOffset`/`byteLength` per line and re-sync
(handoff: /tmp/line-reader-byte-ranges-handoff.md). Alternative
rejected: a second byte-aware splitter in clauctl's parser.

### Parser malformed-line contract

The follower must skip and report a malformed line while
`readSessionEntries` keeps throwing. `SessionEntryParser` takes an
optional `onMalformedLine(range, error)`; absent → throw as today.
Anton (2026-09-11): agreed.

### Read-error retry is unbounded

A failing `readSync`/`fstatSync` leaves `offset` where it was; the next
fs wake retries; no timer, no bound (a persistent read error on a file
that stops growing never surfaces). Anton (2026-09-11): acceptable —
the CLI's file does not produce read errors in practice.

### Criterion 6's 25 % bound is not a target

Measured on the 267 MB / 73.7k-entry taptych log: slim = 91 MB
(34.2 %), 37.7k entries truncated, 222 ms. The residue is the per-entry
fixed cost (~1.2 KB: `toolUseResult` stubs 14.8 MB, `message.usage`
12.8 MB, uuids/`cwd`/`slug`/timestamps/ids ~1–3 MB each, ~20 MB JSON
punctuation), not a missed bulk path. Anton (2026-09-11): the exact
ratio is not important; the point is not keeping giant tool results
resident. No further cutting; the spec's criterion 6 wording should
drop the percentage (phase-2 review item).

### `drainVisibleBytes` throws only on truncation/replacement

The spec's doc says it throws "if the read or parse fails"; that
predates the read-error retry and the parser's `onMalformedLine`
skip. A parse problem is reported and skipped; a read error is
retried; so the throw (and `whenFailed`) covers truncation,
replacement and watcher errors only. The client's wrapper still
swallows it (`failure` records it), keeping the old client surface.

### `whenQuiet` resolves on close

Otherwise a caller parked on it after `close()` would hang forever
(no bytes ever arrive). Failure is `whenFailed`'s concern.

## WORK LOG

- 2026-09-11: plan drafted; the three open questions decided (above).
  Order: slim → parser ranges → follower split.
- 2026-09-11: `slim.ts` + tests done (7 tests, typecheck green); size
  measured (decision above). pictl landed the `LineReader`
  `byteOffset`/`byteLength` fields; `node scripts/sync-from-pictl.mjs`
  run — regenerated `line-reader.ts`/`.test.ts` are in the working
  tree (uncommitted, alongside slim). Anton asked for a reusable
  measurement script: `scripts/diagnostic/slim-stats.ts` (new
  directory) — per-file totals, per entry type (count / truncated /
  bytes before → after), top residue fields of the slim output.
- 2026-09-11: parser ranges done (`ByteRange`, `ParsedEntry`,
  `SessionEntryParser(filePath, onMalformedLine?)`, `readEntriesAt`;
  spec type design updated with the constructor; 5 new/changed tests).
  `tests/sdk/stream-classification.test.ts` used the parser directly
  and now calls `readSessionEntries`. Follower split done:
  `SessionLogFollower` extracted verbatim from `SessionEntryClient`
  (plus `whenQuiet`/`whenFailed`, read-error retry, malformed skip);
  the client is filter + queue on it, `emitting` false during a "skip"
  scan; 6 follower tests, the 27 existing client tests unchanged and
  green. Criterion 6 reworded (decision above). Presubmit green.
- 2026-09-11: review round (6462b36): `slimEntry(entry, stringLimit)`
  takes the limit explicitly (`SLIM_STRING_LIMIT` stays as the daemon's
  value; `slim-stats --limit=N` overrides it); surrogate check via
  `codePointAt` > `MAX_BMP_CODE_POINT` instead of bit masks; user
  entries split into prompt / tool_result / compact_summary / meta in
  `slim-stats`; `readEntriesAt` per-range pread measured (10k ranges:
  ~24 ms pread vs ~66 ms parse; one coalesced read 13 ms) — not worth
  coalescing/sorting, noted in its doc comment.
