# Spec: tree presentation — renderdag rendering of the session tree

> Status: **IMPLEMENTED** (2026-09-02; suite + presubmit green; awaiting Anton's review and commit)
> (2026-09-02). Phase A of the tree-presentation effort; phases B
> (explicit-playlist boundary display) and C (`set-context --rewind-to X
> <uuids…>`) are specced in `docs/specs/context-tree.md` (written; its
> review proceeds in parallel). Supersedes the layout half of `docs/specs/format-tree.md`
> and `docs/specs/flat-tree-sync-handoff.md`. Sources:
> `docs/thoughts/tree-presentation.md`, `docs/session-views.md`,
> `docs/specs/session-tree.md` (display rules 1–4).

# SPEC

## Problem

`clauctl format tree` and the TUI `/tree` picker render the session tree
with the pictl-derived indented layout (`src/format/generated/tree-layout.ts`):
depth-first, active branch first, one extra indent level per fork. Forks
push rows to the right, sibling branches are separated by whole subtrees
rather than interleaved in time, and the parallel-tool-call shapes that
motivated the complaint (`docs/thoughts/tree-presentation.md`) are already
linearized by display rule 4 — what remains wrong is fork presentation.

Replace the layout with a git-log-style DAG rendering
(`@geraschenko/renderdag`): rows in strict chronological (file) order,
one glyph column per concurrently open branch, the active chain in
column 0. The old layout is removed entirely, for `format tree` (every
filter, including `raw`) and `/tree`.

## Success criteria

1. `format tree` rows appear in `parentMap` iteration order (raw entries at
   file position; relinked block rows right after their anchor row — see
   the buildTree change below). No filter mode reorders rows.
2. The active chain (current leaf → root, over the visible relation) is
   rendered in column 0 on every row it occupies, and no other row is —
   including when the active root is not the file's first root: after the
   leaf row, column 0 stays empty to the end (a leaf with children gets
   renderdag's `~` terminator under it). No leaf marker. A leaf that is
   not itself a visible row (hidden by the display tree or by the filter)
   ends the chain at its nearest visible ancestor.
3. `/tree` shows exactly the lines of `format tree --filter picker` with
   uuids omitted; connector-only lines are not selectable and navigation
   skips them.
4. `src/format/generated/tree-layout.ts`, `flat-tree.ts`, `flat-tree.test.ts`
   are deleted and dropped from `scripts/sync-from-pictl.mjs`; nothing
   imports them.
5. The renderdag layer (`src/format/dag-lines.ts`) imports nothing from
   clauctl, so pictl can adopt it later (the port itself is a non-goal).
6. Suite green; `format tree --filter raw` on a native file with an up_to
   compaction shows the relinked block connected under its summary row.

## Examples

Fork with the active leaf on the later branch (`1 → 2`, `1 → 3 → 4*`),
`--filter conversation`, uuid column shortened to the 8-char prefix:

```
❯    00000001 Start
├─╮
│ ●  00000002 First branch
❯    00000003 Second branch
●    00000004 active leaf
[cursor: 00000004-…]
```

Exact connector geometry is renderdag's; tests pin renderdag's actual
output. This sketch fixes the requirements: chronological order, active
chain in column 0, link line `├─╮` as a non-selectable filler line.

The same tree with the leaf rewound to `1` (which has children): the
active chain ends at `1`, column 0 is reserved below it, both branches
move right:

```
❯      00000001 Start
├─┬─╮
│ │ │
~ │ │
  │ │
  ● │  00000002 First branch
    ❯  00000003 Second branch
    ●  00000004 active leaf
[cursor: 00000001-…]
```

(A finished column — `2` has no children — is not continued below its
row; renderdag leaves it blank.)

A compacted session (`1 2 3 4`, boundary `B` preserving `[3,4]` with up_to
summary `S`, then `5`) in `conversation` mode renders as one straight
column: `1 2 3 4 ═B □S 5`. In `raw` mode the block appears right after `S`:
`1 2 3 4 ═B □S ~3 ~4 5` with `~3` under `S`, `~4` under `~3`, `5` under `~4`
(the file's `4` keeps its raw place under `3`, ending that column).
`format tree` marks relinked rows with `~` before the uuid; `/tree` (no
uuid column) dims the glyph instead.

Glyphs are the transcript's gutter glyphs, so a reader who knows the TUI
reads the tree without a legend: `❯` user text, `●` assistant text, `▸`
assistant entry containing a `tool_use` block (it "plays" the command), `⤷`
tool_result-only user entry; plus tree-only `═` compact boundary, `□`
compact summary, `·` anything else (attachment, system, unknown). The
transcript currently draws tool calls as `●` and results as `⎿` (Claude
Code parity); switching it to `▸`/`⤷` is an intentional parity break, done
as the follow-up in Non-goals.

Labels: `entrySummary` drops its `user:` / `assistant:` / `compaction:`
prefixes (the glyph carries the kind); the boundary's `[compaction: Nk
tokens]` and the tool result's `<tool>: ok|error` stay.

## Type design

### Dependency

`package.json` dependencies: `"@geraschenko/renderdag": "^0.1.1"`.

### `src/tui/glyphs.ts` (new)

The one glyph vocabulary, next to `READ_ONLY_TOOLS` (`format → tui` is an
established dependency direction). Every glyph is exactly one terminal
column — renderdag places it in a fixed grid. The clauctl-independent files
(`dag-lines.ts`, `parent-map.ts`) must not import this: pictl will render
its own glyph set through the same layer.

```ts
/** Transcript gutter glyphs, shared with the TUI components (follow-up). */
export const USER_GLYPH = "❯";
export const ASSISTANT_GLYPH = "●";
export const TOOL_CALL_GLYPH = "▸";
export const TOOL_RESULT_GLYPH = "⤷";
/** Tree-only. */
export const COMPACT_BOUNDARY_GLYPH = "═";
export const COMPACT_SUMMARY_GLYPH = "□";
export const OTHER_ENTRY_GLYPH = "·";
```

### `src/format/dag-lines.ts` — generic DAG-to-lines layer (new)

No clauctl imports: only `@geraschenko/renderdag` and `truncateText` from
`./generated/text.ts` (which pictl also has). It builds its own children
lists from `DagRow.parentId` rather than importing `treeChildren`.

```ts
export interface DagRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly glyph: string;
  readonly label: string;
}

/** One output line. `rowId` is set on the line carrying a row's glyph and
 *  label; undefined on connector/separator lines (filler), whose whole
 *  text is `prefix`. The glyph is split out so a sink can style it (the
 *  TUI dims it on relinked rows). */
export interface DagLine {
  readonly rowId: string | undefined;
  /** Graph columns before the glyph. */
  readonly prefix: string;
  /** "" on filler lines. */
  readonly glyph: string;
  /** Graph columns after the glyph, through the trailing space; "" on
   *  filler lines. */
  readonly suffix: string;
  /** "" on filler lines. */
  readonly label: string;
}

/** Lines in row order. Preconditions (throw otherwise): every row's
 *  parent precedes it; `leafId`, when non-null, is a row id. The active
 *  chain is `leafId` and its ancestors; its root is `reserve`d before any
 *  row is fed, so it takes column 0 even when an earlier root exists;
 *  among a row's children, the one on the chain is fed first, so renderdag
 *  keeps it in the parent's column; the chain's last member (`leafId`) is
 *  fed with an anonymous ancestor ahead of its children when it has any,
 *  and a never-fed sentinel column is reserved right after its row, so
 *  column 0 stays empty below it. The 'node' prefix line becomes the row's
 *  line, every other non-repeatable prefix line a filler line. */
export function renderDagLines(
  rows: readonly DagRow[],
  leafId: string | null,
): DagLine[];

/** prefix + glyph + suffix + label truncated to `width` (truncateText),
 *  trailing whitespace trimmed. */
export function dagLineText(line: DagLine, width: number): string;
```

### `src/core/tree/build-tree.ts` — materialization order change

`buildTree` signature unchanged. A valid non-empty boundary's relinked block
is materialized immediately after its anchor row: at the boundary's own
position when the anchor is the boundary (from-shape), right after the
anchor entry's raw row when the anchor arrives later (up_to summary), at
end of file when the anchor never arrives (its rows become roots, reported
as today). The parent relation is unchanged; only iteration order moves.
Consequence: every `ParentMap` from `buildTree` (and `toDisplayTree`, which
iterates it) lists each row after its parent.

### `src/core/tree/parent-map.ts` (new)

Portable tree primitives — no clauctl imports, so pictl can adopt the
file verbatim. Holds `ParentMap` (today re-exported by `core/tree/nodes.ts`
from `format/generated/flat-tree.ts`; `nodes.ts` re-exports it from here
instead) and `treeChildren` (moved from `nodes.ts`; it is a pure ParentMap
operation; its callers — `tree.ts`, `tree-selector.ts`, `nodes.test.ts` —
import it from here, no re-export):

```ts
/** Child id → parent id (null = root). Iteration order = materialization
 *  order; a row always follows its parent. */
export type ParentMap = ReadonlyMap<string, string | null>;
```

### `src/format/tree.ts`

Unchanged: `FILTER_MODES`, `FilterMode`, `TreeFormatOptions`, `passesFilter`,
`collectToolNames`, `entrySummary`, `collectFinalAssistantIds`,
`formatSessionSnapshot`'s signature. Deleted: `formatTreeNodeLine`. Added:

```ts
/** Classifies the entry into the glyphs.ts vocabulary, first match wins:
 *  compact boundary, compact summary, user with text, tool_result-only
 *  user, assistant with a tool_use block, other assistant, anything else.
 *  Lives here (not in glyphs.ts) because it is entry classification,
 *  sharing hasText/toolResultOnly with passesFilter. */
export function treeRowGlyph(entry: SessionEntry): string;

/** The one rendering shared by `format tree` and `/tree`: the rows of
 *  `parentMap` passing `passes`, in parentMap order, hidden rows' children
 *  re-attached to their nearest visible ancestor (memoized walk); the
 *  active chain = the leaf's row → root over that visible relation, where
 *  the leaf's row is currentLeafId itself when it passes, else its nearest
 *  visible ancestor (null → no chain). Labels: the 8-char uuid prefix
 *  (`~`-prefixed on relinked ids) unless omitUuid, then entrySummary.
 *  Calls renderDagLines(rows, leafRow); the chain itself is derived
 *  there. */
export function treeLines(
  parentMap: ParentMap,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
  currentLeafId: string | null,
  passes: (id: string, entry: SessionEntry) => boolean,
  toolNames: ReadonlyMap<string, string>,
  omitUuid: boolean,
): DagLine[];
```

`entrySummary`: user/summary/assistant text no longer prefixed with
`user:` / `compaction:` / `assistant:`.

`formatSessionSnapshot`: `raw` → `buildTree` output, else
`toDisplayTree(fullTree, entries).parentMap` with the leaf mapped through
`nearestVisibleRow` (as today); `passes` = `passesFilter(entry, isLeaf,
finalIds.has(id), filter)`; output = `treeLines(...).map(line =>
dagLineText(line, width))` + `[cursor: <leaf uuid|null>]`.

### `src/tui/components/tree-selector.ts`

`resolveTreePick`, `TreePickAction`, the constructor signature and the
public `setWarning`/`render`/`handleInput` surface are unchanged. Internals:

```ts
const MAX_VISIBLE_LINES = 15;           // was MAX_VISIBLE_ROWS
private readonly treeLines: DagLine[];  // computed once in the constructor
private lines: DagLine[] = [];          // what is shown: treeLines, or the search matches
private selectedLine = 0;               // index into lines; always a line with rowId
```

The constructor computes `treeLines(parentMap, byUuid, currentLeafId,
passes, toolNames, true)` once, with `passes` = the picker filter. Search
does not re-render: `applyFilter` sets `lines` to `treeLines` when the
query is empty, else to the lines with a `rowId` whose label contains
every search token — a flat list, rendered without connectors as
`glyph + " " + label`. Up/down move to the previous/next line with a
`rowId`, stopping at the ends (no wrap-around); page up/down move by
`MAX_VISIBLE_LINES` lines, clamp, then snap to the nearest selectable line
in the direction of travel (the opposite direction when none lies beyond). `render` shows a
`MAX_VISIBLE_LINES` window (`dagLineText(line, width)` in tree view), the
selected line inverted, the glyph dimmed when `rowId` contains `@`.
Confirm → `parseTreeNodeRef(lines[selectedLine].rowId)`.
`nearestVisibleIndex(id)` finds the line whose `rowId` is `id`, else walks
`parentMap` upward, else clamps.

### Deletions

`src/format/generated/tree-layout.ts`, `flat-tree.ts`, `flat-tree.test.ts`;
their entries in `scripts/sync-from-pictl.mjs`. `docs/specs/format-tree.md`
and `docs/specs/flat-tree-sync-handoff.md` get a status note pointing here.

## Data flow

`SessionSnapshot` → `buildTree` → (`toDisplayTree` unless `raw`) →
`treeLines`: visible relation (filter + nearest-visible-ancestor) →
`DagRow[]` + leaf row → `renderDagLines` (active chain = leaf → root;
children lists in row order, active-chain child first; renderdag row by
row) → `DagLine[]` → the sink
truncates to width (`format tree` once; `/tree` on every render at the
current width).

## Cost

- `renderDagLines`: renderdag is O(rows × open columns) — columns = branches
  concurrently open at that row, small in practice. Memory O(lines).
- `treeLines`: O(rows) with the memoized nearest-visible-ancestor walk.
- `/tree`: `treeLines` once per open; a search keystroke is one O(lines)
  label scan.

## Edge cases

- Consecutive roots may get a blank renderdag separator line — rendered as
  a filler line.
- A leaf with children (rewound mid-branch): see the second example — 4
  filler lines under the leaf (`├─┬─╮`, pad, `~` terminator, pad), the
  children shifted right.
- A leaf that is not a visible row — a relinked occurrence in display
  mode (mapped through `nearestVisibleRow` before `treeLines`), or a row
  the filter rejects (`user-only` with an assistant leaf; resolved inside
  `treeLines`) — ends the active chain at its nearest visible ancestor,
  which gets the column-0 reservation. A rootless hidden chain yields no
  chain at all (no row in column 0).
- Multiple roots (a `newRoot` pick creates one): the active root is
  `reserve`d first, so it is column 0 even when it is not the first row;
  other roots take later columns.
- A row preceding its parent in a `toDisplayTree` map is impossible from
  CLI-written files (rule 4's outside-child reparent could produce it only
  if a group result were written after the next turn, and the CLI does
  not start a turn until every call resolves); `renderDagLines` throws,
  crashing `format tree` on such a hand-crafted file by design.
- `/tree` with zero selectable lines shows "(no matching entries)" and
  ignores confirm, as today.

## Non-goals

- `/tree` filter cycling (ctrl+o, pi-style) — own follow-up.
- Showing the compaction summary text in the TUI — next spec.
- Porting this renderer into pictl (`pictl format tree` parity) — later;
  this spec only keeps `dag-lines.ts` free of clauctl imports.
- `toContextTree` and any change to `toDisplayTree` — phase B
  (`docs/specs/context-tree.md`), which rewires the data flow to
  full → context → display.
- **Follow-up (required, separate commit): TUI glyph unification** — point
  `tool-execution.ts` (tool `●` → `TOOL_CALL_GLYPH`, `⎿` prefix →
  `TOOL_RESULT_GLYPH`), `user-command.ts`, `user-message.ts`, and
  `assistant-message.ts` at `src/tui/glyphs.ts`, update their parity
  comments and transcript tests. Until then the tree shows `▸`/`⤷` where
  the transcript shows `●`/`⎿`.

# IMPLEMENTATION IDEAS

- renderdag API (`@geraschenko/renderdag` 0.1.1, local checkout
  `~/git/geraschenko/renderdag-ts`). `GraphTextRenderer.nextPrefixLines`
  does not expose `GraphRowShape.separatorLine` (only `writeNextText`
  consumes it), so drive the stages directly: `new pipeline.GraphRowShaper()`
  with `optionsMut().minRowHeight = 1`, `nextRowShape(node, parents)` →
  `separatorLine` + `new pipeline.BoxDrawing().nextPrefixLines(rowShape)`
  → `PrefixLine[]` (`{kind, parts}`; parts `{type:'text', text}` or
  `{type:'nodeGlyph'}`). Mirror `PrefixLinesToText.writeNextText` for a
  one-line message: a blank filler line when `separatorLine`, skip
  repeatable kinds (`isRepeatable`), render the rest; the `'node'` line
  gets the label. Decided (Anton): no renderdag change — only public
  pipeline stages are used, and the mirrored logic is one condition
  ("blank line iff separatorLine and the previous row rendered exactly one
  line").
- Column inheritance: in `graph_to_row_shape.nextRowShape`, the node's
  column is emptied and each parent takes `columnsFindEmpty(columns,
  column)` in feed order, so the first-fed child inherits the column.
  `reserve()` pins one column per node — not usable for a chain.
- Reserving column 0 below the leaf: the leaf's column is emptied inside
  the same `nextRowShape` call that places its children, so `reserve()`
  alone cannot hold it. `Ancestor.anonymous()` fed first takes column 0 as
  a `blocked` column (drawn as the `~` term line) which `columnsReset`
  turns back to `empty` at the end of the call; `reserve("\0reserved")`
  immediately after then takes column 0 (`columnsFirstEmpty`) and, never
  being fed, holds it (reserved columns render blank and are never
  reused). Verified in `/tmp/renderdag-proto/proto4.ts`.
- Prototype (throwaway, `/tmp/renderdag-proto/proto3.ts`, `proto4.ts`): ~60 lines,
  verified on `~/.claude/projects/-home-anton/0d1e619f-…jsonl` (4
  boundaries) with a forced leaf on the non-default branch → active chain
  in column 0. Never commit session files.
- `buildTree` block deferral: when a boundary's anchor is a later entry,
  hold the block in a `pendingBlockByAnchor: Map<UUID, [key, parent][]>`
  and flush it right after that raw row is set; flush leftovers at the end
  before the dangling-parent pass.
- Tests: rewrite every expected string in `src/format/tree.test.ts` and the
  selector tests against renderdag output; `build-tree.test.ts` and
  `display-tree.test.ts` assert `[...tree]` in order, so up_to fixtures
  there change order too; add `dag-lines.test.ts`
  (active-first ordering, filler lines, parent-before-child precondition,
  width truncation) and a `buildTree` test for the block-after-anchor
  order.
- Node here is v23.11; run `.ts` scripts with `--experimental-strip-types`.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Add renderdag dependency
- [x] `src/tui/glyphs.ts`
- [x] `dag-lines.ts` + tests (incl. active root reserve, hidden-leaf chain)
- [x] `buildTree` block-after-anchor order + test
- [x] `src/core/tree/parent-map.ts`; delete generated layout files; sync script
- [x] `tree.ts`: `treeRowGlyph`, `treeLines`, `formatSessionSnapshot`; rewrite tests
- [x] `tree-selector.ts` on `DagLine[]`; rewrite tests
- [x] Suite green (604), presubmit green; smoke on 0d1e619f (4 from-shape
      boundaries) in raw and conversation mode — chain in column 0, blocks
      under their boundaries; criterion 6 verified on 04deccac (up_to
      185k-token compaction: block connected under its `□` summary row)
- [ ] Follow-up commit: TUI glyph unification (see Non-goals)
- [x] Status notes in format-tree.md / flat-tree-sync-handoff.md
- [ ] Measure `/tree` keystroke latency on a large session

2026-09-02 — derisk: scope/phasing, the semantic definition of display
branching, and the phase B/C design state were recorded here across a
compaction and moved to `docs/specs/context-tree.md`. Decisions specific to
this phase: active chain via child ordering (not `reserve`); block rows
materialized after their anchor (fixes raw-mode forward references at the
source); both leaf markers dropped.

2026-09-02 — review round 1 (9d74224): leaf marker replaced by reserving
column 0 below the leaf (anonymous terminator + sentinel reserve); glyph
set revised (□ summary, ▹ tool call); `entrySummary` kind prefixes
dropped; `/tree` search is a flat glyph+label list over lines computed
once; `DagLine` splits out the glyph for TUI dimming; `ParentMap` and
`treeChildren` move to portable `src/tree/parent-map.ts`; separatorLine
workaround kept (no renderdag change).

2026-09-02 — review round 2 (pre-implementation read-through): active root
`reserve`d so multi-root files keep the chain in column 0; filter-hidden
leaf ends the chain at its nearest visible ancestor; parent-before-child
violation in display maps declared impossible from CLI files → throw;
`parent-map.ts` under `src/core/tree/`; glyphs unified with the TUI
transcript (`❯ ● ▸ ⤷`) via new `src/tui/glyphs.ts`, TUI component switch
deferred to a required follow-up (intentional Claude Code parity break);
page up/down snap direction fallback.

## Implementation-Time Decisions

- **`treeLines` resolves nearest visible ancestors in one forward pass**,
  not a memoized upward walk: because a row always follows its parent,
  the parent's answer is already known when the child arrives. The
  invariant is checked there (throw), so a violation surfaces before
  `renderDagLines` rather than silently rooting the row.
- **`dag-lines.ts` mirrors renderdag's text stage, including the queued
  pad line**: `PrefixLinesToText` queues one repeatable pad line after a
  row with a terminator and flushes it at the next row. We emit it
  immediately as a filler line — identical output, since only the leaf
  gets a terminator and only when children follow it (so it is never the
  last row).
- **Spec sketch corrected**: renderdag does not continue a finished
  column (a childless row's column ends at that row), so the
  leaf-with-children example's later rows sit under a blank column, not
  `│`. Tests pin the real output.
- **Selector search view** renders `glyph + " " + label` by calling
  `dagLineText` on the line with its graph parts blanked, so truncation
  is the same code path as the tree view.
- **`format tree` help text** now says "chronological DAG" instead of
  "indented tree".
