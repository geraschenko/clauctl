# Canonical session-entry stream

> Status: **implemented, awaiting owner review of the implementation**;
> replaces the earlier draft of the same name.
> This is Spec 1 from
> [prompt-tail-parity-overview.md](prompt-tail-parity-overview.md). It defines
> the session-entry subscription source only. Agent lifecycle, sdk.sock
> settlement, session rollover, `--until` wiring, and command behavior belong
> to later specs and compose through the existing `runStream`.

# SPEC

## Problem

Claude session entries are newline-delimited JSON objects persisted in a local
session file. Two writers append to it: the Claude subprocess (transcript and
bookkeeping entries) and clauctl itself (synthetic compact-boundary entries for
`set-context`). The local file is the entry source of truth — sdk.sock events
cannot reconstruct entries, and the
[SessionStore experiment](../derisk/session-store-entry-observation/FINDINGS.md)
found the SDK's append hook observes only the subprocess writer and
participates in query resume.

Future `tail --type entries` / `prompt --type entries` — and, per the revised
overview direction, entry-derived message tailing — need to read history and
follow live appends from that file. Today's `readSessionEntries()` reads a
whole file; `waitForEntryOnDisk()` re-reads the entire file on every
filesystem wake. Neither can follow incrementally.

This spec adds a session-entry subscription with the same shape as the
sdk.sock subscription — a `StreamClient` driven by the existing generated
`runStream` — plus the pure canonical-filtering core shared by finite reads.

## Definitions

- **Raw entries**: the file's append sequence, verbatim, duplicates included.
  `readSessionEntries()` and `SessionSnapshot.entries` stay raw.
- **Canonical entries**: the raw sequence after first-wins UUID deduplication.
  The first occurrence of a UUID supplies both position and content; every
  later occurrence carrying that UUID is omitted; every UUID-less occurrence
  is retained in position.
- **Cursor** (`since`): a UUID identifying the retained first occurrence of an
  entry. Output starts after it. Deduplication scans from the beginning
  _before_ applying `since`, so a re-persisted copy of pre-cursor history can
  never leak into output. A cursor absent from the file is an error naming the
  UUID and file — never "from the beginning".

The Claude CLI legitimately re-persists prior entries under the same UUID
(see [cli-history-repersistence](../derisk/cli-history-repersistence/FINDINGS.md)).
In the observed production session, 73 of 237 duplicate pairs differed —
changed `toolUseResult`, zeroed usage, materialized `parentUuid` links — so
the later copy is not demonstrably fresher, and first-wins preserves the entry
as it originally happened. The one deliberate exception: `loadedContext()`
stays last-wins internally because it models Claude's actual UUID-keyed
loader, not canonical output.

## Success criteria

1. An append racing initial history capture is neither lost nor emitted twice.
2. Canonical history and live following use first-wins UUID semantics while
   preserving every UUID-less occurrence; `since` cannot be bypassed by a
   later duplicate copy; a missing cursor rejects without partial output.
3. `runStream` drives the subscription exactly as it drives sdk.sock:
   timeout, quiet, and condition-met settlement need no follower-specific
   lifecycle code.
4. `waitForEntry()` no longer re-reads the whole file per wake; live following
   costs O(new bytes) per wake.
5. Tree display uses the original occurrence's placement _and_ payload
   (`entriesByUuid` becomes first-wins); `loadedContext()` behavior is
   unchanged.
6. Torn lines, truncation, replacement, watcher failure, and malformed
   terminated lines have explicit tested behavior.
7. No timer polling: filesystem observation is event-driven (`fs.watch`), and
   tests synchronize on observable conditions, not sleeps.
8. Full presubmit passes.

## Type design

Everything that touches the session file lives behind one directory,
`src/core/session/`: `session-file.ts` moves to `session/file.ts`,
`session-seed.ts` to `session/seed.ts`, and the new subscription is
`session/entry-stream.ts`. Import-site updates are mechanical; no module
outside the directory reads or writes the file directly (tree construction
and set-context already consume entries through this layer).

The driver types are the existing generated ones:

