# Spec: entry views — readable tree/entries rows and the collapsed Bash block

> Status: **SPEC WRITTEN** (2026-09-23; derisked with Anton 2026-09-22/23).
> Follow-up to `docs/specs/tree-presentation.md` (rows, glyphs) and
> `docs/specs/format.md` (`format entries`). Attachment inventory:
> `docs/derisk/attachment-types/FINDINGS.md`.

# SPEC

## Problem

`clauctl format tree --filter all` rows for attachments, tool calls and
thinking are opaque: every attachment is `· <uuid> attachment`, every tool
call `[tool: Bash]`, every thought `[thinking]`, so a reader cannot tell
what happened without opening the entries. `format entries` has the same
gaps. In the TUI, a Bash call's header is the raw command (wrapped to two
lines) and its collapsed result shows three lines of output — the model's
own `description` of the command is never shown.

The tree's glyph and summary are produced by two parallel classification
chains (`treeRowGlyph`, `entrySummary` in `src/format/tree.ts`), and
`format entries` has a third summary switch of its own.

This spec introduces **entry views**: one classification of a session entry
yielding its glyph, one-line summary and approximate size, composed from
per-piece views (`ToolView` for tool calls, a new `AttachmentView` for
attachments). `format tree`, `/tree` and `format entries` render through
it. The TUI transcript is out of scope except for the Bash header and the
generic collapsed-result rule (both `ToolView` changes).

## Success criteria

1. `format tree --filter all` shows, for the example session in the derisk
   discussion, rows like the Examples below: attachment rows carry `⎘`,
   `<attachment.type>: <summary>`; tool-call rows carry the tool's header
   arg (`Bash: <description> — <command>`); thinking rows carry the first
   words of the thought; every row ends with a right-aligned size.
2. `/tree` shows the same labels (uuid column omitted, as today).
3. `format entries` / `tail` summaries agree with the tree's for the same
   entry (same `EntryView.summary`), with the same right-aligned size;
   tool-result lines name their tool when the call was seen earlier in the
   same stream, `tool` otherwise.
4. TUI Bash block: header `▸ Bash(<description>)` with the command on a
   second line; without a description, `▸ Bash(<command>)` as today.
   Collapsed result (all tools without a specific summary, and the local
   command block): one source line → `⤷ <line>`; more → `⤷ N lines
   (ctrl+o to expand)`. Error results render the same shape in the error
   color with `✗` in place of `⤷`.
5. `treeRowGlyph` and tree's `entrySummary` are deleted; `entries.ts` has
   no per-type summary switch; `toolViewFor` never returns undefined.
6. Suite and presubmit green; `format tree --filter all` and `format
   entries` smoke-checked on a real session file (never committed).

## Examples

`format tree --filter all --width 100` (uuids and sizes illustrative;
`…` is the width truncation):

