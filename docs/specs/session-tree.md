# Spec: session tree — loader model, full tree, display tree

> Status: **draft, awaiting review.** Supersedes
> `docs/specs/boundary-display-linearization.md` (whose user-facing goals
> carry over, but whose mechanism was built on a guessed loader model) and
> rewrites the relink machinery from `docs/specs/boundary-substructure.md`.
> Ground truth: the CLI loader's relink logic, read directly out of the
> bundled binary (see "Ground truth" below).

# SPEC

## Problem

Our model of the CLI loader (`effective-chain.ts`) was reverse-engineered
from probe behavior and guessed wrong in places: it special-cases the
summary entry via `isCompactSummary`, invents a relinked summary occurrence
(`S@B`), composes all boundaries through a running occurrence map, and has
no notion of the loader's cut. `buildTree` inherited that confusion
(summary lookahead, pending-relink deferral), and the display layer then
needed compensating machinery (block-tail exceptions, exhaustive
representative maps, path deduplication).

We have since decompiled the loader's actual relink transform. This spec
rebuilds the whole domain on it, as three layers in `src/core/tree/`:

- **`loadedContext`** — what the model sees: our best estimate of the exact
  messages, in exact order, that a resume would load. A faithful port of
  the loader transform.
- **`buildTree`** — every occurrence: the full tree of all raw entries plus
  each valid boundary's relinked block. What `raw` filter mode shows; the
  superset every navigation target lives in.
- **`toDisplayTree`** — what the human sees: the full tree minus relinked
  duplicates and boundary forks, so a linear conversation with any number
  of compactions renders as one straight line.

## Ground truth: the loader's relink transform

Extracted from the Claude Code CLI binary v2.1.170 (Bun-compiled; the JS
bundle is embedded as plain text — `grep -a -o -b preservedMessages
<binary>` for offsets, then dump and read the surrounding minified source).
Re-extract the same way on CLI upgrades. The transform, applied to the
uuid→entry map (file order) at load time:

1. Let `K` = index of the **last** `compact_boundary` entry of any kind,
   and `meta` = the `compactMetadata` of the last boundary that has
   `preservedMessages` (or legacy `preservedSegment`). If no boundary has
   metadata, stop — no transform at all.
2. The relink rules run only when the metadata boundary IS the last
   boundary (last-wins is total). Resolve `preserved = {anchorUuid?,
   uuids}` (from the list, or a tail→head walk for `preservedSegment`).
3. If any preserved uuid names no transcript entry: telemetry, **abort the
   whole transform** (no rewrite, no cut).
4. If `uuids` is non-empty:
   - **Chain rewrite**: `uuids[0].parentUuid = anchorUuid`,
     `uuids[i].parentUuid = uuids[i-1]`.
   - **Anchor-child reparent**: EVERY entry with `parentUuid == anchorUuid`
     (except `uuids[0]`) gets `parentUuid = uuids.last()`. There is no
     summary concept: from-shape summary placement (anchor = boundary uuid,
     summary parented on the boundary) is just an instance of this rule.
     `isCompactSummary` appears nowhere in the transform.
   - Usage fields on preserved assistant entries are zeroed.
5. **The cut**: delete every entry with file index `< K` not in `uuids`
   (runs even when `uuids` is empty or the last boundary has no metadata —
   this is why an empty-`uuids` trailing boundary yields an empty context,
   P10). Then **orphan reparent**: surviving user/assistant entries whose
   parent was deleted get `parentUuid = uuids.last()` (only when `uuids`
   is non-empty).

6. **Leaf selection** (decoded from the transform's caller): collect
   entries that are nobody's parent in the TRANSFORMED relation; a single
   dangling tip is the leaf; with multiple tips — or when no relink ran —
   walk up from the last file entry (or an explicit leaf-marker entry) to
   the nearest user/assistant entry. No summary special-case: a file
   ending at an up_to summary has exactly one tip, the preserved tail,
   because the chain rewrite hangs `uuids[0]` under the summary.

The context a resume loads is then the ordinary `parentUuid` walk from
that leaf over the transformed map, boundaries acting as chain ends.

Caveats: binary v2.1.170 vs probes on v2.1.195/2.1.211 — every probe
observation in `docs/derisk/compact-boundary-injection/FINDINGS.md` is
consistent with this code except P3 m4's duplicate-uuid skip, which has no
visible check here (version drift, or downstream cycle detection). We keep
the duplicate-uuid validation, justified by the probe.

## Success criteria

1. `loadedContext` implements the five transform steps 1:1, auditable
   against the dump above.
2. A native up_to compaction of a linear conversation renders linearly
   (default filter modes) — see the concrete example below. Several
   stacked compactions render as one straight line.
3. A boundary rewind (from-shape, no summary) with no new turn is
   invisible: the tree reads identically to a plain tail rewind, cursor on
   the rewind target.
4. `raw` filter mode renders `buildTree` verbatim, `~` marking every
   `@boundary` row. Default modes never render an `@boundary` row, so `~`
   appears only in `raw` mode.
5. `/tree` picker rows are display rows. User-row picks resolve their
   nearest assistant ancestor on the FULL tree (editing a post-compaction
   message stays inside the compacted context). Boundary-row and
   summary-row picks are the same action, "undo the boundary": rewind to
   the last assistant ref of `loadedContext(entries before the boundary)`,
   `newRoot` if none, no editor prefill.
6. TUI conversation history renders the display path: each message once,
   boundary banners and summaries in display order — no dedupe pass.
7. The `[cursor: …]` line keeps printing the true leaf uuid; the `*`
   marker sits on the leaf's visible display row (they legitimately differ
   after a fresh compaction: marker on the summary row, cursor on the
   preserved tip).