```ts
// src/core/generated/streaming/driver.ts (existing, unchanged)
interface StreamSubscription<TEvent, TState> {
  readonly seed: TState;
  readonly events: AsyncQueue<StreamEvent<TEvent, TState>>;
}
interface StreamClient<TEvent, TState> {
  subscribe(): Promise<StreamSubscription<TEvent, TState>>;
}
```

### `src/core/session/file.ts` (moved from `src/core/session-file.ts`)

```ts
/** Incremental JSONL entry parser. Buffers a torn byte suffix (including a
 *  UTF-8 code point split across chunks) until its terminating newline
 *  arrives. Splits on 0x0a bytes only; skips blank/whitespace-only lines;
 *  throws with file:line context on a malformed terminated line or a
 *  terminated non-object value. Unknown fields pass through verbatim. */
export class SessionEntryParser {
  constructor(filePath: string);
  /** Complete entries terminated within this chunk (plus any retained
   *  suffix). */
  push(chunk: Buffer): SessionEntry[];
}

/** Unchanged signature and semantics; reimplemented over SessionEntryParser
 *  (one push of the whole file; a torn final line stays buffered and is
 *  therefore skipped). Stays sync. */
export function readSessionEntries(filePath: string): SessionEntry[];

/** CHANGED: last-wins → first-wins (set only when absent), so displayed
 *  position and displayed payload come from the same occurrence. */
export function entriesByUuid(
  entries: readonly SessionEntry[],
): Map<UUID, SessionEntry>;

// waitForEntryOnDisk and readEntriesAfterStreamFlush MOVE OUT of this module
// (see entry-stream.ts below): their reimplementations depend on the stream
// client, and the file-format module must not depend on the streaming module.
```

### `src/core/session/entry-stream.ts` (new)

```ts
import type { UUID } from "node:crypto";
import type { SessionEntry } from "./file.ts";
import type {
  StreamClient,
  StreamSubscription,
} from "../generated/streaming/driver.ts";

/** Fold state derivable from entries alone. There is deliberately no
 *  `history` field: under history:"emit" the initial extent's canonical
 *  entries are pushed as ordinary events (already queued when subscribe()
 *  resolves), so consumers handle history and live appends uniformly and no
 *  state carries an entry array. */
export interface EntryStreamState {
  /** The resumable cursor: uuid of the newest first-occurrence UUID-bearing
   *  entry at or before this state's position in the stream. In the seed
   *  that is the emission start point — undefined at file start, `since`
   *  when a cursor was given, the scanned extent's tip under
   *  history:"skip". Advanced by each emitted UUID-bearing entry. */
  readonly leaf?: UUID;
  /** Every uuid observed in the file — including occurrences suppressed from
   *  canonical output and uuids before `since`. Monotone; a live view of the
   *  client's dedup set shared by reference, not a per-event snapshot: a
   *  retained state object sees later additions. Membership tests can at
   *  worst fire a condition slightly early; acceptable because copying per
   *  event would be O(uuids) per entry. */
  readonly seenUuids: ReadonlySet<UUID>;
}

export type EntryClientOptions =
  | { readonly history: "emit"; readonly since?: UUID }
  | { readonly history: "skip" };

/** StreamClient over one existing session file. Installs fs.watch before the
 *  initial stat/read; scans [0, historyEnd) before subscribe() resolves —
 *  also under "skip", to seed first-wins dedup and retain a torn suffix —
 *  queueing the extent's canonical entries as events under "emit"; then
 *  follows appends incrementally from the retained byte offset. One event
 *  per canonical entry, paired with its post-fold state; the seed is the
 *  emission-start state. One subscribe() per client. */
export class SessionEntryClient
  implements StreamClient<SessionEntry, EntryStreamState>
{
  constructor(filePath: string, options: EntryClientOptions);
  /** Rejects on a missing/unreadable file, a malformed terminated line in
   *  the initial extent, or a `since` cursor absent from that extent (no
   *  partial output). */
  subscribe(): Promise<StreamSubscription<SessionEntry, EntryStreamState>>;
  /** Why the event queue closed, when not a clean close(): truncation,
   *  replacement, watcher/read/stat error, or a malformed terminated line
   *  during follow. undefined while healthy or after a clean close(). */
  readonly failure: Error | undefined;
  /** Release the watcher and file handle; closes the event queue. Idempotent.
   *  Commands call it in `finally`, exactly as tail closes its sdk.sock
   *  client. */
  close(): void;
}

/** First-wins + since slicing over already-read raw entries; throws when
 *  `since` is absent. The finite path for dormant agents / --timeout 0:
 *  canonicalizeEntries(readSessionEntries(path), since). Batch wrapper over
 *  the internal incremental filter the client also uses. */
export function canonicalizeEntries(
  entries: readonly SessionEntry[],
  since?: UUID,
): SessionEntry[];

/** MOVED here from session-file.ts and RENAMED from waitForEntryOnDisk (the
 *  subscription hides the disk backing, and this is a stream operation);
 *  same signature and error behavior. Implemented as runStream over a
 *  SessionEntryClient with history:"skip" — onSeed/onEvent test
 *  state.seenUuids.has(uuid); outcome "timeout" throws the existing
 *  did-not-appear error; outcome "closed" rethrows client.failure; the
 *  client is closed in `finally`.
 *
 *  Deliberately NOT merged into readEntriesAfterStreamFlush: get-messages is
 *  a wait-only consumer (it waits for the leaf flush, then delegates the
 *  read to the SDK's getSessionMessages), and a one-pass collect-until-leaf
 *  merge would change semantics — today's wait-then-read returns the whole
 *  file at read time, including entries persisted after the leaf, which
 *  stopping at the leaf uuid would drop. */
export function waitForEntry(
  filePath: string,
  uuid: UUID,
  timeoutMs?: number,
): Promise<void>;

/** MOVED here from session-file.ts, unchanged name and signature; now calls
 *  waitForEntry then readSessionEntries. */
export function readEntriesAfterStreamFlush(
  filePath: string,
  leafUuid: UUID | undefined,
): Promise<SessionEntry[]>;
```

