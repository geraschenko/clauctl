# Streaming conversions and formatters

> Status: **draft, awaiting owner review**.
> This is Spec 2 from
> [prompt-tail-parity-overview.md](prompt-tail-parity-overview.md). It defines
> the canonical message/control record types, the entry→message projection,
> and the incremental `format` pipeline. Command behavior for `tail` and
> `prompt` (subscriptions, `--since`/`--until`/`--timeout`, `--json` wiring)
> belongs to Specs 3–4; this spec builds every piece those commands will
> compose.

# SPEC

## Problem

`format messages`, `format events`, and `format tree` exist today as
whole-input formatters: they block until stdin closes, so they cannot sit on
the consuming end of a live pipe, and the future formatted `tail`/`prompt`
(which reuse exactly these formatters) never reach EOF at all. There is no
`format entries`, no canonical message JSONL (messages exist only as a
formatter over entries — `--json` consumers cannot see control facts like
model changes), and no cursor emission for the `tail --since` poll loop.

This spec makes the conversion graph of the overview concrete:

- **canonical message records**: bare SDK-shaped messages interleaved with
  explicitly typed `control` records, produced by one entry→message
  projection used by formatters now and by `tail`/`prompt --json` later;
- **incremental formatters**: per-record push/end drivers over the existing
  per-record rendering core, emitting output as records arrive;
- **`format entries`**: one summary line per canonical entry;
- **cursor emission**: formatted message streams end with
  `[cursor: <uuid>]`.

## Definitions

- **Entries input**: session-entry JSONL (a raw session file, or future
  `tail --type entries --json` output) _or_ the `get-entries` snapshot
  document (`{ entries: [...], leaf: ... }`). Both encodings are accepted
  wherever entries are accepted.
- **Messages input**: canonical message JSONL — one `MessageRecord` per line.
- **Events input**: tail's `{snapshot}|{event}` JSONL framing (unchanged).
- **Canonicalization**: Spec 1's first-wins uuid filter
  (`CanonicalEntryFilter`). Formatters canonicalize entries input themselves,
  so `clauctl get-entries <agent> | clauctl format entries` and
  `clauctl format entries <session-file>` produce identical output.

## Success criteria

1. `format messages`, `format entries`, and `format events` parse, convert,
   and emit record-by-record: output for a record is written before the next
   record is read, so a live pipe renders as it flows. (`format tree` remains
   the deliberate whole-input exception.)
2. One projection serves every consumer: `format messages` over entries input
   and the later `tail`/`prompt --type messages` produce records through the
   same `MessageProjector`, and formatted output through the same
   `MessageFormatter` — finite formatted output is byte-equivalent to the
   corresponding `--json` records piped through the formatter with default
   options.
3. Control facts are explicit records, not formatter inference: model and
   permission-mode changes, compaction, and queued input appear in canonical
   message JSONL and render from those records.
4. `get-entries | format entries` ≡ `format entries <session-file>` (the
   canonicalize-in-formatter invariant above).
5. A finite formatted message stream ends with `[cursor: <uuid>]` carrying
   the uuid of the last uuid-bearing record consumed — including records that
   rendered to nothing — so `tail --since` can resume after everything the
   stream observed.
6. Cross-pointing input errors are preserved: feeding one subcommand's output
   to another names the right subcommand.
7. Existing rendering behavior is preserved where not explicitly changed:
   individual SDK messages render exactly as today. `formatSdkMessage` is
   untouched; `FormatState` only loses its `lastModel`/`lastPermissionMode`
   fields, whose change tracking moves into `MessageProjector`.
8. Full presubmit passes.

## Examples

`format messages` (entries input), formatted:

```text
== user ==
Fix the torn-tail bug in the parser

== assistant ==
[tool:Read path: src/core/session/file.ts]

[Read:ok 27 lines, 812 bytes]

[model: claude-opus-5 -> claude-fable-5]

== assistant ==
Done — the suffix is now copied, not viewed.

[cursor: 0b12f9aa-4a1c-4c6e-9a02-a1b2c3d4e5f6]
```

The same stream with `--json` is one `MessageRecord` per line; the model
change is an explicit record, and there is no cursor record (natural
identities only — the uuids are on the message records):

```json
{"type":"user","uuid":"...","session_id":"...","message":{...},...}
{"type":"assistant","uuid":"...","session_id":"...","message":{...},...}
{"type":"control","control":{"kind":"model_changed","from":"claude-opus-5","to":"claude-fable-5"},"timestamp":"..."}
{"type":"assistant","uuid":"0b12f9aa-...","session_id":"...","message":{...},...}
```