8. Corrupt-file shapes report through `OnInvalid`; a duplicate occurrence
   key still throws loudly.

## Concrete examples

Up_to compaction (raw `1→2→3→4`, boundary `B` preserving `[3,4]`, anchor =
summary `S`, next turn `5` with `parentUuid: 4`):

```
raw mode                          default modes
• 1 user: …                       • 1 user: …
• 2 assistant: …                  • 2 assistant: …
├─ 3 user: …                      • 3 user: …
│     4 assistant: …              • 4 assistant: …
└─ • B [compaction]               • B [compaction]
   • S compaction: …              • S compaction: …
   • ~3 user: …                   * 5 user: …
   • ~4 assistant: …
   * 5 user: …
```

Full tree: `S` under `B` (raw parent), `3@B` under `S` (chain rewrite),
`4@B` under `3@B`, `5` under `4@B` (last-boundary lens). Display: hide
`3@B`/`4@B`, reparent `B` onto raw `4`; `5`'s nearest visible ancestor is
`S`. Display order shows `S` after `3,4` although the loaded context is
`[S,3,4,5]` — accepted display fiction; `raw` mode has the truth.

From-shape rewind to `2` (boundary `X` preserving `[1,2]`, anchor = `X`
itself, summary `T`, then one new turn `5` with `parentUuid: T`):

```
default modes
• 1 user: …
• 2 assistant: …
├─ • X [compaction]
│  • T compaction: …
│     * 5 user: …
└─ 3 user: …
      4 assistant: …
```

