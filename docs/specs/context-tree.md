# Spec: context tree and explicit-playlist boundary display

> Status: **spec approved, implementing** (2026-09-03). Phases B and C of
> the tree-presentation effort; phase A (renderdag rendering,
> `docs/specs/tree-presentation.md`) is implemented (1de5db3). Phase B
> changes the tree builders and display only, not what `set-context`
> writes; phase C changes `set-context`. Implementation order: B,
> then C. The "round" references in this file are the derisk discussion
> rounds summarized in the WORK LOG.

# SPEC

## Problem

The display tree (`toDisplayTree`, docs/specs/session-tree.md) reduces a
boundary to a single edge only when the boundary's preserved list is
consumed whole by rule 1 (reparent onto the last preserved uuid). That rule
is blind to what the preserved list actually _is_: it places
`set-context 3 4 5` under raw 5 exactly like a native `/compact` of `1 2 3
4 5` with preserved `[3,4,5]`, although the first is a context of three
messages with no summary and the second keeps 1–2 via the summary. It also
cannot place a boundary whose list extends a context with entries from
elsewhere (`1 2 3 4 7 8`), which is precisely the shape phase C makes easy
to produce.

Two things are wanted:

- **Phase B — a display tree with a stated edge meaning.** Row Y hangs
  under row X iff the assistant context at Y is "the context at X, then
  Y". A boundary that reproduces some row's context is a pure rewind (no row of
  its own unless it carries a summary, block hidden); one that extends a
  row's context shows the extension as relinked rows under it; one that
  reproduces no row's context is a new root with its whole block visible. To decide this we
  need the assistant context at every occurrence, so a middle layer
  `ContextTree` (full tree → context tree → display tree) materializes the
  relation "occurrence → its context predecessor" that today lives only
  implicitly in `loadedContext`.
- **Phase C — rewind-and-append.** `set-context --rewind-to X a b …`
  writes a boundary whose list is the context at X followed by `a b …`,
  through the same normalization as an explicit list. Alongside: the
  `--anchor` flag and the user/assistant filtering of rewind playlists are
  removed.

## Success criteria

1. `toContextTree(buildTree(F), F).contextAt(tip)` presents the same
   context as `loadedContext(F[..k])` for `tip = loadedContext(F[..k]).at(-1)`
   — equal after each API-message group's results are sorted (the
   request builder merges them into one user message; only their block
   order differs, see Edge cases) — for
   every fixture `F` and every settled prefix length `k` (nothing in the
   prefix awaits a later entry: no tool call awaits its result, no
   boundary awaits its anchor; elsewhere the loader judges a call dead in
   the prefix but alive in the file — see Edge cases).
   Property test; fixtures that legitimately differ are enumerated in the
   test with the reason.
2. A native `/compact` boundary (up_to shape, list = tail of the live
   context) displays as today: `═` under the last preserved row, summary
   `□` under `═`, block hidden.
3. `set-context --rewind-to X a b` (X on a raw chain, `a b` off it) displays
   the branch `X → a → b` with `a`, `b` as relinked rows and no `═` row;
   the next turn hangs under `b`'s relinked row. A pure rewind
   (`--rewind-to X`, no summary) adds no row at all: the next turn hangs
   under X.
4. `set-context 3 4 5` with no summary on the chain `1 2 3 4 5` displays as
   a new root with `~3 ~4 ~5` visible under `═`.
5. A boundary whose list reproduces a prefix of a hidden block (`[S1,3]`
   after `[S1,3,4]`) is a new root, not a child of `S1`.
6. A boundary can branch off a visible relinked row: after
   `[1,2,3,4,7,8]` (from 3), `[1,2,3,4,7,10]` displays `~10` under `7@B`.
7. `set-context --rewind-to X a b` writes the same boundary as
   `set-context <ctx(X) uuids…> a b`. Every rewind
   writes a boundary: the no-write `resumeSessionAt` path and the
   `filterTail` override are gone.
8. The `--anchor` flag, the `anchor` wire field, and the user/assistant
   playlist filters no longer exist; `set-context --rewind-to X` on a
   chain containing system entries (`turn_duration`, attachments) writes
   them into the preserved list.
9. Existing tests stay green except where they assert the removed
   behavior (rule 4 placement is preserved via the context tree; filtered
   playlists and `--anchor boundary --summary` are removed behaviors).

## Examples

Notation: rows in materialization order, glyphs per
`docs/specs/tree-presentation.md` (`═` boundary, `□` summary, `❯` user
text, `●` assistant text); a relinked (`uuid@boundary`) row keeps its
entry's glyph and is drawn dimmed in `/tree` — in these diagrams and in
`format tree`'s uuid column it is marked `~`; `B`, `B2` name boundaries;
`S` names a summary.

**Native compact** (`1 2 3 4`, `/compact`, P=[3,4], summary S, then 5):
match steps 3 → 4 (start rule relaxed: a summary is present); branch point
4, nothing left over → pure rewind.

```
❯ 1
● 2
❯ 3
● 4
═ B
□ S
❯ 5
```

**Rewind-and-append** (`1 2 3 4 5 6 7 8` on one chain;
`set-context --rewind-to 4 7 8`, list [1,2,3,4,7,8]; then 9): 1's
predecessor is null (a context start), 2,3,4 step; raw 7's predecessor is
6, not 4 → match ends at 4, remainder [7,8].

```
❯ 1
● 2
❯ 3
● 4
├─╮
│ ❯ 5
│ ● 6
│ ❯ 7
│ ● 8
❯ ~7
● ~8
❯ 9
```

**Explicit list, no summary** (`1 2 3 4 5`, `set-context 3 4 5`): raw 3's
predecessor is 2, not a context start, and no summary relaxes the rule →
no match → new root, whole block visible.

```
❯ 1
● 2
❯ 3
● 4
❯ 5
═ B
❯ ~3
● ~4
❯ ~5
```