Internal (not exported): the stateful first-wins/`since` filter
(`accept(entry): SessionEntry | undefined` plus cursor-scan state) shared by
`canonicalizeEntries` and the client's scan-and-follow loop, and the
watch/wake/read loop described under Implementation ideas.

Dependency relationships: `SessionEntryClient` uses `SessionEntryParser`, the
canonical filter, `fs.watch`, and the generated `AsyncQueue`; `waitForEntry`
uses `runStream` + `SessionEntryClient`; `readSessionEntries` uses
`SessionEntryParser`. Dependencies point one way — the stream module imports
the file module, never the reverse — and nothing here imports sdk.sock,
`AgentState`, registry, until conditions, or command code. The
`waitForEntryOnDisk`/`readEntriesAfterStreamFlush` call sites (daemon
request-handlers, set-context) update their imports to the new module.

## Data flow

Bytes → `SessionEntryParser` (complete `SessionEntry`s, torn suffix retained)
→ canonical filter (first-wins, `since`) → queue pushes paired with the
folded `{ leaf, seenUuids }` state (the initial extent's canonical entries
under history:"emit", then live appends) → `runStream` → command handler.
The finite path skips the client entirely: `readFileSync` → the same
parser → `canonicalizeEntries`. Both paths share the parser and the filter,
so canonical semantics cannot diverge.

Cutoff semantics are the driver's queue-close, identical to sdk.sock:
already-pushed entries drain; bytes not yet read at cutoff are excluded.
There is no follower-owned stat-and-drain stop — no atomic cutoff relation
exists with an independent file writer anyway, and flush-lag concerns (the
CLI writes entries ~100–180 ms after the sdk result) are solved at command
level by awaiting conditions on the entries themselves (e.g. `waitForEntry`).

## Cost

- Under history:"emit" the initial extent's canonical entries sit in the
  event queue until consumed: O(session entries) buffered, the same order of
  memory a materialized history array would cost.
- The dedup set holds every uuid for the subscription lifetime: O(uuids),
  unavoidable given re-persistence; shared (live) by reference via
  `seenUuids`.
- Per-event fold: O(1) — a small state wrapper sharing the set by reference.
- Subscribe performs one full-file scan (also under `history:"skip"`);
  following costs O(new bytes) per wake.
- Each `waitForEntry` call opens its own subscription: one full scan, then
  incremental — strictly better than today's whole-file re-read per wake.

## Edge cases