Full tree: `1@X` under `X`, `2@X` under `1@X`, `T` under `2@X`
(anchor-child rule — `T`'s single occurrence is raw), `5` under `T`.
Display: hide `1@X`/`2@X`; `X` reparents onto raw `2`; `T`'s nearest
visible ancestor is `X`.

Same rewind with NO summary and NO new turn: `X` has no visible
descendants and prunes away; the tree reads `1 → *2 → 3 → 4` —
indistinguishable from a plain tail rewind. The leaf ref `2@X` maps to
visible row `2` for the marker.

## Type design

New directory `src/core/tree/`. `src/core/tree.ts`, `build-tree.ts`,
`build-display-tree.ts`, and `effective-chain.ts` are deleted; their
survivors move as noted.

**`src/core/tree/nodes.ts`** — the node vocabulary, moved verbatim from
`src/core/tree.ts`: `TreeNodeRef`, `formatTreeNodeRef`, `parseTreeNodeRef`,
`treeNodeRefsEqual`, `ParentMap` re-export, `SessionSnapshot`, `PathNode`,
`pathToLeaf`, `treeChildren`, `isFinalAssistantEntry` (doc comments updated
to the new names).

**`src/core/tree/loader.ts`** — the loader model. Owns every relink rule.

```ts
/** Sink for corrupt-session-file diagnostics. */                 // moved from effective-chain.ts
export type OnInvalid = (message: string) => void;

/** A compact_boundary entry's relink instruction, mirroring the jsonl
 *  field names. preservedMessages absent = no metadata (legacy
 *  segment-only boundaries resolve their segment walk into uuids here,
 *  or come back absent when the walk breaks). */
export interface CompactBoundary {
  uuid: UUID;
  preservedMessages?: { anchorUuid?: UUID; uuids: UUID[] };
}

/** Parse + validate the boundary at entries[boundaryIndex]. Validation
 *  (loader-observed): every uuid names an earlier entry, no duplicates —
 *  violations report via onInvalid and come back with preservedMessages
 *  absent (the loader aborts its transform). Empty uuids is VALID (a pure
 *  wipe — rules no-op, the cut still applies). */
export function compactBoundaryAt(
  entries: SessionEntry[],
  boundaryIndex: number,
  onInvalid: OnInvalid,
): CompactBoundary;

/** Loader parent rewrite for an entry at/after the boundary:
 *  parentUuid == anchorUuid (and uuids non-empty) → uuids.last();
 *  otherwise the raw parentUuid. THE anchor-child rule — the only place
 *  it is written. */
export function effectiveParent(
  boundary: CompactBoundary,
  entry: SessionEntry,
): UUID | undefined;

/** Parent of uuids[index] inside the relinked chain: anchorUuid for
 *  index 0, uuids[index-1] after. THE chain-rewrite rule. */
export function preservedParent(
  boundary: CompactBoundary,
  index: number,
): UUID | undefined;

/** Our best estimate of the exact messages, in exact order, that a resume
 *  would load: the ground-truth transform (last-boundary rules via
 *  effectiveParent/preservedParent, the cut, orphan reparent), then the
 *  parent walk from the leaf per ground-truth step 6 (single dangling
 *  tip, else nearest user/assistant at-or-above the last file entry).
 *  Replaces effectiveTreeNodeChain. An element carries viaBoundary iff
 *  its uuid is among the last boundary's preserved uuids. */
export function loadedContext(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): TreeNodeRef[];

/** Uuid projection of loadedContext. Replaces effectiveChain. */
export function loadedContextUuids(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): UUID[];
```

Deleted with no replacement: `summaryOf`, `BoundaryRelink`, `validRelink`.
`seedFromEntries` moves to `src/core/session-seed.ts` unchanged except for
calling `loadedContext`.

**`src/core/tree/full-tree.ts`**

```ts
/** Every occurrence: raw entries under their last-boundary-lens parents
 *  (effectiveParent, decorated to `uuid@B` keys when the parent uuid is
 *  among the lens boundary's preserved uuids), plus each valid boundary's
 *  relinked block `uuids[i]@B → preservedParent(i)` emitted at the
 *  boundary's file position (an up_to anchor key is a forward reference
 *  that resolves when the anchor entry arrives; a final pass nulls
 *  dangling parents — corrupt files only). Boundary entries anchor at
 *  logicalParentUuid. Exactly one raw occurrence per uuid-bearing entry —
 *  no occurrence map, no pending state, no summary special case. Throws
 *  on a duplicate occurrence key. */
export function buildTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): ParentMap;
```

`buildTree` calls `compactBoundaryAt`, `effectiveParent`, and
`preservedParent`; it restates no rule.

**`src/core/tree/display-tree.ts`**

```ts
export interface DisplayTree {
  /** Visible rows only. */
  parentMap: ParentMap;
  /** Hidden occurrence id → its nearest visible ancestor row. Defined for
   *  every hidden id (relinked rows, pruned boundary rows). Sole purpose:
   *  mapping a hidden leaf ref to the row that carries the `*` marker /
   *  picker cursor. Picker rows themselves are all visible. */
  visibleRowOf: Map<string, string>;
}

/** The human view, derived from the full tree by three rules:
 *  1. each boundary row with a non-empty preserved list reparents onto
 *     the raw row of its last preserved uuid;
 *  2. every `@boundary` row is hidden; anything whose parent is hidden
 *     displays under its nearest visible ancestor;
 *  3. a boundary row with no visible descendants is hidden too
 *     (fixpoint, so stacked navigation boundaries cascade away).
 *  Boundaries without a valid relink keep their placement and stay
 *  visible. Display-only: loadedContext and the wire protocol are
 *  untouched. */
export function toDisplayTree(
  fullTree: ParentMap,
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): DisplayTree;
```

Taking `fullTree` as input keeps the derivation explicit at call sites and
makes the transform testable against hand-built maps. It re-parses
boundaries via `compactBoundaryAt`; call sites whose adjacent `buildTree`
call already reported diagnostics pass a silent sink.

**Consumers** (signatures, not implementations):

- `src/format/tree.ts`: `raw` stays in `FILTER_MODES`; `raw` renders
  `buildTree` output with `~` before the uuid column on `@boundary` rows;
  all other modes render `toDisplayTree(buildTree(...), ...)` with the
  leaf marker mapped through `visibleRowOf` when the leaf row is hidden.
- `src/tui/components/tree-selector.ts`: `TreeSelectorComponent` takes the
  `DisplayTree`; `resolveTreePick(fullTree, entries, entryOf, pick,
  onInvalid)` implements criterion 5 (boundary/summary undo via
  `loadedContext(entries.slice(0, boundaryIndex))`; summary rows
  identified for the pick action by `isCompactSummary` + boundary parent —
  a UX affordance, not loader modeling).
- `src/tui/interactive-mode.ts` / `sdk-render.ts`: `reloadHistory` renders
  `pathToLeaf(displayTree.parentMap, entryOf, visibleLeafRow)`;
  `dedupedPathNodes` is deleted (a display path has no duplicates by
  construction); `pathUpToBoundary` adapts to display rows (replay cut at
  the live leaf's visible row; keep post-leaf boundary/summary rows, whose
  live events render no text).

## Data flow

```
entries ──compactBoundaryAt──► CompactBoundary (per boundary)
   │                                │
   │        ┌── effectiveParent / preservedParent (the rules, written once)
   │        ▼                       ▼
   ├──► loadedContext ──► daemon (set-context, get-messages, seed, rewind targets)
   │        (model view: transform + walk)
   │
   └──► buildTree ──► ParentMap (full) ──► raw mode; picker pick resolution
                          │
                          └──► toDisplayTree ──► DisplayTree ──► default
                               tree rendering; picker rows; history path
```

## Cost

- Compute/memory: every layer is O(n) single-pass with small maps —
  negligible at session-file scale.
- The real cost is **regression surface**: this rewrites the shipped
  `effective-chain.ts`/`build-tree.ts` semantics and discards most of the
  uncommitted boundary-display-linearization implementation. Mitigations:
  test fixtures re-derived from the ground-truth transform; the derisk
  harness + `check-reports.mjs` remain the CLI-upgrade gate. Review effort
  should concentrate on `loader.ts`'s fidelity to the dump.

## Edge cases

- **Empty `uuids`**: valid; rules no-op (children of the anchor stay put),
  the cut still deletes everything before the boundary (P10).
- **Missing preserved uuid / duplicate uuid**: `preservedMessages` absent
  after validation; the boundary emits no block, stays at its
  logicalParentUuid anchor, and remains visible.
- **Up_to anchor entry never arrives** (corrupt): the block's forward
  anchor reference dangles; the final `buildTree` pass nulls it (block
  becomes a root fork), `onInvalid` reports it.
- **Entry parenting into an earlier boundary's preserved region** after a
  later boundary exists: raw parent (the last-boundary lens knows nothing
  of earlier boundaries) — matches the loader's last-wins, diverges from
  the old occurrence-composition behavior. Native files never produce
  this shape.
- **Boundary whose logicalParentUuid is absent/unknown**: root, as today.
- **From-shape summary refs lose `viaBoundary`**: the summary is no
  longer in the relinked list, so a fresh from-shape context tip is the
  bare summary ref (previously `S@B`). Wire-visible leaf-shape change;
  consumers only compare refs structurally, but this must be verified at
  the fold/seed boundary during implementation.
- **Non-goals**: modeling the loader's usage-zeroing; segment-only
  (`preservedSegment`) boundaries beyond what `compactBoundaryAt`'s
  validation already implies (they stay unmodeled as relinks — current
  behavior); any wire-protocol or set-context change.

# IMPLEMENTATION IDEAS

- Port `loader.ts` first, with tests transliterated from the decompiled
  steps (each step = a describe block citing the dump). Then `full-tree.ts`
  against the same fixtures, then the display transform, then consumers.
- `loadedContext` can implement the transform without mutating entry
  copies: compute the last boundary's `CompactBoundary`, then walk from
  the tip using `effectiveParent`/`preservedParent` as overrides, tracking
  the cut set for orphan reparenting. Whichever formulation stays closest
  to auditable-against-the-dump wins; a literal map-rewrite port is
  acceptable if clearer.
- Tip selection is ground-truthed (step 6) — the dangling-tip analysis
  replaces the current `summaryOf`-based special-casing outright. Verify
  against the existing effective-chain test fixtures that outcomes match
  on native shapes before deleting the old code.
- `reloadHistory`'s raced-leaf fallback (leaf ref in neither `parentMap`
  nor `visibleRowOf`): keep today's semantics — warn and replay the full
  path — expressed in display rows.
- Nearest-visible-ancestor + pruning can be one bottom-up pass over the
  display parent relation; no fixpoint queue machinery needed if rows are
  processed in materialization order (children after parents).

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [ ] `src/core/tree/` scaffolding: move `nodes.ts`, port `loader.ts` with
      dump-cited tests
- [ ] `full-tree.ts` + tests (native shapes, stacked boundaries, corrupt
      shapes)
- [ ] `display-tree.ts` + tests (success criteria 2, 3, and the examples)
- [ ] Consumers: `format/tree.ts`, tree-selector, reloadHistory; delete
      `dedupedPathNodes`, `summaryOf`, `validRelink`, old modules
- [ ] Presubmit + full test suite

## 2026-07-22 — spec created

Written after decompiling the loader's relink transform from the bundled
CLI binary (v2.1.170), which invalidated the previous model
(`isCompactSummary` special-casing, `S@B` occurrences, occurrence
composition across boundaries). Supersedes
`docs/specs/boundary-display-linearization.md`; the uncommitted
implementation of that spec is largely discarded by this one.