`format entries`: one line per canonical entry — uuid column (the
`displayUuid` seam; full uuid today), type, one-line summary; uuid column
blank for uuid-less entries:

```text
7f3f2c9e-93d1-4b8a-b1a2-000000000001 user       Fix the torn-tail bug in the parser
7f3f2c9e-93d1-4b8a-b1a2-000000000002 assistant  [tool:Read] reading the parser
                                     queue-operation enqueue: Also update the tests
7f3f2c9e-93d1-4b8a-b1a2-000000000003 system     compact_boundary
```

## Type design

New record types use `Readonly<{...}>` type aliases (plain data records; no
`implements` or merging needed).

### `src/core/session/messages.ts` (new — the projection)

```ts
import type { UUID } from "node:crypto";
import type { SessionEntry, SessionMessageOnWire } from "./file.ts";

export type MessageControl =
  | Readonly<{ kind: "model_changed"; from: string; to: string }>
  | Readonly<{ kind: "permission_mode_changed"; from: string; to: string }>
  | Readonly<{ kind: "compaction"; trigger?: string; preTokens?: number }>
  | Readonly<{ kind: "queued_input"; text: string }>;

export type ControlRecord = Readonly<{
  type: "control";
  control: MessageControl;
  /** Source entry uuid when the control comes from a uuid-bearing entry
   *  (compaction); inferred controls (model/permission-mode changes) and
   *  queued input have none. */
  uuid?: UUID;
  /** Source entry timestamp when present. */
  timestamp?: string;
}>;

/** One line of canonical message JSONL: bare SDK-shaped messages (the type
 *  discriminant is already "user"|"assistant") interleaved with
 *  type:"control" records. */
export type MessageRecord = SessionMessageOnWire | ControlRecord;

/** Stateful entry→message projection: tracks last-seen model and permission
 *  mode to emit change controls. Input must already be canonical (first-wins
 *  deduplicated); the projector does not dedup. */
export class MessageProjector {
  /** Records projected from one entry: zero or more controls followed by at
   *  most one message. Unprojected entry kinds return []. */
  push(entry: SessionEntry): MessageRecord[];
}
```

Projection rules (exhaustive; everything else returns `[]` and is visible
only via `--type entries`):

| Entry | Projected records |
| --- | --- |
| `user`/`assistant` accepted by `entryToSessionMessage` | the message; for assistant, preceded by a `model_changed` control when `message.model` differs from the last seen model (nothing on first sighting) |
| `permission-mode` (string `permissionMode`) | `permission_mode_changed` when the mode differs from the last seen one (nothing on first sighting) |
| `system`/`compact_boundary` | `compaction` with the entry's uuid, `compactMetadata.trigger`, `compactMetadata.preTokens` (fields omitted when absent/malformed) |
| `queue-operation` with `operation === "enqueue"` and string `content` | `queued_input` with the text (dequeue emits nothing — the delivered user message follows as its own entry) |

Non-boundary `system` entries are dropped from the projection (approved:
they remain visible in entries mode; `MessageRecord` stays closed).

### `src/core/jsonl.ts` (new — extracted from `SessionEntryParser`)

```ts
export type JsonlLine = Readonly<{ text: string; lineNumber: number }>;

/** Incremental JSONL line splitter: byte-level NEWLINE splitting (a torn
 *  UTF-8 code point stays intact in the buffered suffix), torn tail buffered
 *  until its newline arrives, blank/whitespace-only lines skipped but
 *  counted. Splitting only — parsing and error wording stay with the
 *  callers, whose vocabularies deliberately differ (SessionEntryParser's
 *  `file:line: malformed session file line` Error vs format input's
 *  `invalid JSONL line N` UsageError). */
export class JsonlDecoder {
  /** Complete non-blank lines terminated within this chunk. */
  push(chunk: Buffer): JsonlLine[];
}
```

`SessionEntryParser` (`src/core/session/file.ts`) is reimplemented over
`JsonlDecoder`; its public shape, error messages, and tests are unchanged
except that the splitter mechanics move. `CanonicalEntryFilter`
(`src/core/session/entry-stream.ts`) becomes **exported** — the format
pipeline is its third consumer; no other change to Spec 1 code.

### `src/format/uuid.ts` (new — the truncation seam)

```ts
/** Every place a uuid is displayed goes through here. Returns the full uuid
 *  today; the future unique-prefix work (truncated display, prefix
 *  addressing) changes only this function and its resolver counterpart. */
export function displayUuid(uuid: string): string;
```