**Branching off a relinked row** (after the rewind-and-append example,
`set-context 1 2 3 4 7 10`): 7 steps to `7@B` (raw 7's predecessor is 6);
raw 10's predecessor is not `7@B` → branch point `7@B`, remainder [10];
`~10` hangs under `7@B` (no `═` row: no summary, matched).

**Prefix of a hidden block** (`[S1,3,4]` installed by B1, then
`set-context S1 3` with a summary): S1 steps to 3@B1 only (raw 3's
predecessor is 2); the deepest candidate set has no visible member → new
root. Displaying it under `S1` would claim context [S1,3,4].

**Excluded entries** (native list `[t,3,4]` where `t` is a thinking-only
assistant entry re-persisted after the boundary): `t` is `excluded`,
skipped on the list side; the match is 3 → 4 as in the native example.

## Type design

### `src/core/tree/context-tree.ts` (new)

```ts
import type { UUID } from "node:crypto";
import type { SessionEntry } from "../session/file.ts";
import type { ParentMap, TreeNodeRef } from "./nodes.ts";

/** The assistant-context relation: every full-tree occurrence except
 *  boundary rows, each under its context predecessor, so the root-first
 *  path to any occurrence is the assistant context there. */
export class ContextTree {
  /** Full-tree (materialization) order minus boundary rows. Parent = the
   *  full-tree parent with each parallel tool group linearized in file
   *  order (each group row parents onto the previous group row; rows
   *  that end the group or arrive after it keep their parents — see Edge
   *  cases), and null where
   *  the full-tree parent is a boundary row: an up_to summary, a
   *  no-summary block's first row, and a post-wipe prompt are context
   *  roots. Boundaries are in the raw tree only; the display tree
   *  re-inserts the ones it shows. */
  readonly parentMap: ParentMap;
  /** Occurrence ids of entries no normalizePreservedUuids-accepted list
   *  can contain (so the resume sanitizer always drops them): tool calls
   *  with no result entry in the file, tool results with no call entry,
   *  and thinking-only assistant entries whose API message group has no
   *  member surviving those two rules (an id-less thinking-only entry is
   *  its own group). Every occurrence (raw and relinked) of such a uuid is
   *  a member. Matching skips these on both sides: a normalized list
   *  never contains them, and a native list that does is stepped past.
   *  An entry the loader drops only on SOME paths (a call whose result
   *  exists off-path) is not a member, so a list omitting it fails to
   *  match at the next entry — see Edge cases. */
  readonly excluded: ReadonlySet<UUID>;

  constructor(
    parentMap: ParentMap,
    excluded: ReadonlySet<UUID>,
    relinkedOccurrencesOf: ReadonlyMap<UUID, string[]>,
  );

  /** Every occurrence of `uuid`, in materialization order. */
  occurrencesOf(uuid: UUID): string[];
  /** The context predecessor of `id`: its nearest non-excluded ancestor. */
  nonExcludedPredecessor(id: string): string | null;

  /** The assistant context with `ref` as the tip: the parentMap path
   *  root-first to ref, minus excluded occurrences. A straight walk —
   *  group linearization is in the relation and sanitization is
   *  `excluded`. viaBoundary on each element as the loader sets it. Throws
   *  on a ref absent from parentMap. */
  contextAt(ref: TreeNodeRef): TreeNodeRef[];
}

/** tool-group.ts — a parallel tool group as the rolling builders see it:
 *  the assistant entries sharing one API message id and the results
 *  answering their tool calls, in file order, each row the context parent
 *  of the next. Holds both loader judgements about groups: membership
 *  (expandParallelToolGroups) and dead calls (sanitizeForResume, by tool
 *  call id). */
export class ToolGroup {
  /** Starts the group at its first row, an assistant entry. */
  constructor(entry: UuidEntry);
  /** Appends `entry` when it is the group's next row — a same-id
   *  assistant (id-less assistants are each their own group) or a result
   *  answering one of its calls — and returns the row it parents onto;
   *  undefined when the entry ends the group instead. */
  push(entry: UuidEntry): UUID | undefined;
  /** Whether a call still awaits its result. */
  awaitingResults(): boolean;
  /** Uuids the resume sanitizer drops once the group has ended: call
   *  entries none of whose calls was answered, and thinking-only members
   *  when nothing survives. */
  excludedAtEnd(): UUID[];
}

/** session/file.ts */
export type UuidEntry = SessionEntry & { uuid: UUID };
export function hasUuid(entry: SessionEntry): entry is UuidEntry;

/** One pass over fullTree (materialization order). Precondition: fullTree
 *  came from buildTree and byUuid from entriesByUuid over the same entries;
 *  throws when they disagree or a parent follows its child. One tool group
 *  is active at a time: it starts at an assistant row, continues through
 *  same-id assistants and answering results (`ToolGroup.push`), and ends at
 *  any other row, when its `excluded` contributions settle (calls without
 *  a result, thinking-only members without a surviving sibling). Revised
 *  in the 48536d3 and c767566 review rounds — see WORK LOG. */
export function toContextTree(
  fullTree: ParentMap,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): ContextTree;

export interface PreservedListMatch {
  /** Occurrence id whose context the list's matched prefix reproduces. */
  branchPoint: string;
  /** Index into preservedUuids of the first non-excluded entry that did not
   *  match; preservedUuids.length when everything matched (pure rewind). */
  remainderFrom: number;
}

/** Set stepping over contextTree.parentMap, over `materialized`
 *  occurrences only (those preceding the boundary — it can only reproduce
 *  contexts that existed before it): candidates(0) = occurrences of P[0];
 *  when !anchorIsSummary each must also be a context root (its
 *  predecessor chain, skipping excluded occurrences, reaches null).
 *  candidates(i) = occurrences of P[i] whose predecessor chain, skipping
 *  excluded occurrences, reaches a member of candidates(i−1). Excluded P
 *  entries are skipped. Result: the deepest non-empty set; branchPoint =
 *  its earliest-materialized member not in `hidden` (hidden occurrences
 *  may be stepped through but cannot be branched off — their row is not
 *  displayed); undefined when candidates(0) is empty or the deepest set is
 *  all hidden — the caller treats the boundary as a new root; remainderFrom
 *  as documented. */
export function matchPreservedList(
  contextTree: ContextTree,
  preservedUuids: readonly UUID[],
  anchorIsSummary: boolean,
  materialized: Pick<ReadonlySet<string>, "has">,
  hidden: ReadonlySet<string>,
): PreservedListMatch | undefined;
```

### `src/core/tree/loader.ts`

- Unchanged. The loader keeps reading the from-shape
  (`anchorUuid` = boundary uuid with a summary present) — the CLI wrote it
  natively in the past.

### `src/core/tree/display-tree.ts`

```ts
/** The human view: the context tree's relation, with boundary rows
 *  re-inserted where they are shown and matched blocks hidden. One forward
 *  pass over fullTree (materialization order; a boundary row is met after
 *  everything that existed before it, and before its own block), applying
 *  at each boundary row with a valid non-empty preserved list:
 *  matchPreservedList(anchorIsSummary = anchorUuid !== boundary uuid,
 *  materialized = ids passed so far, hidden = hidden so far).
 *  - Match with an up_to summary: the `═` row is displayed under
 *    branchPoint, the summary under `═` (its context-tree parent is null),
 *    the block under the summary as in the context tree.
 *  - Match without a summary: no `═` row; the block's first row parents
 *    onto branchPoint.
 *  - In both: block rows with list index < remainderFrom are hidden, the
 *    rest are visible.
 *  - No match: the `═` row is a root (hanging it under its logical parent
 *    would claim that row's context); summary and block under it as in the
 *    full tree, all visible.
 *  Invalid or empty-list boundaries keep their full-tree placement and
 *  children, visible: a context wipe is a real event. Finally hidden rows
 *  display their children under the nearest visible ancestor (as today), so
 *  a hidden block's descendants — the next turn after a pure rewind, the
 *  leaf occurrence itself — land on the branch point (no summary) or the
 *  summary row (up_to). */
export function toDisplayTree(
  fullTree: ParentMap,
  contextTree: ContextTree,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): DisplayTree;
```

Boundary validity in the display pass is checked against the rows placed
so far (`invalidRelinkReason(precedingUuids, boundary)` — see the
fail-closed divergence in the WORK LOG's 48536d3 round), so the pass
needs no scan of the entries.

`DisplayTree` (class: `parentMap`, `nearestVisibleRow`) is unchanged.
Deleted from this file: rule 4 (`linearizedGroupParents` — group
linearization is inline in `toContextTree`) and rule 3
(pruning): a matched no-summary boundary has no `═` row to prune, a
summary boundary always has its `□` under it, and no-match/invalid/empty
boundaries are shown by definition.

Callers build the context tree between the full and display trees:
`src/format/tree.ts` (`format tree`), `src/tui/interactive-mode.ts`
(history render, `/tree` open). The `raw` filter still renders `buildTree`
output.

### Phase C — `src/core/sdk-socket.ts`

```ts
export type SetContextRequest =
  | {
      type: "set-context";
      uuids: UUID[];
      /** Omitted → no summary entry is written. Present → up_to shape:
       *  summary first, then uuids. */
      summaryText?: string;
    }
  | {
      type: "set-context";
      rewindTo: TreeNodeRef;
      /** Appended after the context at rewindTo; the whole list then goes
       *  through normalizePreservedUuids. */
      append?: UUID[];
    };
```

`parseSetContextRequest`: `anchor` is no longer accepted; `append` must be
an array of uuids and is only valid with `rewindTo`; `rewindTo` remains
exclusive with `uuids`/`summaryText`. `SetContextResult.added` is set in
both modes.

### Phase C — `src/core/sdk-commands.ts`

- `--anchor` flag deleted.
- Positional uuids are allowed with `--rewind-to` (they become `append`).
- `--rewind-to` is exclusive with `--summary` and `--empty`; `--empty` is
  exclusive with uuids and `--summary` (unchanged).

### Phase C — `src/core/session/file.ts`

`buildBoundaryEntries` loses its `anchor` parameter; `anchorUuid` is the
summary uuid when a summary is written, else the boundary uuid.

### Phase C — `src/core/daemon/set-context.ts`

The handler has one path. It builds `toContextTree(buildTree(entries))`
per request, takes the requested list (`uuids`, or
`contextAt(rewindTo) ++ append` — any context-tree occurrence is a valid
target, `X@B` included; an absent one throws from `contextAt`), then
`normalizePreservedUuids` (rejection throws), `buildBoundaryEntries` with
`logicalParentUuid` = the bare uuid of `matchPreservedList`'s branch point
over the normalized list (materialized = `contextTree.parentMap`,
hidden = ∅; null when nothing matches — a new root), append, restart,
`added` reported. `summaryText` is accepted only with `uuids`.

Deleted with the no-write path: the rewind target checks (assistant, final
entry of its API message — `resumeSessionAt` requirements; normalization
now covers split API messages), the active-chain truncation test, the
`messageUuids` user/assistant filter, the post-restart verification of the
loader's view against the normalized list (a normalize↔loader consistency
check that belongs in tests), the `filterTail` kind of
`GetMessagesOverride` (now the single shape `{ chain, installedAtLeaf }`),
`logicalTipOverride`, and `restartQuery`'s `resumeSessionAt` argument. The
daemon leaf after a rewind is the file truth (`X@B`), as for any boundary.

### Phase C — `src/tui/components/tree-selector.ts`

`summaryChainUuids` returns the unfiltered chain.

### Deletions

- `display-tree.ts`: rule 4 and `linearizedGroupParents` (linearization
  is inline in `toContextTree`); `loader.ts`: `toolGroupMaps` is now the
  loader's own (expansion only).
- `sdk-commands.ts`: `anchor` flag; `sdk-socket.ts`: `anchor` field and its
  parsing; `file.ts`: `anchor` parameter; `set-context.ts`: anchor
  derivation, `messageUuids` filter; `tree-selector.ts`: the type filter in
  `summaryChainUuids`.

## Data flow

Phase B (display): `SessionSnapshot` → `buildTree` → `toContextTree`
(linearize groups, drop boundary rows, compute `excluded`) →
`toDisplayTree` (forward pass over the full tree; per boundary:
`matchPreservedList` → hide/keep block rows, re-insert `═` where shown;
then hidden-row reattachment as today) → phase A's
`treeLines`/`renderDagLines`.

Phase C (`set-context --rewind-to X a b`): CLI resolves prefixes → wire
`{ rewindTo, append }` → daemon: `buildTree` → `toContextTree` →
`contextAt(X) ++ append` → `normalizePreservedUuids` →
`matchPreservedList` (logicalParentUuid) → `buildBoundaryEntries` (no
summary) → append to file → restart. The written boundary then
displays through phase B as a pure rewind (`append` empty) or
rewind-and-append.

## Cost

- One extra `ParentMap` per tree build, plus the relinked-occurrence
  index and `excluded`: all built in `toContextTree`'s single pass over
  the full tree (O(occurrences)); `buildTree` and `toDisplayTree` are
  single passes too, with no separate scan of the entries.
- `matchPreservedList`, per boundary: Σ over non-excluded list entries of
  (occurrences of that uuid × predecessor-chain walk length). A walk stops
  at the first non-excluded occurrence, so its length is the number of
  consecutive excluded predecessors + 1 — bounded by the longest run of
  thinking-only/dead entries, small in practice. Occurrences per uuid =
  1 + number of boundaries listing it.
- `contextAt`: one parent walk, O(path). Only tests call it in this spec.
- Every rewind now appends a boundary: |ctx| relinked occurrences per
  rewind in the full and context trees (hidden in display). Sessions with
  many tail rewinds grow their trees; matching cost per uuid grows with
  the number of boundaries listing it.
- `toDisplayTree` stays O(occurrences) outside matching (memoized
  nearest-visible-ancestor walk, as today).

## Edge cases

- **`excluded` vs the loader.** `excluded` is file-wide; the loader's
  dead-call judgement is per prefix/path. A call whose results exist in
  the file is alive in the context tree but dead for the prefix ending at
  the call (results not yet written) and for a path its results are not
  on. Hence the settled-prefix restriction in success criterion 1, and: a
  boundary listing such a path (prompt parented on the call with the
  results off-path) matches up to the entry before the call and displays
  as a fork. Not producible by clauctl once every rewind writes a boundary
  (the list then omits the call, and the next prompt parents on the
  block); documented for native files, not modeled.
- **Group order is canonical, not the loader's.** The loader (mirroring
  the binary's stage 3) splices a group's off-path results after its
  last ON-PATH assistant entry, so the entry order inside an interleaved
  group depends on the tip; the tree keeps file order. After stage-5
  reassembly the difference is only the tool_result block order inside
  the merged user message (byte-observable, semantically nil). Decided
  2026-09-06: keep the canonical order, compare criterion 1 up to it;
  486/9322 settled prefixes of session 7fdff629 differ this way.
- **Late fork off a mid-group tool result** (`--resume-session-at` onto
  `resultB` of `[callA, callB, resultB, resultA]`, prompt written after
  the group ended): the context tree keeps the raw parent, so `contextAt`
  omits `resultA` where the loader splices it in (the API needs every
  tool_use answered). Deliberate divergence from criterion 1 (decided in
  review round c767566): remembering ended groups would cost a persistent
  per-result map for a shape clauctl never produces (its rewinds write a
  boundary) and native rewinds don't target.
- **Queued-prompt races in pre-2.1.258 files.** Old CLIs wrote a prompt
  queued during `/compact` with a pre-compaction parent — before the
  boundary line (2.1.195, session 474b3175) or after it (2.1.220,
  2dafe15d); the loader cuts and/or reattaches the turn onto the block
  tail (FINDINGS §1). The context tree keeps the raw parent, so those
  turns display under the pre-compaction history and `check-context-at`
  reports every prefix in the affected segment. Deliberate (2026-09-07):
  2.1.258 dequeues the prompt after the compaction writes and chains it
  onto them, so the raw parent is correct there and the extra
  placed-since-boundary state would serve only old files.
- **Legacy clauctl boundaries** written with the user/assistant filter have
  gaps (attachments, `turn_duration`) relative to the context tree. Matching
  is strict — they display as forks with `~` rows. Deliberate: not worth
  complicating the tree for shapes phase C stops producing.
- **Property-test divergences** (`contextAt` vs `loadedContext` on corrupt
  fixtures, known from round 4): duplicate uuids (buildTree first-wins vs
  loader last-wins), invalid boundary (buildTree no-relink vs loader wipe).
  A dangling parent does not diverge (both sides root the entry). The test
  lists the divergent fixtures by name with the reason; reconciling them is
  out of scope.
- **`--rewind-to X` with X excluded** (a dead call or a thinking-only
  entry): X is implicitly replaced by its nearest non-excluded ancestor in
  the context tree. `loadedContextUuids` of the prefix through X already
  drops X, so `handleRewind` needs no context tree for this; the "final
  assistant entry" target check runs on X as today. The same applies to a
  call that is alive in the file but dead in its prefix (no results yet):
  the written list omits it.
- **`--rewind-to X@B`** semantics unchanged: the installed-chain prefix
  ending at X (plus `append`).
- **Re-inserting an entry already in scrollback** (`--rewind-to 5 1` after
  `[S1,3,4]`) duplicates 1 as a visible `~` row: correct, the user asked
  for 1 verbatim.
- **Native lists that start with a thinking entry** re-persisted after the
  boundary (4 of 326 locally): when the entry's group is thinking-only it
  is `excluded` and skipped, and the match starts at the next entry; when
  the group has a text member that the list omits, the match stops at the
  thinking entry and the boundary displays as a fork (normalize would
  reject that list too — consistent).
- A pure no-summary rewind is invisible in the display tree (no row); its
  leaf occurrence and the next turn display on the branch point. `format
tree --filter raw` still shows the boundary and its block.

## Non-goals

- `get-messages --at <ref>` (historical assistant context via
  `contextAt`) — later.
- Daemon-side incremental full/context/display trees
  (docs/thoughts/get-entries-caching.md) — later.
- Folding the `loadedContext` body onto `contextAt` — separate later
  commit, after the property test has pinned equivalence.
- Accommodating legacy filtered playlists or the per-prefix dead-call
  divergence in the tree model.
- Writing the from-shape summary (`--anchor boundary --summary`): removed.
  The equivalent is `set-context …` followed by `prompt --no-query <summary>`.

# IMPLEMENTATION IDEAS

## Why a context tree rather than per-position `loadedContext` (rounds 1–5)

- Rebuilding `toDisplayTree` or calling `loadedContext` per boundary is
  O(n²) and, worse, per-position contexts do not locate the branch point:
  a no-write tail rewind forks without a boundary (`1 2 3 4`, rewind to 2,
  prompt `3′` — ctx after 4 is not a prefix of ctx after 3′), and a
  rewind boundary may target an abandoned-branch node absent from the
  pre-boundary context.
- The FULL tree (`buildTree`) is already the assistant-view tree: for
  well-formed files `loadedContext(prefix)` = the tip's path cut at the
  boundary row + stage 3 (group expansion) + stage 4 (sanitization). Stage
  3 mid-path equals rule-4 linearization on native files (all calls of a
  group precede all results; the next turn parents on the last-written
  result). Stage 4 is a per-occurrence flag — `excluded` — except the
  per-prefix dead-call judgement, which no tree built from the whole file
  can carry (Edge cases). So `contextAt` is a straight walk.
- Pairwise matching "P[i] extends the match iff pred(P[i]) == P[i−1]" over
  raw occurrences fails for lists that pass through relinked rows
  (`[1,2,3,7,12,55]` after `[1,2,3,7,12,16]` must branch off `12@b`);
  hence set stepping over all occurrences, with visibility (a hidden row
  cannot be a branch point) supplied by `toDisplayTree` through the
  `materialized` and `hidden` sets — visibility of earlier occurrences is
  settled by the time a later boundary is matched, because boundaries are
  processed in materialization order.

## Matching details

- Candidate sets are small (occurrences of one uuid). A raw occurrence's
  id is the uuid itself, so only relinked occurrences need indexing:
  `relinkedOccurrencesOf: Map<UUID, string[]>` (materialization order)
  inside the ContextTree, present only for uuids some boundary lists;
  candidates(u) = `[u if parentMap.has(u)] ++ relinkedOccurrencesOf.get(u)`.
- The predecessor walk: `id = parentMap.get(id)` while `excluded.has(id)`;
  then test membership in the previous set (step i > 0) or null-ness
  (start rule, i = 0 without a summary).
- Start rule with `anchorIsSummary`: the list's first entry may be
  anything; the summary stands for the dropped prefix. `anchorIsSummary` =
  `anchorUuid !== boundary.uuid` (up_to shape) — structural, no
  `isCompactSummary` dependence. From-shape boundaries (`anchorUuid` =
  boundary uuid, summary present) and no-summary boundaries use the
  strict rule.
- Identification of explicit playlists is structural: `compactMetadata.
trigger` is `"manual"` for native manual `/compact` and for clauctl
  boundaries alike (4474 local boundaries), `"auto"` only for native
  auto-compaction — no marker to rely on.

## Probe results (round 6, read-only, 300 local sessions / 360 boundaries)

319/326 native boundaries step exactly along the linearized full-tree
relation; the rest omit thinking-only entries (`excluded` covers them) or
are old odd shapes (new-root display is acceptable). Native preserved lists
DO include `attachment` and `system:local_command` entries, and user
prompts parent on `system:turn_duration` entries — the basis for removing
the user/assistant filter. clauctl no-summary boundaries show attachment
gaps caused by that filter.

## Phase C notes

- Rewind is sugar for an explicit playlist: every normalization an explicit
  list gets, a rewind gets. On loader output `normalizePreservedUuids` is a
  no-op (pairs complete, no thinking-only groups), so the observable change
  is only for `append`.
- `restartAndVerify` compares the normalized list; interior system entries
  stay on the loader chain, so verification passes without the filter.
- Dropping the no-write path: what it bought was no file mutation and no
  relinked duplicates for tail rewinds; what it cost was a second code
  path with its own leaf semantics (override machinery, a leaf with no
  file truth). Boundaries stack, so a tail-rewind boundary followed by a
  native `/compact` is the already-exercised abandoned-branch shape —
  worth one test.
- `--anchor` removal: `--summary` implies the up_to shape; a from-style
  summary is expressible as `set-context …` then `prompt --no-query`.
  Whether native from-style summaries carried `isCompactSummary` is
  unknown (no local example); irrelevant since the current CLI does not
  write them.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

## Derisk history (2026-09-02)

- Rounds 1–3: semantic edge definition; rejected per-boundary
  `toDisplayTree` rebuild (O(n²)); Anton's per-position `loadedContext`
  proposal and its fork counterexample; raw-only pairwise matching and
  its relinked-row counterexample; user/assistant filter dispute (code
  reading confirmed: `messageUuids` in set-context.ts, `summaryChainUuids`
  in tree-selector.ts).
- Rounds 4–5: full tree is the assistant-view tree; `ContextTree` layer
  decided; set stepping decided; scrollback duplicates accepted.
- Round 6: probes (hypothesis: native lists step exactly along the
  linearized full-tree relation — 319/326 do); `excluded` defined as
  normalize's rejection set with the off-path dead-call residual
  documented; legacy attachment gaps not accommodated; phase C surface
  settled (`append` wire field, positional uuids with `--rewind-to`,
  `--anchor` removed, always normalize, excluded X → nearest non-excluded
  ancestor, `X@B` unchanged).
- Spec written from the round-6 decisions. Deviations from the recorded
  `matchPreservedList` signature, made while writing and flagged for
  review: visibility inputs added (success criterion 5 needs visibility,
  which only `toDisplayTree` knows; now the `materialized` and `hidden`
  sets); `byUuid` parameter
  dropped (the context tree carries the occurrence index and boundary-row
  set itself). Also made explicit: no-match ⇒ root (not "keep placement");
  `excluded` is stated as "uuids no accepted list can contain" because
  normalize's thinking-only check is list-relative.
- Review round 1 (b0175f7): `contextAt` reduced to a straight walk (the
  "consult set" was the loader's tip-time group expansion, which the
  linearized relation already carries; per-prefix dead calls are excluded
  from the property test instead); no-write rewind path deleted (TDC 5);
  glyph notation aligned with ce34392; relinked-only occurrence index.
  TDC 1 decided: boundary rows are absent from the context tree (parent
  null where the full-tree parent was a boundary); `toDisplayTree` takes
  the full tree too and re-inserts `═` rows where shown (summary or no
  match); matched no-summary boundaries have no row, which makes rule 3
  vacuous — deleted. `matchPreservedList` takes `materialized`/`hidden`
  sets (both known in the display pass) instead of an index + predicate.

## Phase B

- [x] `context-tree.ts`: `ContextTree`, `toContextTree`,
      `linearizedGroupParents` moved, `matchPreservedList`
- [x] `context-tree.test.ts`: property test over fixtures × prefixes,
      divergent fixtures listed; matching unit tests (examples above)
- [x] `display-tree.ts`: forward-pass placement over the context tree;
      rules 3 and 4 deleted
- [x] callers: `format/tree.ts`, `interactive-mode.ts` ×2 (also
      `scripts/tui-parity/render-session.ts`, `tree-selector.test.ts`)
- [x] docs: session-tree.md display rules, session-views.md (context view
      becomes the context tree); tree-presentation.md rule references

## Phase C

- [x] wire: `append`, `anchor` removed; `parseSetContextRequest`
- [x] CLI: `--anchor` removed, positional uuids with `--rewind-to`,
      exclusivity
- [x] `file.ts`: `buildBoundaryEntries` without `anchor`
- [x] `set-context.ts`: `rewindPlaylist` + normalize, `logicalParentOf`
      on every boundary; filter removed; no-write path + `filterTail`
      override + `logicalTipOverride` + resume-at restart argument deleted
- [x] test: tail-rewind boundary followed by native `/compact`
- [x] `tree-selector.ts`: filter removed
- [x] tests and docs (session-tree-and-set-context.md, README usage)

## 2026-09-03

- Spec approved after review round 1 (b0175f7) and the (a) rework.
  Phase A landed in 1de5db3 (renderdag, `parent-map.ts`, `glyphs.ts`,
  block-after-anchor `buildTree` order). Starting phase B.

## 2026-09-03 — phase B implemented

Suite green (616 tests), presubmit clean. Behavior changes pinned by updated
tests: a matched from-shape summary boundary has no `═` row (the summary
forks off the branch point — `format/tree.test.ts`, `display-tree.test.ts`);
`hiddenBoundarySession` (format/tree.test.ts) now preserves `[1,2]`, a
real pure rewind — its old list `[2]` is a criterion-4 new root under the
stated edge meaning.

### Implementation-Time Decisions

- **`matchPreservedList`'s `materialized` is a has-only view**
  (`Pick<ReadonlySet<string>, "has">`, not `ReadonlySet`). The display
  pass's map of placed rows IS the materialized set; copying it into a
  Set per boundary would cost O(occurrences × boundaries). A `ReadonlyMap`
  satisfies the pick structurally.
- **`ContextTree` exposes `occurrencesOf(uuid)` and
  `nonExcludedPredecessor(id)`** beyond the spec's `contextAt`: both are
  what matching needs, and the relinked-occurrence index (spec:
  "relinkedOccurrencesOf … inside the ContextTree") is built once in the
  constructor from `parentMap`, so the constructor takes no entries
  (later the `excluded` and `relinkedOccurrencesOf` arguments were added;
  see type design).
  `occurrencesOf` orders raw first, then relinked in materialization
  order — exact for every producer-written file (a relinked occurrence
  materializes at its boundary, which follows the entry); the
  "preserved uuid names a later entry" corruption could reorder them, not
  modeled.
- **Property-test "settled prefix"**: a prefix qualifies when no tool
  call in it awaits a result (a prefix ending at a parallel turn's first
  result still has the other call pending, and the loader drops it there;
  a group's calls stop waiting when the group ends — from then on the
  loader judges them dead in every prefix) and no boundary in it awaits
  its anchor (the loader's chain stops at the unwritten summary; the
  context tree has the block under it). Three
  fixtures, 29 of 34 prefixes checked.
- **Divergent fixtures**: duplicate uuid with a rewritten parent and an
  invalid boundary are enumerated with the two answers asserted. The
  round-4 "dangling parent" case turned out NOT to diverge (both sides
  root the entry), so it is not listed.
- **Matched no-summary boundary row** is modeled as hidden with parent =
  branch point, so `nearestVisibleRow(B)` answers the branch point (as
  the old rule-3 behavior did) rather than "unknown".

## 2026-09-03 — review round 48536d3 (phase B, pre-commit)

Anton's TDC comments on the phase B working tree (`git show
48536d3`) and the agreed resolutions. Phase B is NOT committed yet; this
round lands in the same commit. Anton will rewind the conversation to the
phase-B report and paste the "Rewind summary" below in its place.

### Decisions

- **Passes.** One pass total over a builder's input is the target. Mental
  model: the daemon will eventually keep a rolling `tail -f` of the
  session file and place each row once on arrival; group linearization
  and boundary relinking retroactively touch a bounded recent past.
  Restructure phase B code toward that model (design notes in
  docs/thoughts/get-entries-caching.md); `fullTree`/`ContextTree`
  separation stays for now.
  - `toContextTree(fullTree, byUuid)`: one pass over `fullTree`; group
    bookkeeping inline (parent = group tail _so far_; outside child of a
    group result → tail so far — differs from "final tail" only if a
    group member is written after an outside child of one of its
    results); relinked index and topological assertion in the same loop;
    calls and thinking-only uuids collected, `excluded` built from them at
    the end. `toolGroupMaps`/`linearizedGroupParents` no longer used here.
  - `toDisplayTree(fullTree, contextTree, byUuid)`: no entries pass —
    boundary validation is against rows materialized so far.
  - `buildTree`: in-loop parent-present check (root + onInvalid) replaces
    the final rooting pass, making "every row follows its parent" true.
- **`excluded: ReadonlySet<UUID>`**, not occurrence ids.
- **Cycle check** leaves `contextAt`; `buildTree` enforces topological
  order, `toContextTree` asserts it.
- **Matching** stays parent-direction (no children map); the candidate
  filter is restated readably (no ternary-of-conjunctions).
- **Fail-closed divergence (new):** a preserved uuid must name an
  _earlier_ entry. The binary validates against the whole-file map, but
  a later entry would mean the file was invalid between the boundary's
  write and that entry's. `invalidRelinkReason(precedingUuids, boundary)`
  → "names no earlier entry"; `buildTree` passes rows so far,
  `loadedContext` first-index < cut, `set-context` unchanged.
  `compactBoundaryAt(entries, index)` → `compactBoundaryOf(entry)`.
- **Comments.** Doc comments say how to use/think about a symbol;
  algorithm detail lives in this spec. Audit every comment added in phase
  B (reviewer focus). Rule recorded in AGENTS.md.
- **Real-session verification.** (a) `scripts/` script: run
  `contextAt` vs `loadedContext` at every settled prefix of a given
  session file. (b) Intercepting oracle: non-forwarding variant of
  `docs/derisk/compact-boundary-injection/shim.mjs` answering a canned
  SSE stream; resume truncated copies at each settled prefix and compare
  the captured request's uuid chain with `contextAt`. Nothing leaves the
  machine. `getSessionMessages` is NOT a valid oracle (no cut, all
  boundaries, no sanitizer — FINDINGS §getSessionMessages). Later, not
  now: a `tests/sdk/` guard like compact-boundary-suite.test.ts so an SDK
  change in context construction is noticed.

### Tasks

- [x] AGENTS.md + ~/.claude/CLAUDE.md rules (comments, passes)
- [x] docs/thoughts/get-entries-caching.md rolling-builder notes
- [x] loader.ts: `compactBoundaryOf`, `invalidRelinkReason` preceding-only;
      loadedContext first-index; tests + session-tree.md Edge cases
- [x] build-tree.ts in-loop check (`place`); tests
- [x] context-tree.ts single pass, `excluded` uuids, assertion, filter
- [x] display-tree.ts byUuid, no entries pass
- [x] callers (format/tree.ts, interactive-mode.ts ×2, render-session.ts,
      tests)
- [x] `src/core/tree/context-check.ts` (turnEndPrefixLengths,
      contextAtMismatches — shared by the unit test) +
      `scripts/check-context-at.ts <session.jsonl>...` (tier a). NOT yet
      run on a real session — explain, then run.
- [ ] tier (b) intercepting oracle: non-forwarding shim (canned SSE:
      message_start / text delta / message_stop) + script that, per
      settled prefix of a session, writes the truncated copy into a
      makeConfigDir scratch dir (tests/sdk/harness.ts), resumes via the
      SDK with ANTHROPIC_BASE_URL at the shim (pattern: resumeProbe in
      docs/derisk/compact-boundary-injection/round2.mjs), and compares
      the captured request's message chain with contextAt. Zero API
      traffic. Ask Anton before the first run.
- [ ] comment audit (own pass done in the rewrites; reviewer focus)
- [ ] /reviewer round (focus: comments, pass structure, fail-closed
      divergence, buildTree `place`)
- [ ] presubmit (npm test green 616/616 after restructure; presubmit not
      yet re-run); finalize Rewind summary

### Review round c767566 (2026-09-06) — addressed

Anton's TDC comments (`git show c767566`), all addressed and removed.
His non-TDC edits in that commit (`place` → `setParent` in
build-tree.ts; thoughts-doc reflow + "TUI rolling trees via
`get-entries --since`" alternative; AGENTS.md one-pass bullet marked as
soon-to-be-obsolete) stand as-is.

Decisions:

- `toContextTree` tracks ONE active `ToolGroup` (apiMessageId, members,
  tail, pendingCalls, thinkingOnly, hasSurvivor); `continuesToolGroup`
  (exported, shared with context-check) says which rows extend it; the
  group settles its `excluded` contributions when it ends, so the two
  post-loop passes are gone. Group members are occurrence-id strings —
  no `as UUID`.
- Late forks off an ended group's rows stay forks (Edge cases entry);
  the display test's expectation flipped accordingly.
- "Turn end" → "settled prefix" (nothing in the prefix awaits a later
  entry); pending calls/anchors tracked add-on-sight/delete-on-arrival,
  no index pre-pass; a group's calls stop pending when it ends. The
  "if already seen continue" part of comment (3) is NOT implemented: a
  seen-set misfires on re-persisted boundary + summary copies (at the
  second boundary its anchor is already seen), so the code assumes an
  anchor is the boundary itself or follows it (comment in code).
- `ContextMismatch.actual: string[]`; contextAt errors propagate;
  elementwise comparison. Empty loaded context (wipe boundary / no
  user-assistant yet) has no tip and is not counted.

Comments as recorded before addressing:

- context-check.ts `turnEndPrefixLengths`: (1) no pre-pass over entries
  for `fileIndexOf` — populate indices as you go; (2) pending tool calls:
  push the call when met, remove when its result is observed — not a
  min-over-results index scheme; (3) boundary anchor: record the anchor
  uuid; if already seen continue, else add to a pending list like
  pending results; (4) NAMING: a tool result is not a "turn end" — turn
  end = assistant stopped, user's turn (src/core/until.ts is the SDK-side
  definition). Checking prefixes at every entry is fine, but don't call
  them turn ends.
- context-check.ts `contextAtMismatches`: (5) "no tip" — is that an
  error? what does a check position with no tip mean?; (6)
  `actual: string[] | string` is sloppy type use — don't carry the error
  in a union; (7) compare lists, not joined strings.
- context-tree.ts group linearization: (8) too many group lookups
  (groupOfMessageId / groupOfCall / groupOfResult / groupOfParent;
  groupOfParent computed even where meaningless). Expected algorithm:
  track ONE active `group` (uuids in file order) + its `apiMessageId`; a
  new apiMessageId assistant resets the group to itself; a tool call or
  result whose parent is in the current group reparents onto the group's
  last entry. If more complexity is genuinely required (thinking-only
  members? interleaved groups?), say why. (9) `fullParent as UUID` relies
  on viaBoundary being absent — parse fullParent once at the loop top and
  use `.uuid`.

### Review round e2c62f8 (2026-09-06) — addressed

- `ToolGroup` is a class in `tool-group.ts` (type design above), used by
  `toContextTree` and `settledPrefixLengths`; `continuesToolGroup` and
  the inline settle closure are gone. Only a result answering one of the
  group's calls continues it.
- Results are matched to calls by tool call id (the sanitizer's key, so
  deadness is judged as the binary does), with the call entry's uuid kept
  alongside for `excluded`. The loader's expansion matches by
  `parentUuid`; the keys differ only on corrupt files.
- `awaitingResult` (the result is pending, not the call); `hasSurvivor`
  private. `settledPrefixLengths` is a generator. `toolResultIdsOf`
  added to loader.ts beside `toolCallIdsOf`.

### Review round 6aa4079 (2026-09-06) — addressed

- Every row that continues a group parents onto the group's tail (a
  same-id assistant's raw parent is the tail; a result's is its call, the
  tail or an earlier member), so `ToolGroup` needs no member set and no
  `linearizedParent`; `toContextTree`'s group handling is one
  if/else-if/else. Rows that end a group — boundary rows included — keep
  their parents.
- `UuidEntry` + `hasUuid` in session/file.ts; `ToolGroup` takes the
  entry alone. Renames from the commit (`continuesWith`,
  `awaitingResults`) kept.

### Review round 0053ee2 (2026-09-06) — addressed

- `ToolGroup.push(entry): UUID | undefined` — accepts-and-returns the
  predecessor row or rejects; `continuesWith` and `tail` folded in.
- Real-session run (`scripts/check-context-at.ts` on 7fdff629, 14924
  entries): 507 mismatches in two classes. (1) 21 prefixes ending at a
  CLI-re-persisted copy of an up_to boundary (the summary copy follows):
  fixed — a boundary awaits its anchor whenever the anchor is not the
  boundary itself (up_to summaries are always written after; from/wipe
  anchors are the boundary). (2) 486 prefixes with the same set and tip
  but a different order inside one parallel tool group: the loader
  splices off-chain results after the group's last ON-CHAIN assistant,
  which depends on the tip, so no tree order reproduces it. Decision:
  canonical tree order stays; criterion 1 compares presented contexts
  (`presentedOrder` in context-check.ts sorts each group's results);
  documented in Edge cases. Anchor fix kept.

### Review round 3316da5 (2026-09-06) — IN PROGRESS

- TDC in `presentedOrder`: don't assume every result after an API message
  belongs to it — use `ToolGroup.push` to admit only the group's own
  results. Not yet done.
- Anton ran the check on 474b3175 (6350 entries): 2833 settled prefixes,
  788 mismatches — being classified. (`/tmp/mismatches2` header says
  7fdff629 / 486, i.e. a pre-canonicalization run; 7fdff629 is clean with
  the current code.)
- 474b3175 mismatch classes (788 = 483 "loader has 3–4 more" + 305
  "mixed"), both compaction racing concurrent activity; NOT fixed —
  awaiting Anton's decision on each:
  - **A. Queued prompt written between boundary and summary** (entries
    1954–1958: boundary B preserving [03de,161d,cfae] anchor=summary
    700f; then prompt a3e6 with parentUuid=cfae (the preserved tail)
    BEFORE the summary 700f; a later prompt parents on 700f). Loader (with
    the anchor in the prefix): `[700f, block, a3e6]`. Tree: a3e6 arrived
    while B's block was still pending its anchor, so buildTree rooted it
    (`names no tree occurrence`) — contextAt = `[a3e6]`. Fix candidates:
    defer rows whose parent is a pending block row until the block
    flushes (bounded like the block), or accept as a divergence.
  - **B. Compaction during an in-flight turn** (5267–5292: prompt 8943 +
    attachment acd4, THEN boundary preserving [802c,492f,7e1f] (8943/acd4
    cut, not preserved), summary 8a6b, caveat; then the assistant turn
    452c→7867→be49 parented on acd4 — the cut attachment). Loader applies
    its "surviving turn whose parent was cut → attach to the preserved
    tail" rule (loader.ts `parentOf`, commented "should never happen"):
    `[8a6b, block, 452c, 7867, be49]`. Tree keeps raw parents: 173-entry
    pre-boundary history. This shape DOES happen (305 prefixes here).
    Fix candidate: context tree rule "raw row whose raw parent precedes
    the latest boundary and is not preserved by it → parent = that
    boundary's block tail" (rolling: needs only the latest boundary's
    preserved set + cut position); display follows. Whether the binary
    really reattaches (vs. drops) is per FINDINGS §2 leaf/walk — verify
    before implementing.
- DECISIONS (Anton, 2026-09-06): **A — defer**: buildTree must hold
  rows whose parent is a pending block row until the block flushes (also
  fixes the crash `clauctl format tree --filter raw 474b3175…` →
  "treeLines: row a3e6… precedes its parent cfae…@71e7…"). **B — dig
  in before modeling**: Anton's read is that 8943 ("Let's implement it.")
  was queued during `/compact` and is chronologically BEFORE the boundary,
  so it should be cut, not a "surviving turn"; the only hint it belongs
  in context is that it follows the boundary's logicalParentUuid 7e1f.
  Investigate what the binary does (evidence: the assistant turn 452c's
  content/timestamps — did it see the prompt?), update FINDINGS, then
  decide the tree rule. Reproduce with
  `sed -n '5250,5300p;5300q' <file> | clauctl format tree --filter raw`
  and `… | clauctl format entries`.
- B evidence gathered (not yet acted on): timestamps put the prompt
  8943 AFTER the boundary (boundary 15:02:57.900, summary .899, prompt
  and attachment 15:02:58.160, assistant 452c 15:03:02.260) even though
  it sits two lines BEFORE the boundary in the file — the queued prompt
  was written by a path that raced the boundary write. The assistant
  turn 452c acted on it (its first tool call reads implement.md), so
  live the context was `[summary, block, 8943, acd4, 452c…]`; on a
  file-based resume the prompt is cut (pre-boundary line, not
  preserved) and the loader's reattach rule keeps the turn without its
  prompt. Which of those the tree should model is the open question;
  FINDINGS §2 needs this shape ("queued prompt races the boundary
  write") recorded either way.
- **A DONE** (2026-09-06): `buildTree` defers a raw row whose effective
  parent is a pending block row (or a row already deferred behind one)
  into that block's list (`pendingBlockOf` key → block) and flushes the
  list in order when the anchor arrives (or at end of file). 474b3175:
  788 → 305 mismatches (all class B); `format tree --filter raw` on it
  no longer crashes (from source — the installed `clauctl` runs a stale
  `dist/`). Behavior change on the corrupt dangling-anchor shape: a row
  under a pending block row now flushes with the block at end of file
  instead of rooting (build-tree.test.ts updated); session-tree.md
  buildTree contract updated.
- Anton on B: the loader's cut must be either timestamp-based or "delete
  everything at and before logicalParentUuid" (he prefers the latter as
  a model); investigate what the binary actually does next.
- **B investigated** (2026-09-06, binary 2.1.258 relink `Nns`, just
  before the `tengu_relink_walk_broken` string): the cut is by FILE
  POSITION — map index `< lastBoundaryIdx && !preserved` — neither
  timestamp nor logicalParentUuid; and "surviving user/assistant whose
  parentUuid was cut → parentUuid = uuids.last()" is a general rule.
  `loadedContext` already matches; its "should never happen" comment
  replaced. Recorded in FINDINGS §1 (two new sub-bullets). Resumed
  context for the shape: `[summary, block, 452c, 7867, be49]` — the
  answer without its question. PROPOSED tree rule (not yet agreed): in
  `toContextTree` (display follows the context tree's relation; the raw
  view keeps the file's parents), a raw row whose full-tree parent is a
  raw row placed before the latest boundary and not preserved by it →
  parent = that boundary's block tail (the anchor for a wipe). Needs a
  row-position lookup (one index map over the full-tree order, or the
  boundary's position + a per-row index); bounded per boundary.
- Review round 84d04ec (three TDCs on the deferral) addressed: the
  second map is now `deferredAnchorOf: row key → anchor uuid` (was
  key → block array), `flushBlock(anchorUuid)` owns both deletes, the
  first-wins comment covers deferred keys too.
- B clarified for Anton: `452c` reattaches onto `7e1f@B` (the playlist
  tail); the caveat chain 5272–5282 (parented on the summary = anchor)
  also moves onto the tail by the anchor-child rule and is an unwalked
  sibling branch. "Let's implement it." is absent from the resumed
  context.
- **B DECIDED (2026-09-07): not modeled.** Live experiment on 2.1.258
  (queued prompt during `/compact`, debriefed post-compaction, then
  rewound): the prompt is dequeued after the boundary/summary/preserved/
  caveat-chain writes and chains onto them — live, file, and resume
  agree. The 474b3175 shape is a 2.1.195 write race; assume upstream
  keeps resume == live. Anton also wants `buildTree` to stay raw + relink
  only (`format tree --filter raw` as a file-inspection tool; later
  `--filter all --raw`). Recorded in FINDINGS §1.
- 2dafe15d (2.1.220): 429 mismatches, a third race variant — the queued
  prompt lands AFTER the boundary line with a cut parent; the loader
  reattaches it onto the tail (matches live). Anton: not worth modeling
  for pre-2.1.258 files; keep the simpler rule. Recorded as an Edge case
  ("Queued-prompt races in pre-2.1.258 files").
- 3316da5 TDC addressed: `presentedOrder` routes rows through
  `ToolGroup.push` (assistant continuations go straight to the presented
  list, the group's own results are buffered and sorted at group end).
- Reviewer round (agent a2af8780, 2026-09-07) addressed: id-less
  assistants classified by `ToolGroup` (constructor → `admit`, test);
  call entries excluded only when none of their calls is answered
  (matches the sanitizer's `every`); boundaries never deferred in
  `buildTree`; uuid-less rows yield settled prefixes; no seen-set for
  anchors (comment explains why); builder doc comments trimmed to
  contracts; stale spec references fixed. Approved; presubmit green.

- Observed 2026-09-07 on this session's file: a rewind boundary written
  by today's `set-context` renders its block as a `~` fork from the
  `/compact` stdout row on — the legacy user/assistant-filtered playlist
  skips the attachments that follow the stdout, so strict matching stops
  there. Expected per the "Legacy clauctl boundaries" Edge case; phase C
  writes the full loaded context and stops producing the shape.

### Rewind summary (paste in place of the phase-B report)

Phase B implemented and iterated through Anton's TDC rounds 48536d3,
c767566, e2c62f8, 6aa4079, 0053ee2, 3316da5, 84d04ec and a fresh-context
reviewer round; every decision is recorded above in this WORK LOG. Final
shape: `buildTree` = raw rows + relink only (rows parented on a pending
block row are deferred behind it; boundaries never deferred);
`toContextTree(fullTree, byUuid)` one pass with `ToolGroup` (one active
group; same-id assistants and answering results parent onto the previous
group row; rows ending or following a group keep raw parents; `excluded`
= dead call entries, orphan results, thinking-only without survivor);
`toDisplayTree(fullTree, contextTree, byUuid)`; `context-check.ts`
(settled prefixes, `presentedOrder` per-group result canonicalization) +
`scripts/check-context-at.ts`. Criterion 1 is "presents the same
context" (group results order-insensitive). Documented divergences: group
order canonical not the loader's; late fork off a mid-group result; pre-
2.1.258 queued-prompt races (2.1.195 pre-boundary, 2.1.220 post-boundary
with a cut parent — loader cuts/reattaches, tree keeps raw parents;
verified on 2.1.258 by a live experiment that live == file == resume).
Binary facts learned: the relink cut is by file position (FINDINGS §1);
the reattach-to-tail rule is general. Verification: 7fdff629 0/10382
mismatches; 474b3175 and 2dafe15d only the legacy race classes. Suite
617/617, presubmit green. Committed by Anton as phase B. Next: phase C
(`set-context --rewind-to X <uuids…>`) as ONE commit after explicit
go-ahead. Decisions taken before the rewind: the playlist is
`contextAt(X)` from the context tree (attachments included, `excluded`
already dropped) followed by the appended uuids; the boundary's
`logicalParentUuid` is set structurally — the uuid of the branch point
`matchPreservedList` finds for that list against the pre-boundary tree
(typically X; the last matched row when the appends continue X's
existing children); `--anchor` and the user/assistant playlist filter go
away. Later: tier (b) intercepting oracle, `tests/sdk/` guard, remove
the AGENTS.md one-pass bullet once the rolling builder lands, and the
`--filter all --raw` CLI change Anton wants for `format tree`.

## 2026-09-07 — phase C implemented (uncommitted; one commit)

Per Anton's plan approval. `set-context --rewind-to X [uuids…]` is sugar
for the explicit list `contextAt(X) ++ uuids`; the no-write
`resumeSessionAt` path, the `filterTail` override, `logicalTipOverride`,
`freshOverride`, `--anchor`, and `restartQuery`'s second argument are
deleted; every boundary we write gets a structural `logicalParentUuid`
(bare uuid of `matchPreservedList`'s branch point). Files: sdk-socket.ts, sdk-commands.ts,
session/file.ts, daemon/set-context.ts, daemon/get-messages.ts,
daemon/request-handlers.ts, daemon/daemon.ts, tui/components/tree-selector.ts,
tree/nodes.ts + options.ts comments; tests in request-handlers.test.ts
(no-write tests → boundary-writing tests; new: rewind-and-append,
`turn_duration` on the rewound context, structural parents after a rewind
including the no-match → null case, viaBoundary errors), display-tree.test.ts
(native `/compact` after a tail-rewind boundary), file.test.ts (from-shape
test deleted), sdk-socket.test.ts (`append` parsing). Docs: this spec's
Phase C sections; session-tree-and-set-context.md superseded passages
marked; README usage. Presubmit green, 617/617.

### Implementation-Time Decisions

- `logicalParentUuid` matching uses `hidden = ∅`: the daemon builds no
  display tree, so a branch point the display would hide is still the
  structural parent. It is recorded as a bare uuid because the field is the
  CLI's uuid-typed format; the display tree re-derives the exact occurrence
  (`6@B` when the list branches off a relinked row) from the list.
- The empty-list wipe now gets `logicalParentUuid: null` (previously the
  active tip): nothing matches, so it is a new root — consistent with the
  spec's criterion 4 and the display tree's own placement.
- `X@B` validation is `contextAt`'s: a bad `viaBoundary` or a uuid not in
  that boundary's block throws "is not a context-tree occurrence"; the
  bespoke "does not name a compact_boundary" / "not on the context chain"
  errors are gone with the installed-chain computation.
- `GetMessagesOverride` collapsed to `{ chain, installedAtLeaf }` (no
  `kind`): only the synthesize variant remains.
- `restartQuery(resumeSessionId)` is single-argument; `options.ts` keeps
  `resumeSessionAt: "respawn"` — it is a `keyof Options` bucket entry, not
  a use.
- Review round 70ab34e: the rewind target checks (assistant, final entry
  of its API message) and the post-restart verification were deleted
  (rationale in Type design); `rewindPlaylist`/`logicalParentOf` inlined.
- The daemon builds `buildTree` → `toContextTree` per set-context request;
  a rolling `tail -f` builder is the follow-up spec Anton described.