- **Torn tail at seed**: an unterminated suffix at `historyEnd` is not an
  entry; it stays buffered and, once completed by a later append, is emitted
  as a live event (also under `history:"skip"` — it was not yet an entry at
  the cutoff).
- **Duplicate uuid appended live**: suppressed, including duplicates of
  entries scanned under `history:"skip"` or before `since`.
- **`since` equals the newest uuid**: no history events; the seed's `leaf`
  is the cursor itself, so the stream stays resumable even with zero output.
- **UUID-less entries**: always emitted in position; they never advance
  `leaf`, so a session appending only UUID-less records after a cursor
  replays them on the next `since` invocation — accepted rather than adding a
  second cursor type.
- **Malformed or non-string `uuid` field**: no stricter schema validation in
  this phase; such an entry has no stable cursor identity and is preserved
  like a UUID-less occurrence.
- **Blank lines**: skipped; file line numbers in errors stay correct.
- **Malformed terminated line / terminated non-object**: corruption —
  subscribe rejects (initial extent) or `failure` + queue close (follow).
- **Truncation** (size below the observed byte extent), **replacement**
  (`rename` event whose path no longer matches the retained file identity),
  **watcher/read/stat error**: `failure` + queue close. Never restart from
  byte zero — that would duplicate UUID-less entries and conceal data loss.
- **Wake coalescing**: one notification can represent any number of appends;
  a wake never corresponds to one line or one write.

## Non-goals

- Consuming sdk.sock or replacing/altering `runStream` and `AsyncQueue`.
- Defining `tail`/`prompt` behavior, `--timeout 0`, or `--until` wiring
  (including the idle-leaf mechanism — see Implementation ideas).
- Session selection, rollover, or watching a not-yet-created file. One client
  follows one existing file.
- Recovering from truncation or replacement.
- Installing the SDK's alpha `SessionStore`; adding entry records to sdk.sock.
- Formatting entries, messages, events, or trees.
- A cursor for UUID-less entries.
- Making `readSessionEntries()` async or changing its callers' semantics
  (daemon seed, set-context, get-entries all want the raw sequence).

# IMPLEMENTATION IDEAS

## Watch/wake/read loop

Observation is installed before the first read so no append can fall between
snapshot and follow:

1. Construct the `fs.watch` callback watcher first. The callback records
   whether a `rename` was observed and pushes one wake token into an internal
   `AsyncQueue` when none is pending (a coalescing boolean — no generation
   counters, no adapter hierarchy).
2. Open the file handle and record its identity; `historyEnd = stat().size`;
   read exactly `[0, historyEnd)` through the parser/filter to build the seed.
3. After the seed, stat-and-drain once before parking — catches bytes that
   became visible during setup even if their notification coalesced with an
   earlier event.
4. Loop: consume a wake token (capture/reset flags first, so a callback
   during the drain queues the next token); on `rename`, verify path identity
   against the retained handle; stat; reject if size shrank below the
   consumed offset; read new bytes from the retained byte offset; parse,
   filter, fold, push; park when no token is pending.

Track a byte offset, never a string index. Concatenate new bytes to a
retained torn suffix rather than rereading old bytes. Notifications are
wakeups only — after each wake, drain all bytes currently available.

Pushes to a queue the driver has already closed are ignored by `AsyncQueue`;
the client keeps its resources until `close()`, which commands call in
`finally`.

## Why not an off-the-shelf tail package

Researched at published versions during the previous draft's review; retained
because the conclusion carries forward:

- `@logdna/tail-file` 4.0.2 — polls size on a timer (1000 ms default);
  truncation/replacement restart from byte zero.
- `tail` 2.2.6 — initial read precedes watcher installation (history/follow
  gap); rename recovery on a one-second timer; truncation resets the cursor.
- `tail-file-stream` 0.2.0 — `_read()` observes EOF and only then installs a
  one-shot `watcher.once("change")`; an append between those can lose the
  only wakeup.
- `tail-file` 1.4.16 — a large rotation/recovery module centered on character
  positions and restart-on-truncate; a Claude session violation must fail.
- Chokidar 5.0.0 — a watcher, not a tail reader; byte offsets, torn lines,
  and cutoff policy would remain ours; `awaitWriteFinish` polls.