### `src/format/messages.ts` (reworked — incremental message formatter)

```ts
/** Incremental renderer for canonical message records. The concatenation of
 *  every push() and the final end() return value is the stream's formatted
 *  output: chunks separated by blank lines, exactly one trailing newline,
 *  cursor line last — byte-equal to formatting the same finite record
 *  sequence whole. */
export class MessageFormatter {
  constructor(options: MessageFormatOptions);
  /** The record's formatted chunk (with any separator), "" when it renders
   *  to nothing. Tracks the last uuid consumed regardless of rendering. */
  push(record: MessageRecord): string;
  /** Flush: "[cursor: <uuid>]" (via displayUuid) when any uuid-bearing
   *  record was consumed, plus final-newline bookkeeping; "" for an empty
   *  stream. */
  end(): string;
}
```

Control rendering (replacing today's formatter-inferred lines, which are
removed along with `formatSessionEntries`):

- `model_changed` → `[model: <from> -> <to>]`
- `permission_mode_changed` → `[permission-mode: <from> -> <to>]`
- `compaction` → `[compaction: <trigger>, <preTokens> preTokens]` (parts
  omitted when absent)
- `queued_input` → `[queued: <text>]` one-lined and truncated like events
  annotations

Message records render through the untouched `formatSdkMessage`; unknown
`type` values fall to its generic annotation path.

### `src/format/events.ts` (reworked — incremental event formatter)

```ts
/** Same push/end contract as MessageFormatter over TailRecord; no cursor
 *  (events carry no resumable identity), so end() is final-newline
 *  bookkeeping only. Rendering per record is unchanged from today's
 *  formatTailRecords, which it replaces. */
export class EventFormatter {
  constructor(options: MessageFormatOptions);
  push(record: TailRecord): string;
  end(): string;
}
```

### `src/format/entries.ts` (new — entry line formatter)

```ts
export type EntryFormatOptions = Readonly<{
  /** Prefix each line with the entry timestamp. */
  timestamps: boolean;
  /** Append the raw entry JSON after the summary. */
  full: boolean;
  /** Line width budget; the summary is truncated to fit. */
  width: number;
}>;

/** One line: `<displayUuid(uuid) | blank-padded> <type> <summary>`.
 *  Stateless — canonicalization happens upstream. Known bookkeeping types
 *  get concise summaries; unknown types degrade to a generic summary rather
 *  than disappearing. */
export function formatEntryLine(
  entry: SessionEntry,
  options: EntryFormatOptions,
): string;
```

`format entries` emits no cursor line: every line already shows its uuid.

### `src/format/input.ts` (reworked — streaming classification)

```ts
export type FormatInput =
  | Readonly<{ kind: "entries"; records: AsyncIterable<SessionEntry> }>
  | Readonly<{ kind: "messages"; records: AsyncIterable<MessageRecord> }>
  | Readonly<{ kind: "events"; records: AsyncIterable<TailRecord> }>
  /** No complete record before EOF; every subcommand emits nothing. */
  | Readonly<{ kind: "empty" }>;

/** Classifies the stream from its first complete record, then yields
 *  validated records lazily; a mid-stream record of the wrong shape throws a
 *  cross-pointing UsageError naming its record number. The get-entries
 *  snapshot document (finite by construction) is buffered whole and yielded
 *  as kind:"entries". */
export function decodeFormatInput(
  chunks: AsyncIterable<Buffer | string>,
): Promise<FormatInput>;

/** Chunk source: stdin (file undefined or "-") or fs.createReadStream. */
export function inputChunks(
  context: CommandContext,
  file: string | undefined,
): AsyncIterable<Buffer | string>;
```

Classification rules, applied to the first complete record:

- snapshot-shaped (`entries` array member) whole document, or a first line
  that does not parse alone (pretty-printed document): buffer all input,
  validate as the get-entries document → `entries`;
- object with `type: "control"`, or `type: "user" | "assistant"` with a
  string `session_id` → `messages`;
- object with any other string `type` → `entries`;
- object with exactly one of `snapshot`/`event` keys → `events`;
- anything else: the existing generic not-recognized UsageError.

Each subcommand states its accepted kinds and maps a mismatch to today's
cross-pointing errors (`format events` gains one for messages input).
`parseSessionSnapshot` stays whole-input for `format tree`, unchanged.
`parseSessionEntries`/`parseTailRecords` are removed (their callers become
the streaming pipeline; validation lives in `decodeFormatInput`).

### `src/format/command.ts` (reworked wiring)

