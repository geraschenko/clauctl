# Spec: context tree and explicit-playlist boundary display

> Status: **spec written, awaiting review** (2026-09-02). Phases B and C of
> the tree-presentation effort; phase A (renderdag rendering) is
> `docs/specs/tree-presentation.md` and is implemented first. Phase B is
> display-only; phase C changes `set-context`. The "round" references in this
> file are the derisk discussion rounds summarized in the WORK LOG.

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

1. `toContextTree(buildTree(F), F).contextAt(tip)` equals
   `loadedContext(F[..k])` for `tip = loadedContext(F[..k]).at(-1)`, for
   every fixture `F` and every prefix length `k` whose tip is a turn end
   (not a tool call whose results arrive later in `F`; the loader judges
   such a call dead in the prefix but alive in the file — see Edge cases).
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
7. `set-context --rewind-to X a b` writes the same boundary and verifies
   the same context as `set-context <ctx(X) uuids…> a b`. Every rewind
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
   *  full-tree parent with each parallel tool group linearized in
   *  first-occurrence file order (today's display rule 4 — non-first group
   *  members parent onto their predecessor, an outside child of a group
   *  tool_result parents onto the group's last element), and null where
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
  readonly excluded: ReadonlySet<string>;

  constructor(parentMap: ParentMap, excluded: ReadonlySet<string>);

  /** The assistant context with `ref` as the tip: the parentMap path
   *  root-first to ref, minus excluded occurrences. A straight walk —
   *  group linearization is in the relation and sanitization is
   *  `excluded`. viaBoundary on each element as the loader sets it. Throws
   *  on a ref absent from parentMap. */
  contextAt(ref: TreeNodeRef): TreeNodeRef[];
}

/** Precondition: fullTree came from buildTree over `entries`. Calls
 *  linearizedGroupParents (moved here from display-tree.ts, unchanged
 *  semantics) and toolGroupMaps; excluded is computed once from entries. */
export function toContextTree(
  fullTree: ParentMap,
  entries: SessionEntry[],
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
  materialized: ReadonlySet<string>,
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
  entries: SessionEntry[],
): DisplayTree;
```

`DisplayTree` (class: `parentMap`, `nearestVisibleRow`) is unchanged.
Deleted from this file: rule 4 (`linearizedGroupParents` moves to
context-tree.ts; the context relation is already linearized) and rule 3
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

`handleRewind(rewindTo, append, context)` — rewind is sugar for an
explicit list, so it reduces to the uuids path:

- desired = context at X (as today: `loadedContextUuids` of the prefix
  through X, or the installed-chain prefix for `X@B`) `++ append`;
- then exactly the uuids path: `normalizePreservedUuids` (rejection throws),
  `buildBoundaryEntries`, append, restart, `restartAndVerify(normalized)`,
  `added` reported. The `messageUuids` user/assistant filter is deleted.
- The no-write `resumeSessionAt` path is deleted with everything that
  exists only for it: the truncation test against the active chain, the
  `filterTail` kind of `GetMessagesOverride` (the `synthesize` kind and
  `installedAtLeaf` stay — they serve the boundary path),
  `logicalTipOverride` (derived only from a `filterTail` override), and
  `restartQuery`'s `resumeSessionAt` argument. The
  daemon leaf after a rewind is the file truth (`P.last@B`), as for any
  boundary.

### Phase C — `src/tui/components/tree-selector.ts`

`summaryChainUuids` returns the unfiltered chain.

### Deletions

- `display-tree.ts`: rule 4 and `linearizedGroupParents` (moved).
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
`{ rewindTo, append }` → daemon `handleRewind`: context at X `++ append` →
`normalizePreservedUuids` →
`buildBoundaryEntries` (up_to iff summary, never here) → append to file →
restart → `restartAndVerify(normalized)`. The written boundary then
displays through phase B as a pure rewind (`append` empty) or
rewind-and-append.

## Cost

- One extra `ParentMap` per tree build (O(occurrences)); the rule-4 pass
  moves from `toDisplayTree` to `toContextTree`, not duplicated.
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
  on. Hence the turn-end restriction in success criterion 1, and: a
  boundary listing such a path (prompt parented on the call with the
  results off-path) matches up to the entry before the call and displays
  as a fork. Not producible by clauctl once every rewind writes a boundary
  (the list then omits the call, and the next prompt parents on the
  block); documented for native files, not modeled.
- **Legacy clauctl boundaries** written with the user/assistant filter have
  gaps (attachments, `turn_duration`) relative to the context tree. Matching
  is strict — they display as forks with `~` rows. Deliberate: not worth
  complicating the tree for shapes phase C stops producing.
- **Property-test divergences** (`contextAt` vs `loadedContext` on corrupt
  fixtures, known from round 4): duplicate uuids (buildTree first-wins vs
  loader last-wins), invalid boundary (buildTree no-relink vs loader wipe),
  dangling parent. The test lists these fixtures by name with the reason;
  reconciling them is out of scope.
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
  cannot be a branch point) supplied by `toDisplayTree` through
  `isCandidate` — visibility of earlier occurrences is settled by the time
  a later boundary is matched, because boundaries are processed in
  materialization order.

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
  review: `isCandidate` parameter added (success criterion 5 needs
  visibility, which only `toDisplayTree` knows); `byUuid` parameter
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

- [ ] `context-tree.ts`: `ContextTree`, `toContextTree`,
      `linearizedGroupParents` moved, `matchPreservedList`
- [ ] `context-tree.test.ts`: property test over fixtures × prefixes,
      divergent fixtures listed; matching unit tests (examples above)
- [ ] `display-tree.ts`: forward-pass placement over the context tree;
      rules 3 and 4 deleted
- [ ] callers: `format/tree.ts`, `interactive-mode.ts` ×2
- [ ] docs: session-tree.md display rules, session-views.md (context view
      becomes the context tree)

## Phase C

- [ ] wire: `append`, `anchor` removed; `parseSetContextRequest`
- [ ] CLI: `--anchor` removed, positional uuids with `--rewind-to`,
      exclusivity
- [ ] `file.ts`: `buildBoundaryEntries` without `anchor`
- [ ] `set-context.ts`: `handleRewind` with `append` + normalize; filter
      removed; no-write path + `filterTail` override + `logicalTipOverride`
      + resume-at restart argument deleted
- [ ] test: tail-rewind boundary followed by native `/compact`
- [ ] `tree-selector.ts`: filter removed
- [ ] tests and docs (session-tree-and-set-context.md, README usage)