- `fs.promises.watch()` — a Node 23.11.1 probe falsified its queueing: an
  append while no `next()` was pending did not survive to the next `next()`.

Callback `fs.watch` + the existing generated `AsyncQueue` states the actual
requirement directly: callbacks push, one consumer pulls, values arriving
before a pull remain queued.

## Notes for later specs (recorded here so they are not lost)

- **Messages from entries**: the overview's dual-adapter design (entry-derived
  history + event-derived live, with a handoff) is superseded in intent:
  clauctl has the session file locally, so `tail --type messages` can be the
  entry subscription plus an entry→message projection — no seam, trivial
  cursors. Sub-second file lag was judged acceptable. Transient-only facts
  remain the domain of `--type events`. The overview needs updating.
- **`--until idle` via idle-leaf**: entries alone cannot express idle, but a
  side sdk.sock subscription can record `AgentState.leaf` when activity
  reaches idle; the entry handler stops when that uuid is observed
  (`seenUuids` membership — which also covers the inverse race where the leaf
  entry hits disk before the sdk reports idle). Relies on the observed (not
  contractual) invariant that the session file lags the sdk stream; state the
  invariant where implemented. Pure command-level composition; nothing needed
  from this module.
- **`turn-end` from entries**: possibly detectable (UUID-less `result`
  records were observed in session files); verify empirically in the tail
  spec before promising it.
- **Raw (non-deduplicated) emission option**: deferred — no consumer exists
  today (`get-entries` is finite-raw, and a one-pass
  `readEntriesAfterStreamFlush` was rejected for dropping the post-leaf
  tail). The design keeps it trivially addable because dedup's two roles are
  separable: tracking (`seenUuids`, `leaf` — always on, semantics unchanged
  in a raw mode since `leaf` only ever tracks first occurrences) and
  emission filtering (canonical vs. raw), which is the only thing an option
  would flip.

## Testing approach

Tests synchronize on observable conditions — subscribe resolution, queue
pushes, `runStream` outcomes, `failure` — never elapsed sleeps; a bounded
test timeout may expose a hang.

- **Canonical semantics** (pure, via `canonicalizeEntries` and the filter):
  order/payload preservation; first-wins with changed later copies ignored;
  UUID-less retention; `since` slicing, post-cursor duplicate suppression,
  UUID-less-after-cursor emission; missing cursor throws without output;
  `entriesByUuid` first-wins; `buildTree(raw)` + `entriesByUuid(raw)` agree
  on one occurrence; `loadedContext` keeps its last-wins tests.
- **Parser**: multiple lines per chunk; one line across several pushes; a
  multibyte UTF-8 character split across pushes; torn tail completing later;
  blank lines with correct line numbers; malformed/non-object terminated
  lines throw with file:line; unknown fields and malformed `uuid` values
  preserved; `readSessionEntries` behavior unchanged over the parser.
- **Subscription**: watcher armed before initial read (append racing the
  scan emitted exactly once); `history:"emit"` queues the extent's canonical
  entries (sliced by `since`) before any live append; `history:"skip"` emits
  nothing from the extent but seeds dedup and the seed's `leaf`; seed `leaf`
  per mode (undefined / `since` / extent tip); duplicate of skipped history
  appended live stays suppressed; an initially torn line under "skip" emits
  when completed; one coalesced wake drains multiple writes; a callback
  during a drain queues the next wake; reads continue from the byte offset;
  `seenUuids` is a live monotone view.
- **Settlement and errors**: driver timeout/quiet/condition-met settle with
  no follower-specific code; `close()` idempotent; truncation, replacement,
  watcher error, and mid-follow corruption set `failure` and close the
  queue; subscribe rejects on missing file/cursor/corrupt initial extent.
- **Integration**: a real `appendSessionEntries()` synthetic write is
  observed live; `waitForEntry` resolves across the CLI flush lag and
  rejects on timeout; existing session-tree, set-context, get-entries, and
  TUI tests pass after `entriesByUuid` becomes first-wins;
  `npm run presubmit` passes.

## Implementation sequence

1. Mechanical move: `session-file.ts` → `src/core/session/file.ts`,
   `session-seed.ts` → `src/core/session/seed.ts`; update imports only.