- `format messages` — accepts `messages` (records straight to
  `MessageFormatter`) and `entries` (records through `CanonicalEntryFilter`
  then `MessageProjector` then `MessageFormatter`); rejects `events` with the
  existing cross-pointer. Flags unchanged.
- `format events` — accepts `events` through `EventFormatter`; rejects the
  others with cross-pointers. Flags unchanged.
- `format entries` — **new subcommand**; accepts `entries` through
  `CanonicalEntryFilter` then `formatEntryLine`; rejects the others. Flags:
  `--timestamps`, `--full`, `--width <num>` (default 120).
- `format tree` — unchanged behavior and flags (whole-input, raw entries, no
  canonicalization: `buildTree` wants every occurrence).

Dependency direction is unchanged: `src/format/` imports from `src/core/`;
core never imports format. `MessageProjector` lives in core because
`tail`/`prompt --json` must emit its records without touching format code.

## Data flow

`format` command pipeline (per record, no whole-input buffering outside the
document case):

```text
inputChunks → JsonlDecoder → decodeFormatInput (classify + validate)
  entries:  → CanonicalEntryFilter.accept → [MessageProjector.push] → formatter.push → stdout
  messages: → MessageFormatter.push → stdout
  events:   → EventFormatter.push → stdout
EOF → formatter.end() → stdout
```

Spec 3/4 reuse: `tail --type messages` feeds canonical entries from
`SessionEntryClient` through the same `MessageProjector`, then either
`JSON.stringify` per record (`--json`) or the same `MessageFormatter`
(default) — which is what makes success criterion 2's byte-equivalence hold
by construction rather than by parallel implementations.

## Cost

- `CanonicalEntryFilter` seen-uuid set: O(uuids) per stream — inherent to
  dedup, same as Spec 1.
