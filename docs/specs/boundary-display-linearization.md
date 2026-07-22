# Spec: boundary display linearization

> Status: **spec approved, not yet implemented.** From
> `docs/thoughts/boundary-messages.md`. Follow-up to
> `docs/specs/boundary-substructure.md` (which made `buildTree` emit relinked
> occurrences) and `docs/specs/format-tree.md`. Display-layer only:
> `buildTree`, `effectiveTreeNodeChain`, `set-context` semantics, the wire
> protocol, and `format messages` are untouched.

# SPEC

## Problem

`buildTree` emits one occurrence per raw entry plus, for each valid-relink
boundary, relinked duplicate occurrences (`uuid@boundary`) chained under the
boundary block. All display surfaces render that structure verbatim:

- **`format tree` / TUI `/tree` picker**: every compaction forks the tree —
  the boundary anchors at `logicalParentUuid` (for up_to shape the last
  *summarized* entry, not the context tip) while post-boundary messages
  chain through the relinked duplicates — and preserved messages render
  twice. A long conversation with several compactions renders as a ladder
  of forks and duplicated blocks instead of the linear conversation it
  logically is.
- **TUI conversation history** (`reloadHistory` path replay): for from-shape
  boundaries (rewinds, `set-context --summary --anchor boundary`) the
  preserved uuids lie on the pre-boundary displayed path, so the preserved
  messages render twice — once in raw history, once below the banner.

## Definitions

- **Raw occurrence**: the tree node at an entry's `parentUuid` placement
  (id `uuid`). **Relinked occurrence**: the duplicate `buildTree` emits for
  a preserved uuid (id `uuid@boundary`).
- **Boundary block**: a boundary entry plus its summary entry (if any).
  **Block tail**: the summary row when present, else the boundary row.
- **Valid relink** (existing `validRelink` semantics): `preservedMessages`
  present, `uuids` non-empty, no duplicates, all naming earlier entries.
  Boundaries without one (legacy segment-only, empty `uuids`, corrupt
  lists) still cut the loader's context; they merely have no relink.
- **Display tree**: the linearized parent relation defined below, rendered
  by every filter mode except `raw`.

## Desired behavior

### Display tree construction

1. Relinked occurrences are hidden; a message's single row is its raw
   occurrence. Exception: a from-shape summary's only occurrence is
   relinked — it stays, as the block tail row, keeping its `@boundary` id.