2. `entriesByUuid` first-wins + regression tests.
3. `SessionEntryParser`; reimplement `readSessionEntries` over it.
4. Canonical filter + `canonicalizeEntries` (pure, tested first).
5. `SessionEntryClient` (watch-before-read, wake loop, fold, failure/close).
6. `waitForEntry` via `runStream`; `readEntriesAfterStreamFlush` over it;
   move/rename call sites out of file.ts.
7. Focused tests per step, then full presubmit and the live smoke test.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [x] 2026-07-29: Restarted from the earlier draft after owner review;
      re-derisked its premises. Kept: file as source of truth, first-wins
      policy and loader exception, watch-before-read, no off-the-shelf tail,
      no second lifecycle engine. Replaced: the bespoke
      `historyDone`/`stop()` follower interface with a `StreamClient`
      subscription driven by `runStream` (seed carries canonical history;
      cutoff is queue-close, stat-and-drain stop dropped); until-condition
      support moved wholesale to the tail spec (idle-leaf mechanism recorded
      above); state kept minimal (`history`, `leaf`, `seenUuids` — the
      shared-reference caveat is deliberate and documented).
- [x] 2026-07-29: Direction change recorded for the overview: live messages
      to be projected from entries (no entry/event handoff), pending an
      overview rewrite in a later session.
- [x] 2026-07-29: Critique pass moved `waitForEntry` /
      `readEntriesAfterStreamFlush` from session-file.ts to
      session-entry-stream.ts: their implementations depend on the stream
      client, and the file-format module must not depend on the streaming
      module. Deviation from the discussed layout, flagged for owner review.
- [x] 2026-07-29: Owner review round 1 (TDC comments, `95ca035`): moved all
      file-touching modules under `src/core/session/` (file.ts, seed.ts,
      entry-stream.ts); dropped `history` from `EntryStreamState` — the
      initial extent's canonical entries are emitted as ordinary events, and
      the seed's `leaf` is defined as the emission start point so a
      zero-output `since` stream stays resumable; deferred a raw-emission
      option (no current consumer; tracking/emission separability recorded);
      kept `waitForEntry` separate from `readEntriesAfterStreamFlush`
      (get-messages is a wait-only consumer; a one-pass merge would drop the
      post-leaf tail).
- [x] Owner review of this revision (approved 2026-07-29).
- [x] 2026-07-29: Implementation, following the Implementation sequence.
      Full presubmit passes (509 tests). Live smoke tests: streamed
      history:"emit" output matches canonicalizeEntries(readSessionEntries())
      on two real session files, including the one with 237 re-persisted
      duplicates from the derisk findings; on a /tmp copy, a real
      appendSessionEntries() write was observed live exactly once and
      waitForEntry resolved on it.
- [x] 2026-07-29: Owner review round 2 (TDC comments, `49af854`): converted
      `#` private fields to the `private` keyword for consistency with the
      rest of the codebase (getter-backed fields renamed: `currentLeaf`,
      `streamFailure`); `0x0a` replaced with a `NEWLINE` constant and the
      parser comment now covers CRLF (tolerated: the retained `\r` is JSON
      whitespace) and why splitting happens on bytes rather than
      `String.split`; `for (;;)` → `while (true)`; wake-queue comment now
      explains why a queue backs the single pending token.
- [ ] Owner review of the implementation.

## Implementation-Time Decisions

- **`readSessionEntries` tightened on an unterminated final line**: the old
  implementation skipped an unterminated tail only when JSON.parse failed, so
  a complete-JSON-but-unterminated final line was _included_; the parser
  buffers any unterminated suffix, so such a line is now skipped until its
  newline lands. This is the spec's "an unterminated suffix is not an entry"
  rule (both writers terminate every record in the same write, so the case is
  a mid-append read either way).
- **Wake tokens are `AsyncQueue<true>`**: the generated AsyncQueue treats a
  dequeued `undefined` as "empty", so a `void` queue cannot carry tokens.
- **`seedFromEntries` keeps its inline last-wins uuid map**: it resolves
  `loadedContext` refs, which is loader-domain (the deliberate last-wins
  exception), so it was not switched to the now-first-wins `entriesByUuid`.