- `FormatState` tool-name map: O(tool calls) per stream (existing cost, now
  living for the stream's whole life in a long-running pipe).
- `MessageProjector` state: O(1) (last model, last permission mode).
- Per record: O(record size); nothing rescans previous records.
- The get-entries document path buffers its whole (finite) input — the price
  of accepting a pretty-printed document on a pipe.

## Edge cases

- **Duplicate uuids in entries input**: canonicalized by the shared filter;
  a re-persisted copy never renders and never moves the cursor backward.
- **Messages input is not deduplicated**: canonical message JSONL is already
  canonical by construction; `format messages` trusts it rather than
  tracking a second uuid set.
- **Cursor after suppressed rendering**: a record that renders to "" (e.g. a
  replay-suppressed user message) still advances the cursor — it was
  consumed, so resuming after it is correct.
- **Stream with no uuid-bearing records**: `end()` emits no cursor; output
  is whatever rendered (possibly empty, then no trailing newline).
- **Controls at first sighting**: `model_changed`/`permission_mode_changed`
  are change records — nothing is emitted for the first observed value, so a
  `--since` window that sees no change sees no control (same as today's
  inferred lines).
- **Malformed `compactMetadata`**: the `compaction` control is still emitted
  with whatever fields validate; the boundary fact is never dropped.
- **Empty input** (or blank lines only): kind `"empty"`; every streaming
  subcommand writes nothing and exits 0 (today's behavior for empty JSONL).
  `format tree` keeps its whole-input path and existing not-a-snapshot
  error.
- **Blank input lines**: skipped but counted (JsonlDecoder), so record
  numbers in errors match the file.
- **CRLF input**: tolerated as in Spec 1 (the retained `\r` is JSON
  whitespace).
- **Torn final line on stdin EOF**: not a record; dropped exactly as Spec 1
  drops an unterminated file suffix.
- **Unknown message `type` on messages input**: rendered via
  `formatSdkMessage`'s generic annotation; unknown entry `type` on entries
  input projects to `[]` (messages mode) or a generic summary line (entries
  mode).

## Non-goals

- Changing `tail`/`query` command behavior or flags (Specs 3–4).
- A cursor record in JSONL output (natural identities only, per overview).
- An event→message adapter (clauctl messages come from entries only).
- Uuid prefix addressing or truncated uuid display — `displayUuid` is the
  seam, full uuid today.
- Changing `format tree` layout, filters, or its whole-input buffering.
- Changing `formatSdkMessage` rendering or the TUI render helpers.
- Schema validation of entry payloads beyond what projection/rendering
  touches.
- pictl changes (Spec 5).

# IMPLEMENTATION IDEAS

## Separator mechanics

The push/end contract deliberately specifies only the concatenation
invariant. The natural implementation: the formatter tracks whether any
chunk was emitted; `push` returns `chunk` for the first and `"\n\n" + chunk`
for subsequent chunks; `end` returns `"\n\n[cursor: …]\n"` / `"\n"` /
`""` as applicable. Byte-equivalence tests pin the invariant, not the
mechanism.

## decodeFormatInput shape

An async generator per kind keeps validation co-located with iteration:
classify eagerly (await the first record before returning `FormatInput`, so
a wrong-input error fires before the command starts writing), then yield the
first record and subsequent validated records. Document mode: if the first
line fails to parse alone, keep accumulating; on EOF parse the whole text as
the snapshot document (reusing `parseSessionSnapshot`'s validation of the
`entries` array; `leaf` is irrelevant here and ignored). A one-line minified
`{"entries":[...]}` parses as a JSONL record but is snapshot-shaped —
routed to document handling, preserving today's cross-pointer behavior for
`format events`.

## Command driver

The three streaming subcommands share one small driver: resolve
`FormatInput`, check the accepted-kind map (cross-pointing UsageError
otherwise), then `for await` records through the pipeline writing each
chunk. Backpressure: `stdout.write` return values are ignored today
(existing behavior); revisit only if a real pipe consumer proves slow.

## Entry summaries

`formatEntryLine` known types, first pass: `user`/`assistant` (one-lined
text, `[thinking]`/`[tool:name]` markers like pictl's `rawMessageSummary`),
`system` (subtype), `queue-operation` (`enqueue: <text>` / `dequeue`),
`permission-mode`, `mode`, `ai-title`/`custom-title`, `last-prompt`,
`attachment`, `file-history-snapshot`/`file-history-delta` (counts only).
Unknown: `summarizeUnknown` of the whole entry. The overview's non-goal
stands: not every type needs a bespoke summary; the generic path is the
contract.

Type column padding: pad to the longest common short types (10) and let
long bookkeeping names overflow their column — alignment is a nicety, not a
contract.

## Testing approach

- **Projector** (pure): per-rule tests — model change emitted only on
  change; permission-mode first sighting silent; compaction with/without
  metadata; enqueue text/dequeue silence; drop rules (`attachment`, `mode`,
  non-boundary `system`, meta/sidechain user).
- **JsonlDecoder**: the existing SessionEntryParser splitting tests move
  down (torn UTF-8, blank-line counting, line numbering);
  SessionEntryParser keeps its parse/object-validation tests (including the
  file:line error wording) over the decoder.
- **MessageFormatter**: concatenated incremental output ≡ whole-sequence
  output; cursor equals last consumed uuid including render-dropped records;
  empty stream → ""; control rendering matches the removed inferred lines.
- **Byte-equivalence**: entries fixture → (filter → projector → JSONL) piped
  through `format messages` ≡ direct formatted output.
- **Invariant 4**: get-entries document and raw JSONL of the same session
  produce identical `format entries` output (fixture with duplicates).
- **Streaming**: a chunk-at-a-time feed emits each record's chunk before the
  next chunk is pushed (drive decoder/formatter directly; no timers).
- **Classification**: each cross-pointing error per subcommand; mid-stream
  wrong-shape record names its record number; minified snapshot document.
- **Presubmit** (rerun once for the treefmt quirk).

## Implementation sequence

1. `JsonlDecoder` extraction; `SessionEntryParser` over it (tests green,
   no behavior change).
2. Export `CanonicalEntryFilter`.
3. `MessageProjector` + record types (pure, tested first).
4. `displayUuid`; `MessageFormatter` (rendering moved from
   `formatSessionEntries` + new control renderers); `EventFormatter`.
5. `formatEntryLine`.
6. `decodeFormatInput` / `inputChunks`; rework `command.ts` wiring; add
   `format entries` subcommand; remove the superseded whole-input functions.
7. Full presubmit; live smoke: `format messages` on a real session file, a
   chunked pipe, and the invariant-4 comparison on the duplicate-heavy file.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [x] 2026-07-29: Derisked with owner. Decisions: framing (b) — bare
      SDK-shaped message lines with interleaved `type:"control"` records;
      controls produced by the projection, not formatter inference; control
      vocabulary model_changed / permission_mode_changed / compaction /
      queued_input; formatters canonicalize entries input (invariant:
      `get-entries | format entries` ≡ `format entries <file>`); non-boundary
      system entries dropped from projection; `JsonlDecoder` extracted from
      SessionEntryParser; `format messages` accepts entries input including
      the get-entries document; `displayUuid` as the future
      truncation/prefix-addressing seam (full uuid today); `Readonly<{...}>`
      style for the new record types.
- [ ] Owner review of this draft.