2. A valid-relink boundary displays anchored at the **display
   representative of `occurrenceOf(lastPreservedUuid)` as of just before
   its own relink** (buildTree's running-map notion, so stacked boundaries
   compose: if the last preserved uuid was itself relinked by an earlier
   boundary, the anchor resolves through that boundary's block).
3. A child of a hidden relinked occurrence attaches to that boundary's
   **block tail**, resolving transitively until a visible row. So for an
   up_to compaction of `1→2→4→5` preserving `[4,5]` with summary `S`, the
   next message `7` (raw `parentUuid: 5`) displays under `S`.
4. **Block edges**, explicitly: the boundary row's display parent is its
   resolved anchor (rule 2); the summary row's display parent is the
   boundary row in BOTH shapes (for from-shape that row is the relinked
   `S@boundary` occurrence); hidden relinked occurrences map to the block
   tail (rule 3).
5. **Hidden boundary**: a summary-less boundary with no displayed
   descendants is hidden entirely; anything resolving to it (leaf marker)
   falls through to its display anchor. Once any occurrence follows the
   boundary, it appears (fork at the true divergence point). "Displayed
   descendants" is evaluated on the unfiltered display tree and counts
   every retained occurrence type, not just messages. The rule is a
   fixpoint — evaluated after hiding — so N stacked message-less
   navigation boundaries (each anchored on the previous) all disappear and
   the tree reads as one plain rewind, marker on the final target.
6. Boundaries **without a valid relink** keep their current placement
   (`logicalParentUuid` anchor) and are always visible — the loader still
   honors them as context cuts, and they produce no duplicates today.
7. **Leaf marker**: when the current leaf is a hidden occurrence, `*` lands
   on its representative (block tail; through a hidden boundary, its
   anchor). The `[cursor: …]` line keeps printing the true leaf uuid — the
   marker means "next turn attaches here", so marker row and cursor uuid
   can legitimately differ (fresh up_to compaction: marker on `S`, cursor
   `5`). A filter that hides the representative row leaves the marker
   absent, matching existing filtered-leaf behavior.
8. **`~` marking**: every rendered row whose occurrence id carries
   `@boundary` is marked, in ALL modes (not an option): `~` sits
   immediately before the uuid column — `treePrefix + marker + "~" +
   uuid8 …` — and immediately before the summary text when the uuid column
   is omitted (picker rows). In default view the only such rows are
   from-shape summaries.
9. **`raw` filter mode** (new `FilterMode`): `buildTree`'s output verbatim —
   no hiding, no re-anchoring, every occurrence `buildTree` emits shown
   (passes-filter = true; entries without uuids have no tree occurrence in
   any mode), `~` on relinked rows. The faithful debugging view.

### Concrete examples

Up_to compaction (raw `1→2→4→5`, boundary `B` `logicalParentUuid: 2`
preserving `[4,5]`, summary `S`, next turn `7` with `parentUuid: 5`):

```
before                            after (default modes)
• 1 user: …                       • 1 user: …
• 2 assistant: …                  • 2 assistant: …
├─ 4 user: …                      • 4 user: …
│     5 assistant: …              • 5 assistant: …
└─ • B [compaction]               • B [compaction]
   • S compaction: …              • S compaction: …
   • 4 user: …        (relinked)  * 7 user: …
   • 5 assistant: …   (relinked)
   * 7 user: …
```

(The "before" column is today's output; after this spec, that topology is
`raw` mode's, where the relinked rows additionally carry the new `~`
prefix.)

Display order shows `S` after `4,5` although the loaded context is
`[S,4,5]` — accepted display fiction; `raw` mode has the truth. Several
compactions of a linear conversation render as one straight line.

Boundary rewind to `2` (boundary `X` preserving `[1,2]`,
`logicalParentUuid: 5`), then one new turn `7`:

```
after (default modes)
• 1 user: …
• 2 assistant: …
├─ • X [compaction]
│     * 7 user: …
└─ 4 user: …
      5 assistant: …
```

Same rewind with NO new turn: `X` is hidden; the tree reads
`1 → *2 → 4 → 5` — indistinguishable from a plain tail rewind, cursor at 2.

### `/tree` picker

- Rows come from the display tree; row identity is literal — the row for
  `5` IS raw occurrence `5`, and picking it rewinds to pre-compaction
  context (deliberately undoing the compaction; that is the expected
  meaning of navigating to the last pre-compaction message).
- User-row picks resolve their nearest assistant ancestor on the **full**
  tree, unchanged — picking post-compaction user `7` resolves to `5@B`, so
  editing a post-compaction message stays inside the compacted context.
- **Behavior change** — boundary AND summary picks are the same action,
  "undo the boundary": resolve to the last assistant ref on
  `effectiveTreeNodeChain(entries before the boundary)` — the true
  pre-boundary context tip, correct even when that tip is a relinked
  occurrence of an older boundary. No assistant on that chain → `newRoot`.
  Neither carries `editorText` (today a summary pick prefills the editor
  with the full summary text via ordinary user-row handling — dropped).
  (Today's boundary resolution walks raw ancestors from
  `logicalParentUuid`, which for up_to shape lands on the last summarized
  entry and silently drops the preserved tail.)
- A malformed summary row (`isCompactSummary` whose parent is not a
  boundary — corrupt or hand-crafted file) falls back to ordinary user-row
  pick semantics.

### Conversation history (TUI transcript replay)

- A replayed path node with `viaBoundary` set whose uuid already rendered
  earlier in the same replay is skipped. The replay keeps its own
  seen-uuids set covering EVERY uuid-bearing path node it renders — the
  existing `replayed` set is insufficient (it feeds live-event dedupe and
  excludes entries `entryToSessionMessage` rejects, e.g. `local_command`
  system entries, which `appendPathNode` nevertheless renders).
- Boundary banners and summary entries still render; the pre-boundary
  logical path (including a rewind's abandoned tail) still renders.
  Preserved messages appearing on the path only as relinked occurrences
  are unaffected by the dedupe and render once. The dedupe is per-uuid,
  not per-shape: it also covers hand-crafted up_to boundaries whose
  `logicalParentUuid` lies inside the preserved tail (raw and relinked
  occurrences then share the path), not just from-shape.

## Type design

**`src/core/build-display-tree.ts`** (new sibling of `build-tree.ts`;
shares `validRelink`/`summaryOf` from `effective-chain.ts`; if
implementation surfaces genuinely shared replay logic between the two
builders, restructure both into `src/core/build-tree/` with the shared
logic in a third file there):

```ts
export interface DisplayTree {
  /** Linearized parent relation per the display-tree rules above. */
  parentMap: ParentMap;
  /** Hidden occurrence id → visible display row id. Exhaustive: one entry
   *  for every omitted relinked occurrence and every hidden boundary row;
   *  values are transitively resolved AFTER the hidden-boundary fixpoint
   *  and are always keys of `parentMap`. For leaf-marker mapping. */
  representativeOf: Map<string, string>;
}

export function buildDisplayTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): DisplayTree
```

Built by its own forward replay, not as a post-transform of `buildTree`
output: the re-anchor target is the running `occurrenceOf` state
mid-replay, which the finished `ParentMap` alone does not retain —
recovering it would mean replaying the entries anyway.

**`src/format/tree.ts`**:

```ts
export const FILTER_MODES =
  ["conversation", "no-tools", "user-only", "all", "picker", "raw"] as const;
```

- `passesFilter`: `case "raw": return true`.
- `formatTreeNodeLine`: signature unchanged; unconditionally prefixes `~`
  when the row id carries `@boundary`.
- `formatSessionSnapshot`: signature unchanged; `filter === "raw"` →
  `buildTree`, all other modes → `buildDisplayTree` with
  `currentLeafId = id in display map ? id : representativeOf.get(id) ?? null`.
  One tree built per invocation, never both.

**`src/tui/components/tree-selector.ts`**:

```ts
export function resolveTreePick(
  parentMap: ParentMap,                      // FULL tree
  entries: SessionEntry[],                   // NEW: boundary-undo chain
  entryOf: ReadonlyMap<UUID, SessionEntry>,
  pick: TreeNodeRef,
  onInvalid: OnInvalid,                      // NEW: effectiveTreeNodeChain's
                                             // corrupt-file diagnostics
): TreePickAction

// constructor swaps the full map for the display tree:
constructor(leaf, displayTree: DisplayTree, entryOf, onSelect, onCancel)
```

The component holds the display tree ONLY: rows, `applyFilter`,
`nearestVisibleIndex`, and `collectFinalAssistantIds` all run on
`displayTree.parentMap`; `currentLeafId` maps through `representativeOf`;
Enter passes the row's own occurrence id to `onSelect`. The full map is
needed solely by `resolveTreePick`, which interactive-mode (the `onSelect`
owner) calls with its own `buildTree` output, passing its banner function
as `onInvalid` (consistent with its `buildTree` call sites).

**`src/tui/interactive-mode.ts`**: the `/tree` open site adds a
`buildDisplayTree` call; `renderPathNode` implements the history dedupe
(skip `appendPathNode` when `node.ref.viaBoundary !== undefined` and the
uuid is already in the replay's rendered set). No signature changes.

No daemon, wire-protocol, or `core/effective-chain.ts` changes.

## Data flow

- `format tree`: entries → (`buildTree` | `buildDisplayTree`) → flatten →
  lines.
- Picker open: snapshot → `buildTree` + `buildDisplayTree` +
  `entriesByUuid` → component renders display rows; a pick →
  `resolveTreePick`(full map, entries) → set-context request. The only
  place both trees live simultaneously.
- History reload: unchanged (`buildTree` → `pathToLeaf`) plus the
  render-skip.

## Cost

One extra O(n) entry replay and a second O(n) `ParentMap` — only on picker
open (`format tree` builds exactly one tree). Boundary-undo picks run
`effectiveTreeNodeChain` over a truncated entry list, O(n) per pick. All
render-time or per-pick; nothing per-keystroke beyond today's reflatten.

## Success criteria

1. `format tree --filter conversation` on a session with N native
   compactions and no genuine forks renders a single linear chain (no
   `├─`/`└─` connectors): each boundary + summary inline at its
   chronological spot, each occurrence exactly once.
2. The `/tree` picker shows the same linearized topology (its fixed filter
   and uuid omission aside); picking the last pre-compaction message
   rewinds to pre-compaction context (raw occurrence).
3. Picking a post-compaction user message resolves its ancestor on the
   full tree (`viaBoundary` occurrence — compaction kept).
4. A boundary or summary pick resolves to the pre-boundary chain's last
   assistant ref (up_to: the preserved tail's tip, not
   `logicalParentUuid`), with no `editorText`.
5. After a boundary rewind plus one new turn, the display forks exactly at
   the rewind target; with no new turn, the summary-less boundary is
   invisible and the leaf marker sits on the rewind target's raw row.
6. Fresh up_to compaction: `*` on the summary row, `[cursor: …]` prints
   the preserved tip's uuid.
7. TUI history after a boundary rewind renders each message at most once;
   banner and summary still render.
8. `raw` mode reproduces today's topology with `~` on every relinked row;
   invalid/no-relink boundaries render in all modes at their current
   placement.

## Non-goals

- No change to what the agent actually sees (`get-messages`, loader
  behavior, `set-context` mechanics).
- No new wire fields or daemon requests.
- No linearity guarantee for hand-crafted `--uuids` lists: single-line
  rendering is guaranteed only when preserved lists are suffixes of a raw
  chain (native and clauctl-written boundaries); arbitrary reordered or
  cross-branch lists may still display forks, and the linear reading is an
  accepted approximation there. `raw` mode is the truthful view.

# IMPLEMENTATION IDEAS

- `buildDisplayTree` as a forward replay mirroring `buildTree`'s loop
  shape: maintain `occurrenceOf` (uuid → current *display* row id) and
  `representativeOf`; at a valid-relink boundary, record its anchor
  (= display row of `occurrenceOf(lastPreservedUuid)` before overwriting),
  map each relinked occurrence id → block tail, and overwrite
  `occurrenceOf` for preserved uuids to the block tail so post-boundary
  entries and later boundaries' anchors land there. Mirror `buildTree`'s
  pending-relink handling on corrupt interleavings (a later boundary
  displaces an earlier still-pending substructure).
- The hidden-boundary rule needs "no displayed descendants", known only
  after the scan, and must cascade (fixpoint): either a pruning pass that
  iterates deleting childless summary-less boundary rows and rewrites
  `representativeOf`/anchors through them, or defer boundary emission
  until a descendant materializes — deferral gives the cascade naturally.
  Choose during implementation.
- From-shape summary rows keep their `uuid@boundary` id in the display
  map, so `~` marking falls out of the id alone — `formatTreeNodeLine`
  needs only `parseTreeNodeRef(id).viaBoundary !== undefined`.
- The duplicate-key throw in `buildTree` (corrupt-file detection) should
  have an equivalent in `buildDisplayTree` — same uniqueness argument
  applies to its emitted ids.
- Picker boundary-undo: `entries.findIndex` for the boundary, then
  `effectiveTreeNodeChain(entries.slice(0, boundaryIndex), …)`; the pick
  path in `resolveTreePick` distinguishes boundary/summary picks the same
  way it does today (entry `subtype`/`isCompactSummary`).
- History dedupe lives in `renderPathNode` with its OWN seen-uuids set
  (not the `replayed` live-event-dedupe set, whose membership is
  `entryToSessionMessage`-filtered and misses `local_command`-style system
  entries that `appendPathNode` renders): add every uuid-bearing path
  node's uuid; skip rendering when `viaBoundary` is set and the uuid is
  already present. Update `reloadHistory`'s "duplicates included — honest
  display" doc comment, which this spec deliberately reverses.
- Test surfaces: `format/tree.test.ts` (linear-after-compaction, stacked
  compactions, rewind fork, hidden boundary + cascade, `raw` mode, `~`
  alignment under connectors, cursor vs marker, filter-hidden
  representative row), `core/build-display-tree.test.ts`
  (anchor/representative rules incl. exhaustive `representativeOf`
  domain, stacked boundaries, invalid relinks, corrupt interleavings),
  `tree-selector.test.ts` (literal row picks, boundary AND summary undo
  resolution with no `editorText`, malformed-summary fallback),
  `interactive-mode.test.ts` / `transcript.test.ts` (history dedupe incl.
  relinked local commands / tool results, up_to overlap shape).

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [x] Derisk discussion: display-only transform; re-anchor at last
  preserved uuid's pre-boundary occurrence; children to block tail;
  summary-less childless boundaries hidden; invalid boundaries stay
  visible (loader still honors them as cuts — "ignored by loader" was
  incorrect); picker rows literal (raw pick = undo compaction), user-pick
  ancestors on full tree, boundary picks re-resolved via pre-boundary
  chain; `~` always on; `raw` mode added; type design approved with
  build-display-tree.ts as its own file.
- [x] Reviewer pass (fresh-context agent): added explicit block-edge rule,
  exhaustive `representativeOf` contract, dedicated history seen-uuids set
  (the `replayed` set misses `local_command` renders), `onInvalid` on
  `resolveTreePick`, exact `~` placement, summary picks = boundary picks
  with no `editorText` (drops today's summary-text prefill),
  malformed-summary fallback to user-row semantics, linearity qualified to
  suffix-shaped relinks, raw-mode wording (occurrences, not entries).
- [ ] Implement `buildDisplayTree` + tests
- [ ] `format tree`: `raw` mode, display-tree default, `~` marking + tests
- [ ] Picker: display rows, `resolveTreePick` boundary-undo + tests
- [ ] TUI history dedupe + tests