```
⎘  909a0853 total_tokens_reminder: 14973970 tokens left                        33
●  ccd67519 [thinking] Now the code path: the pending area component and w…  1.8k
●  92f8d08f Now the code path: the pending area component and where `user…   412
▸  b1faae04 [Bash: Locate format/tree rendering code — grep -rn "attachm…   210
⤷  b2d0a7a4 Bash: ok                                                         2.3k
⎘  4206854a todo_reminder: 0 items                                             27
⎘  ef5f8c18 file: docs/derisk/attachment-types/FINDINGS.md                    6.1k
▸  af76cf8c [Read: src/format/tree.ts]                                         41
✗  99ad9136 Read: error                                                        88
⎘  bf40aee6 date_change: 2026-09-23                                            26
❯  0c1d2e3f Sorry for interrupting. Please continue.                           42
```

`format entries` (uuid, type columns as today, size right-aligned):

```
909a0853 attachment total_tokens_reminder: 14973970 tokens left            33
b1faae04 assistant  [Bash: Locate format/tree rendering code — grep -rn…  210
b2d0a7a4 user       Bash: ok                                              2.3k
```

TUI Bash block, collapsed, multi-line output:

```
▸ Bash(Locate format/tree rendering code)
     grep -rn "attachment" src --include=*.ts -l
  ⤷  14 lines (ctrl+o to expand)
```

Single-line output: `⤷  src/format/tree.ts`. Error, single line:
`✗  grep: src: No such file` in the error color.

## Definitions

- **Summary**: one line, bounded only by `maxChars` (`oneLinePrefix`),
  newlines and whitespace runs collapsed. The sink truncates to width.
- **Size**: an approximate count of the entry's model-visible characters —
  thinking text, message text, tool-call argument JSON, tool-result
  content, an attachment's text-bearing payload. Rendered as `348`, `1.2k`
  (`< 10k`, one decimal), `12k`; a 0 size shows nothing. Chars, not
  tokens; documented as approximate. Filler lines and the cursor line have
  none.
- **Piece view**: a view of one content unit — `ToolView` for a tool call
  (+ result), `AttachmentView` for an attachment payload. Piece views are
  the sharing unit between the tree and the transcript.
- **Entry view**: the entry-level composition of piece views; today glyph,
  summary and size. (Expanded rendering of an entry is a later spec — see
  Non-goals.)

## Type design

### `src/tui/glyphs.ts`

```ts
export const ATTACHMENT_GLYPH = "⎘";
/** A tool_result-only user entry with any `is_error` block. */
export const TOOL_RESULT_ERROR_GLYPH = "✗";
```

### `src/tui/tool-views/tool-view.ts`

```ts
export interface ToolHeader {
  /** The call's purpose in words (Bash `description`); absent for tools
   *  without one. */
  readonly description?: string;
  /** The one argument that identifies the call (Bash command, Read path);
   *  absent when the tool has none. */
  readonly arg?: string;
}

export interface ToolView<A> {
  displayName?: string;
  header(args: A, cwd: string | undefined): ToolHeader;
  headerLink?(args: A): string | undefined;
  /** Collapsed ⤷ text. Views wanting the generic rule delegate to
   *  `defaultToolView.resultSummary`; never undefined. */
  resultSummary(args: A, result: RenderToolResult, cwd: string | undefined): string;
  foldLabel?(count: number): string;
  resultBody?(args: A, result: RenderToolResult): string | undefined;
}

/** The collapse rule: one source line (countLines ≤ 1) → the content;
 *  else `N lines (ctrl+o to expand)`. Plain text — the hint is not dimmed
 *  (a view's summary is one string rendered uniformly). */
export function collapsedOutputSummary(content: string): string;
/** Rendering for tools without a specific view: empty header, and
 *  collapsedOutputSummary of the trimmed result content. */
export const defaultToolView: ToolView<unknown>;
export function toolViewFor(name: string): ToolView<unknown>;
```

`bashView.header` → `{ description: args.description, arg: args.command }`.
`readView.header` → `{ arg: <abbreviated path> + range }` where the range
is `:<offset>-<offset+limit-1>` (1-based `offset`, inclusive end), `:<offset>-`
with no limit, `:1-<limit>` with no offset, empty with neither; `pages`
is ignored. `write`/`edit`/`agent`/`websearch` return `{ arg }` as their
`headerArg` did. Every existing `resultSummary` branch that returned
`undefined` delegates to `defaultToolView.resultSummary(args, result, cwd)`.
`READ_ONLY_TOOLS` and `toolViews` unchanged.

### `src/tui/components/tool-execution.ts`

`ToolExecutionComponent` holds a non-optional `view`. `headerLines`: with
`header.description`, line 1 is `▸ Name(description)` (wrapped/truncated
as today) and `header.arg` follows as one line at `HEADER_CONTINUATION_INDENT`,
truncated to width with `…`; without a description, today's rendering of
`arg` (wrap ≤2 lines, OSC 8 link when applicable). `bodyLines` collapsed:
`resultBlockLines(view.resultSummary(...), width, style)` always, with
`style` = `ERROR_RESULT_BLOCK_STYLE` on an error result (`✗` and text in
error red), `RESULT_BLOCK_STYLE` otherwise (grey `⤷`, default text).
`collapsedOutputLines` and the `… +N lines` path are deleted;
`user-command.ts` renders
`resultBlockLines(collapsedOutputSummary(content), width, RESULT_BLOCK_STYLE)`.

```ts
/** How a ⤷-block is drawn: its glyph, the glyph's color, the text's. */
export interface ResultBlockStyle {
  readonly glyph: string;
  readonly glyphColor: (text: string) => string;
  readonly textColor: (text: string) => string;
}
export const RESULT_BLOCK_STYLE: ResultBlockStyle;
export const ERROR_RESULT_BLOCK_STYLE: ResultBlockStyle;
/** A ⤷-block; an undefined style draws no glyph and hangs every line at
 *  the result indent (a resultBody diff). */
export function resultBlockLines(
  text: string,
  width: number,
  style: ResultBlockStyle | undefined,
): string[];
```

### `src/tui/entry-views/` (new)

```ts
// attachment-view.ts
export interface AttachmentView<P> {
  /** Text after `<type>: `; at most maxChars + 1 chars (see oneLinePrefix). */
  summary(payload: P, maxChars: number): string;
  size(payload: P): number;
}
/** first string among `text`, `content`, else the payload JSON. */
export const defaultAttachmentView: AttachmentView<unknown>;
export const attachmentViews: Readonly<Record<string, AttachmentView<unknown>>>;
export function attachmentViewFor(type: string): AttachmentView<unknown>;
```

Specific views, one file each (`total-tokens-reminder.ts`, …), payload
types hand-written, fields read defensively (wire is untrusted):

| `attachment.type`                                                                                       | summary                                            | size                                                                  |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `total_tokens_reminder`                                                                                 | `text` with `<total_tokens>` tags stripped         | `text.length`                                                         |
| `todo_reminder`, `task_reminder`                                                                        | `N items`                                          | JSON length of `content`                                              |
| `file`, `edited_text_file`, `compact_file_reference`, `nested_memory`, `already_read_file`, `directory` | `displayPath` (fallback `filename`/`path`)         | content/snippet text length, 0 when absent (`compact_file_reference`) |
| `hook_success`                                                                                          | `<hookEvent> exit <exitCode>: <first stdout line>` | `stdout.length + stderr.length`                                       |
| `date_change`                                                                                           | `newDate`                                          | JSON length                                                           |
| `deferred_tools_delta`                                                                                  | `+<addedNames.length> -<removedNames.length>`      | sum of `addedLines[i].length`                                         |
| `skill_listing`                                                                                         | `N skills`                                         | `content.length`                                                      |

```ts
// entry-view.ts
export interface EntryView {
  readonly glyph: string;
  /** One line; `maxChars` is the sink's width — an upper bound on what it
   *  can show (the sink still truncates: it alone knows its columns). Text-
   *  bearing parts go through oneLinePrefix(text, maxChars). */
  summary(entry: SessionEntry, toolNames: ReadonlyMap<string, string>, maxChars: number): string;
  size(entry: SessionEntry): number;
}

/** oneLine's incremental form: collapses whitespace runs to one space while
 *  walking `text`, stopping once `maxChars + 1` characters are emitted (so
 *  a sink's truncateText still sees "too long" and appends `…`). Leading
 *  whitespace dropped; a trailing run dropped when the input is exhausted,
 *  but kept when its space is the `maxChars + 1`th character (the overflow
 *  sentinel). Whitespace runs are walked in full: O(maxChars + whitespace
 *  walked before the stop) — text length only matters through its
 *  whitespace. */
export function oneLinePrefix(text: string, maxChars: number): string;

/** The one classification chain, first match wins: compact boundary →
 *  compact summary → prompt (human `user` text or `queued_command`) →
 *  attachment → tool_result-only user (error glyph when any is_error) →
 *  user with text → assistant (tool-call glyph when a tool_use block) →
 *  other. */
export function entryViewFor(entry: SessionEntry): EntryView;

/** Moved here from tree.ts unchanged, with the pre-origin fallback and
 *  `isPromptEntry`; `passesFilter` (tree.ts) and the `/tree` pick
 *  resolution (tree-selector.ts) import them from here. */
export function isHumanPrompt(entry: SessionEntry): boolean;
export function isPromptEntry(entry: SessionEntry): boolean;

/** tool_use id → name over `entries`; the tree's pre-pass (moved from
 *  tree.ts, unchanged). */
export function collectToolNames(entries: readonly SessionEntry[]): Map<string, string>;

/** Streaming counterpart: records this entry's tool_use ids. The map is
 *  kept for the whole stream. */
export function trackToolNames(entry: SessionEntry, toolNames: Map<string, string>): void;
```

Summaries per view:

| view             | glyph     | summary                                                                                                                                                                                                                                                                     | size                                             |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| compact boundary | `═`       | `[compaction: Nk tokens]` / `[compaction]` (as today)                                                                                                                                                                                                                       | 0                                                |
| compact summary  | `□`       | text (as today)                                                                                                                                                                                                                                                             | text length                                      |
| prompt           | `❯`       | text / queued prompt (as today)                                                                                                                                                                                                                                             | text length                                      |
| attachment       | `⎘`       | `<type>:` + `attachmentViewFor(type).summary(payload)`                                                                                                                                                                                                                      | the attachment view's size                       |
| tool result      | `⤷` / `✗` | `<Name>: ok                                                                                                                                                                                                                                                                 | error`(as today;`tool` when unnamed)             |
| user with text   | `◌`       | text (as today)                                                                                                                                                                                                                                                             | text length                                      |
| assistant        | `▸` / `●` | parts joined by spaces: `[thinking] <thought>` per thinking block; `[<Name>: <description> — <arg>]` per tool_use (`toolViewFor(name).header(input, entry.cwd)`; omit absent parts and the `—`); text; `(stop_reason)` when abnormal and no text; `(no content)` when empty | thinking + text + tool-call `input` JSON lengths |
| other            | `·`       | `entries.ts`'s current per-type summaries (`permission-mode`, `mode`, `ai-title`, `custom-title`, `last-prompt`, `queue-operation`, `file-history-snapshot`, `file-history-delta`); else `<type>[: <subtype>]` (so `system: informational` — the tree has no type column)   | 0                                                |

`Name` in the assistant summary is `view.displayName ?? block.name`.

### `src/format/dag-lines.ts`

```ts
export interface DagRow  { …; readonly size: number | undefined; }
export interface DagLine { …; readonly size: number | undefined; }  // undefined on filler lines
/** Graph + label truncated to `width - sizeText.length - 1`, then the size
 *  right-aligned at `width` (alone, still right-aligned, once no text
 *  column remains); a sizeless or 0-size line as today. */
export function dagLineText(line: DagLine, width: number): string;
```

`dag-lines.ts` stays clauctl-import-free. The text helpers it and
`entries.ts` share live in the pictl-synced `src/format/generated/text.ts`
(upstreamed by Anton):

```ts
/** `348` / `1.2k` / `12k`. */
export function formatSize(chars: number): string;
/** `String.padEnd` counting code points. */
export function padEndCodePoints(text: string, width: number): string;
/** oneLine's incremental form, stopping after `maxChars + 1` chars. */
export function oneLinePrefix(text: string, maxChars: number): string;
```

### `src/format/tree.ts`

Deleted here: `treeRowGlyph`, `entrySummary`; moved to `entry-view.ts`:
`collectToolNames`, `isHumanPrompt`, `isPromptEntry`, the pre-origin
fallback, and the content helpers (`hasText`, `toolResultOnly`,
`abnormalStopReason`) both files need. `passesFilter` and
`formatSnapshotDocument` signatures unchanged; `treeLines` gains a trailing
`width: number` (passed as `maxChars`) and computes `entryViewFor(entry)`
once per visible row for glyph, label and size.

### `src/format/entries.ts`

```ts
export function formatEntryLine(
  entry: SessionEntry,
  options: EntryFormatOptions,
  toolNames: ReadonlyMap<string, string>,
): string;
```

Summary = `entryViewFor(entry).summary(entry, toolNames, options.width)`; size right-aligned
at `options.width` (before the `--full` JSON, which follows as today); a 0
size shows no column.
`command.ts` and `entry-sink.ts` own a `Map`, calling `formatEntryLine` then
`trackToolNames` per entry. `contentBlockMarker`, `messageSummary`,
`entrySummary` are deleted from this file.

### `src/tui/components/tree-selector.ts`

A file-private `TreeLines` (constructed from parentMap, byUuid, the
current leaf id and the tool-name map) renders the conversation-filtered
tree at `at(width)`, memoized on the last width; `render(width)` shows
`filterLines(treeLines.at(width), searchQuery)` (a pure module function)
through `showLines`, which restores the selection, only when the
width-rendered tree (by reference) or the query changed since the last
render — never on navigation. The component takes
`toolNames: ReadonlyMap<string, string>` — `SessionModel.toolNames`,
maintained by `trackToolNames` as each entry is ingested — instead of
re-collecting them per open. `dagLineText` renders the size column, in the
search view too.

### `src/tui/transcript.ts`

`toolViewFor(name)?.foldLabel?.(count)` loses the first `?.`; the tool item's
`view` is non-optional.

## Data flow

`SessionEntry` → `entryViewFor` (classification, once per entry per
consumer) → `{glyph, summary(entry, toolNames), size(entry)}`.

- Assistant summary/size fan out to `toolViewFor(name).header(input, cwd)`
  per tool_use block; attachment summary/size to
  `attachmentViewFor(type)`.
- `format tree` / `/tree`: `collectToolNames` pre-pass → `treeLines` builds
  `DagRow{glyph,label,size}` → `renderDagLines` → `dagLineText` pads.
- `format entries` / `tail`: per entry, `formatEntryLine(entry, options,
  toolNames)` then `trackToolNames(entry, toolNames)`.
- TUI Bash: `ToolExecutionComponent.headerLines` reads `view.header`;
  `bodyLines` reads `view.resultSummary` (default = collapse rule).

## Cost

- `size` is O(number of blocks/fields) per entry with no scans of string
  content: sums of string `.length`s (see the size column definitions),
  never a join of text blocks. Accepted exception: tool-call inputs and
  unknown attachment payloads JSON-stringify their non-string fields
  (`recordCharCount`), which are small in practice but are a scan of
  whatever nests inside them. No caching is needed; `/tree` computes sizes
  for its visible rows on open.
- `summary` is O(width) per entry, not O(content), for the CLI's shapes:
  text-bearing summaries (prompt, user text, compact summary, thinking,
  attachment text) go through `oneLinePrefix(text, maxChars)`, which stops
  after `maxChars + 1` emitted characters, walking whitespace runs in
  full. Accepted exceptions: message content with several text blocks is
  joined first (`extractTextContent`; the CLI writes one block per entry),
  and an unknown attachment type without a `text`/`content` field
  stringifies its whole payload. Views that must look at raw text before
  `oneLinePrefix` (hook output first line, total-tokens tag strip) bound
  it with `sourcePrefix` first.
- `/tree`: `treeLines` runs once per width change (resize), not per
  keystroke.
- `trackToolNames`: a map of every tool_use id in the stream (~40 bytes per
  call), held for the stream's life.
- Right-aligned sizes make every tree/entries line full-width (`width`
  chars); output size grows by the padding.

## Edge cases

- A tool call whose `input` is not a record: `header` returns `{}` →
  `[Bash]`.
- Assistant entries with several blocks (rare — the CLI writes one block per
  entry): parts joined by spaces, text last.
- A `queued_command` attachment is a prompt row, not an attachment row
  (unchanged).
- An attachment with an unknown type → default view; a known type with a
  malformed payload → the view's fallbacks (empty summary is allowed:
  `<type>:` is then rendered as `<type>`).
- A single very long output line stays "one line": it is shown, wrapped by
  `resultBlockLines` to as many visual lines as it takes (source-line
  rule, decided).
- Width smaller than the size column: `dagLineText` keeps the size and
  truncates the label to zero; `formatEntryLine` keeps `MIN_SUMMARY_CHARS`
  and lets the line overflow.
- A tool_result entry whose call was hidden by a filter still names its tool
  (tree pre-pass); in `format entries` a result before its call in the
  stream reads `tool: ok`.
- `/tree` search matches against the width-bounded labels: a token that
  only occurs beyond the `maxChars + 1` prefix of a row's text cannot
  match, and narrowing the terminal narrows what is searchable.

## Non-goals

- Expanded/collapsed entry rendering in `/tree` and rendering attachments in
  the transcript — later specs; this one fixes the piece/entry split they
  will build on.
- `format messages` / `format events` (`[tool:Bash command: …]`, coalesced
  runs) — unchanged.
- Token estimates; a setting to hide the size column.
- Changing `oneLine` (pictl-synced).

# IMPLEMENTATION IDEAS

- `entryViewFor` returns module-level singleton views; the summary/size
  methods take the entry, so no per-entry allocation beyond the strings.
- `header()`'s `cwd` comes from `entry.cwd` in the tree; the component
  passes its tracked cwd as today.
- `hook_success.stdout` may be absent while `content` is set; fall back.
- Size formatting: `n < 1000 → String(n)`; `n < 10000 → (n/1000).toFixed(1)
  - "k"`; else`Math.round(n/1000) + "k"`.
- Tests: `tree.test.ts` expected strings gain the size column — rewrite
  against actual output; add `entry-view.test.ts` (one case per view row and
  per attachment view), `dag-lines.test.ts` size alignment and narrow-width
  cases, `tool-execution.test.ts` Bash header with/without description and
  the collapse rule, `entries.test.ts` naming via `trackToolNames`.
- `scripts/tui-parity` captures are claude's output; the collapse rule, the
  two-line Bash header and the Read range suffix are decided divergences —
  one dated entry in `docs/specs/tui-rendering-parity.md`.
- Tool-call `size`: over `input`'s own fields, `typeof v === "string" ?
  v.length : JSON.stringify(v).length`.
- Module split to avoid registry ↔ view import cycles: views `import type`
  their interface from the registry module (`tool-view.ts`,
  `attachment-view.ts`) and take runtime helpers from leaf modules
  (`tool-views/default-tool-view.ts`, `entry-views/payload.ts`,
  `format/generated/text.ts`); the registry re-exports them.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- 2026-09-22/23 — derisk with Anton. Decisions: glyphs `⎘` / `✗`; entries
  only (transcript out of scope except Bash header + collapse rule);
  piece views (`ToolView`, `AttachmentView`) as the sharing unit, `EntryView`
  a thin composition; `ToolHeader {description?, arg?}` over a single
  string (tree needs the `—`, TUI needs two lines); sizes always shown,
  chars, computed once per entry; `format entries` names results via a
  stream-long map; collapse rule counts source lines; `oneLine` kept.
- 2026-09-23 — review round 1 (TDC): Read header carries the
  `offset`/`limit` range; cost section corrected — sizes are O(1)
  `.length` sums, nothing cached. Round 2: summaries take the sink's
  width as `maxChars` and use the incremental `oneLinePrefix` (exact
  O(width), no slack constant); `/tree` computes lines per render width.
- 2026-09-23 — Anton approved implementation.
- 2026-09-23 — implemented; suite and presubmit green; smoke on a real
  session for `format tree --filter all` and `format entries`. New tests:
  `entry-views/entry-view.test.ts`, `entry-views/attachment-view.test.ts`;
  updated `tree`, `entries`, `dag-lines`, `tool-view`, `tool-execution`,
  `tree-selector` tests (size column stripped via a digits regex where
  the row text is what is under test).
- 2026-09-23 — implementation review round 1. Cost contract: sizes are
  sums of `.length` (message text blocks summed instead of joined;
  `deferred_tools_delta` sums `addedLines`); `hook_success`,
  `date_change` and `total_tokens_reminder` bound their input before
  scanning and pass the whole composed line through `oneLinePrefix`;
  `oneLinePrefix`'s overflow-space behavior documented and tested.
  Correctness: `dagLineText` and `formatEntryLine` pad by code points
  (`padEndCodePoints`, exported from dag-lines.ts) and a width with no
  text column renders the size alone; `toolViewFor`/`attachmentViewFor`
  look up own properties only; assistant size counts a string
  `message.content`; `system` entries render `system: <subtype>` in every
  sink. Spec text aligned (Definitions, Cost, file/deferred size rows,
  `/tree` search edge case).
- 2026-09-23 — implementation review round 2. Cost section now names its
  accepted exceptions (multi-block `extractTextContent` join, unknown
  attachment payload stringify, `recordCharCount` nested JSON) and states
  `oneLinePrefix` as O(maxChars + whitespace walked). `sourcePrefix`
  (payload.ts) bounds raw text by code points without splitting a
  surrogate pair; `hook_success` and `total_tokens_reminder` use it.
  `dagLineText` right-aligns the size even when no text column remains
  (`" 348"` at width 4).
- 2026-09-24 — review round 3 (TDC, 06208c5). A 0 size shows no column in
  `dagLineText` and `formatEntryLine`. `oneLinePrefix`, `formatSize` and
  `padEndCodePoints` moved into the pictl-synced `format/generated/text.ts`
  (`entry-views/one-line-prefix.ts` deleted; Anton upstreams — the
  sync-from-pictl presubmit check fails until then). `stringList` joined
  `stringField`/`numberField` in `payload.ts`. tool-execution.ts: the
  description-form arg line uses `oneLinePrefix`; the OSC 8 guard names
  `argHasControlChars`; `wrappedHeaderLines(text, width)` derives the
  name/prefix itself and wraps `(text)` — with the `(` inside, a single
  untruncated line is provably the input unchanged, so `fitsOnOneLine`
  lost its string comparison; `resultBlockLines(text, width, style)`
  takes a `ResultBlockStyle` (`RESULT_BLOCK_STYLE` /
  `ERROR_RESULT_BLOCK_STYLE`, or undefined for the glyph-less resultBody
  block, replacing `hangingBlockLines` and `prefixed`) — a style object
  rather than the reviewed `(color, glyph)` pair because claude's normal
  block colors only the glyph while the error block colors glyph and text,
  which one color cannot express. tree-selector.ts: file-private
  `TreeLines` + pure `filterLines` + `showLines`, re-derived only when the
  width-rendered tree (by reference) or the query changes; tool names come from
  `SessionModel.toolNames` (tracked at ingestion). `deferred_tools_delta`
  summary uses an ASCII `-` (Anton's edit; test and table aligned).
  Deferred, per Anton, to docs/follow-ups/format-tui-layering.md (format/
  core depending on tui: entries.ts, command.ts, entry-sink.ts, the
  entry-views barrel/directory naming, `messageContent`/`recordBlocks`
  placement, the tree.test/tree-selector.test size-stripping helpers) and
  docs/follow-ups/api-context-view.md (file.ts summary basis).

## Implementation-Time Decisions

- Description-form Bash header: the arg line sits at the wrapped-header
  continuation indent (6) and is
  `truncateText(oneLinePrefix(arg, width - 6), width - 6)`, never wrapped,
  so the command stays one line under the description.
- `attachmentEntryView`: an attachment payload without a string `type`
  renders as type `attachment`; an empty view summary leaves the bare type
  (no trailing `:`).
- `otherView` summary: the `entries.ts` per-type summary when nonempty
  (e.g. `mode` → `normal`), else `<type>[: <subtype>]`; `system` entries
  take the fallback (`system: informational`) so the tree, which has no
  type column, names them — `format entries` accepts the small redundancy.
- Assistant tool-call part: `[Name: description — arg]` from
  `toolViewFor(name).header(input, entry.cwd)`; either half may be absent;
  `[Name]` when both are. A non-record `input` counts by its JSON length
  (`recordCharCount`).
- Attachment sizes use the payload helpers: `recordCharCount` (string
  fields by length, other fields by JSON length) for the default and
  `jsonLength` for structured fields (`todo_reminder.content`,
  `date_change`).
- `todo_reminder` / `skill_listing` pluralize (`1 item`, `4 skills`);
  `hook_success` omits the `: …` tail when both stdout and content are
  empty.
- Assistant and tool-result rows are each a pair of singleton views
  differing only in glyph (`●`/`▸`, `⤷`/`✗`) so `glyph` stays a readonly
  field.
- `/tree` selector builds its lines on first `render(width)` and rebuilds
  only when the width changes; tests render once before sending input.
