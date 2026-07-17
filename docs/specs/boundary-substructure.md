# Spec: boundary substructure — occurrence-aware chain and tree

> Status: **draft, awaiting review.** Follow-up to
> `docs/specs/session-tree-and-set-context.md` (which shipped `get-tree` and
> deferred the boundary substructure) and `docs/specs/format-tree.md` (which
> fixed the occurrence identity `(uuid, viaBoundary)` and ships a rendering
> already prepared for duplicates).

## SPEC (stable requirements)

### Problem

Two related information losses, one root cause:

- `effectiveChain` returns bare `UUID[]`. At walk time it knows whether each
  parent step came from a boundary's relink map or from a raw `parentUuid`,
  and discards that. Once the tree contains duplicate occurrences of a uuid,
  no downstream code can reconstruct which occurrence the chain traverses
  from `(tree, leafUuid)` alone — the information must be retained at the
  source.
- `buildTree` ships the raw forest only: a boundary's relinked context (the
  loader's actual post-compaction context) is invisible in `get-tree`, and
  entries written after a boundary attach to raw pre-compaction nodes
  instead of the context they were actually written against.

Consequence today: `get-tree`'s `leaf.viaBoundary` can never be set, and the
handler hard-codes that fact with a comment instead of deriving it.

This spec makes `effectiveChain` occurrence-aware and makes `buildTree` emit
the boundary substructure, so the get-tree `leaf` is the occurrence chain's
tip — no assumptions across module boundaries.

### Definitions

- **Occurrence**: one position in the session tree, identified by
  `(uuid, viaBoundary)`. A **raw occurrence** (no `viaBoundary`) is the
  entry's own node — every entry with a uuid has exactly one. A **duplicate
  occurrence** (`viaBoundary = B`) is a substructure node under boundary
  `B`'s relink.
- **Valid relink** of a boundary: `compactMetadata.preservedMessages` is
  present, `uuids` is non-empty, contains no duplicates, and every listed
  uuid names an entry earlier in the file. Anything else is **invalid** and
  the relink is skipped entirely — the boundary behaves as if it had no
  `preservedMessages` (loader parity: P1 d, P3 m4 — a missing or duplicated
  uuid silently skips the relink; context = summary only).
- **Duplicated uuids** of a valid relink: the preserved `uuids`, plus the
  summary entry's uuid when the relink re-parents it — from-shape
  (`anchorUuid` = the boundary's own uuid) with a summary present. In
  up_to shape (`anchorUuid` = the summary's uuid) the summary keeps its raw
  parent (the boundary) and is not duplicated.
- **Relink parent map** (existing `effectiveParentMap` semantics, unchanged):
  `uuids[i] → uuids[i-1]`, `uuids[0] → anchorUuid`, and in from-shape
  `summary → uuids[last]`.

### `effectiveOccurrenceChain`

- New function returning the loader-true effective chain as occurrences,
  root → tip: the same uuid sequence `effectiveChain` produces today, each
  element annotated `viaBoundary = B` iff its uuid is in the **last**
  boundary's duplicated uuids (last-wins, P3 m5), bare otherwise. Elements
  reached below the anchor via raw parents are bare.
- `effectiveChain` becomes a thin wrapper mapping the occurrence chain to
  uuids. All current callers keep their signatures and behavior, with one
  deliberate exception:
- **Loader-parity fix (behavior change)**: `effectiveChain` today applies
  invalid relinks (a duplicated uuid is silently deduped by `Map.set`; a
  missing uuid is walked into nothing). Per the probes the loader skips such
  relinks and lands on summary-only context. Both walks must use the shared
  validity check, so an invalid relink yields `[summary]` (or an empty chain
  when there is also no summary).

### `buildTree` substructure

- For each boundary with a **valid relink**, in file order, emit duplicate
  nodes for its duplicated uuids: each duplicate embeds the same entry
  verbatim (accepted in format-tree.md — payload serialized once per node)
  and carries `viaBoundary` = the boundary's uuid, children initially empty.
- **Attachment follows the relink parent map through a running occurrence
  map** — the exact logic of the effective chain, applied forward. The
  builder maintains `uuid → current attachment occurrence`; processing a
  valid relink overwrites the entries for its duplicated uuids to point at
  the duplicates. Thus:
  - `dup(uuids[0])` attaches to the anchor's current occurrence — under the
    raw summary node (up_to) or directly under the boundary node
    (from-shape); each subsequent duplicate chains onto the previous one;
    in from-shape the summary duplicate ends the chain.
  - Entries written after the boundary (including the CLI's synthetic
    `"No response requested."` assistant), and later boundaries' anchors and
    `logicalParentUuid` targets, attach to duplicates automatically.
- An **invalid relink emits no substructure and leaves the running map
  untouched** — post entries attach to raw occurrences, matching the
  loader's skip.
- Boundaries with no `preservedMessages` (including legacy segment-only
  boundaries) emit no substructure, as today.

### get-tree `leaf`

- The handler composes `leaf` from `effectiveOccurrenceChain(entries)`
  (filterTail override's `droppedUuids` filtered **by uuid**, freshness rule
  unchanged): `leaf = chain.at(-1) ?? null`. No occurrence reasoning in the
  handler; `viaBoundary` flows from the chain. The chain tip always lies in
  the last boundary's skeleton or after it, where the chain and the tree
  agree on the occurrence, so the leaf always names an existing tree node.

### Type design

```ts
// effective-chain.ts
/** One tree position: a raw node (viaBoundary absent) or a boundary-
 *  substructure duplicate (viaBoundary = the boundary's uuid). */
// TDC: should this be TreeNodeRef? Isn't "occurrence" just "tree node"? I think "occurrence" might be introducing needless additional terminology.
export interface OccurrenceRef {
  uuid: UUID;
  viaBoundary?: UUID;
}

/** The validated relink of the boundary at entries[boundaryIndex];
 *  undefined when preservedMessages is absent or the relink is invalid
 *  (= behave as a no-relink boundary). Consumed by both walks. */
export interface BoundaryRelink {
  /** Ordered uuids receiving @boundary duplicates: preserved uuids, plus
   *  the re-parented summary (from-shape). */
  duplicatedUuids: UUID[];  // TDC: note: our buildTree should omit the "raw" summary node.
  /** Effective-parent overrides (uuid → parent uuid). */
  parentMap: Map<UUID, UUID>;
}
export function validRelink(
  entries: SessionEntry[],
  boundaryIndex: number,
): BoundaryRelink | undefined;

/** Loader-true occurrence chain, root → tip. Calls validRelink. */
export function effectiveOccurrenceChain(  // TDC: I guess this should be "effectiveTreeNodeRefChain"?
  entries: SessionEntry[],
): OccurrenceRef[];

/** Uuid projection of effectiveOccurrenceChain. */
export function effectiveChain(entries: SessionEntry[]): UUID[];

// build-tree.ts — TreeNode and SessionTree shapes unchanged;
// SessionTree.leaf's inline literal becomes OccurrenceRef | null (same
// shape). buildTree calls validRelink + summaryOf and now emits duplicate
// nodes with viaBoundary set.
```

`effectiveParentMap` (private) is subsumed by `validRelink`. The exact
`BoundaryRelink` field shape may be refined during implementation if the two
consumers want different projections; the function boundary, name, and
"undefined = behave as no relink" contract are fixed.

### Concrete examples

Entries are listed in file order; `(p=x)` is `parentUuid`. `S` entries are
summaries (`isCompactSummary`, `p=` the boundary). Trees show occurrences;
`x@B` is a duplicate.

**A — up_to shape.** `u1, u2(p=u1), u3(p=u2), B{anchor=S, uuids=[u2,u3],
logicalParent=u3}, S(p=B), u4(p=u3)`:

```
u1 → u2 → u3 → B → S → u2@B → u3@B → u4
```

(one path: B under u3, raw S under B, duplicates under S, u4 under `u3@B`).
Occurrence chain: `[S, u2@B, u3@B, u4]`.

**B — from shape.** `u1, u2(p=u1), u3(p=u2), B{anchor=B, uuids=[u1,u2],
logicalParent=u2}, S(p=B), u4(p=S)`:

```
u1 → u2 → u3
       └─ B → u1@B → u2@B → S@B → u4
          └─ S (raw)  // TDC: this node should be omitted from buildTree
```

Occurrence chain: `[u1@B, u2@B, S@B, u4]`. The raw summary stays a child of
the boundary; `u4`'s parent uuid is `S`, resolved to the duplicate.

**C — stacked boundaries.** `a, b(p=a), c(p=b), B1{anchor=S1, uuids=[c],
logicalParent=c}, S1(p=B1), d(p=c), B2{anchor=S2, uuids=[d],
logicalParent=d}, S2(p=B2), e(p=d)`:

```
a → b → c → B1 → S1 → c@B1 → d → B2 → S2 → d@B2 → e
```

`d` attaches to `c@B1` (the running map after B1); `e` attaches to `d@B2`.
Occurrence chain (last-wins, B1 ignored): `[S2, d@B2, e]`. The pair
`(d, ∅)` vs `(d, B2)` distinguishes the two `d` occurrences.

**D — invalid relink (skip).** `u1, u2(p=u1), u3(p=u2), B{anchor=S,
uuids=[u2, u2], logicalParent=u3}, S(p=B)` (equivalently `[u2, uX]` with
`uX` not in the file): no duplicates are emitted and the occurrence chain
is `[S]` — summary-only, matching the loader. A subsequent write parents
onto the summary (P1 d), so with `u4(p=S)` appended the chain is `[S, u4]`,
all bare.

### Success criteria

1. `effectiveOccurrenceChain` unit tests pin shapes A–D, including the
   no-post-entries tips (up_to → `uuids[last]@B`; from → `S@B`; invalid or
   no relink → bare summary).
2. `effectiveChain` still passes its existing tests except where they
   contradict loader parity on invalid relinks; the skip behavior gets its
   own test.
3. `buildTree` tests pin the A–D forests, entry identity shared between raw
   and duplicate occurrences, and attachment of post entries and stacked
   boundaries to duplicates.
4. A daemon-level test shows `get-tree` returning `leaf.viaBoundary` when
   the chain tip is a duplicate (boundary appended, no post entries).
5. `clauctl format tree` renders a `buildTree`-produced compacted session
   end-to-end: substructure visible, `*` on the correct occurrence, and the
   layout's unique-id precondition holds (no duplicate-id throw).
6. The hard-coded comment in the get-tree handler and the "FOLLOW-UP spec"
   TODO block in build-tree.ts are gone; format-tree.md's "absent until the
   follow-up lands" notes are updated.

### Edge cases and non-goals

- **Chain/tree divergence below the anchor is confined to hand-crafted
  anchors.** clauctl and the CLI write only the two native shapes
  (session-file.ts anchor = summary or boundary uuid), where the chain walk
  terminates at the boundary immediately below the skeleton. A hand-edited
  boundary anchored at an arbitrary entry makes the loader walk raw parents
  below it (resurrecting compacted-away entries) while the tree attaches
  the substructure at the anchor's current occurrence; the chain reports
  those below-anchor elements as bare occurrences (loader-true). Accepted;
  `format tree` markers derive from tree ancestry and the leaf still names
  an existing node.
- A preserved uuid that is also on the anchor's raw ancestor chain (loader
  behavior untested) is annotated by duplicated-uuid membership; not
  otherwise specified.
- Non-goals: TUI rendering of substructure; occurrence-aware `set-context`
  targets (the session-tree spec's TUI mapping); modeling legacy
  `preservedSegment` boundaries; any `format tree` rendering changes (the
  adapter is already occurrence-aware and tested with hand-built
  duplicates).

## IMPLEMENTATION IDEAS

- **Substructure build timing**: the summary entry appears after the
  boundary in the file, so the boundary's substructure cannot attach at
  boundary-processing time in up_to/from shapes (parent node missing).
  Build it when its parent exists — e.g. look ahead with `summaryOf` at the
  boundary and emit the substructure right after processing the summary's
  raw node (or immediately, for a valid relink with no summary). Entries
  between boundary and summary (snapshots etc.) are unaffected — they don't
  parent onto the skeleton.
- Child ordering falls out of the build timing: the raw summary node is a
  child before the substructure is emitted, so in from-shape the boundary's
  children are `[S(raw), uuids[0]@B]` in that order. Tests will pin whatever
  order the implementation produces; not a spec-level requirement.
- The running occurrence map generalizes buildTree's current
  `nodes: Map<UUID, TreeNode>` — same map, entries overwritten to point at
  duplicates as relinks are processed. Raw-occurrence identity for
  leaf-lookup is not needed; only attachment goes through the map.
- `validRelink`'s missing-uuid check is "named entry appears earlier in the
  file", which the single forward pass gives for free (lookup in the map
  built so far).
- The chain walk keeps its current structure (tip selection + backward
  walk); it swaps `effectiveParentMap` for `validRelink` and annotates
  elements via a `Set` of the last boundary's duplicated uuids.
- P9(b): preserved uuids may include an earlier boundary's summary or
  entries it summarized away — no special handling; duplicates are emitted
  for whatever entries the uuids name.
- The synthetic `"No response requested."` assistant is an ordinary
  post-boundary entry (parent = summary) and needs no special handling —
  answering the open question in session-tree-and-set-context.md's ideas
  section.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-16: Derisked and wrote the spec. Key decisions from the
  discussion: occurrence info retained at the source
  (`effectiveOccurrenceChain`) with `effectiveChain` as a uuid projection;
  attachment-to-duplicates via a running occurrence map ("same logic as the
  chain, forward"); the from-shape summary is a duplicated uuid (amendment
  to the preserved-uuids-only rule); invalid relinks (duplicate or missing
  uuid) skip loader-style in **both** walks — fixing a pre-existing
  `effectiveChain` divergence; below-anchor chain elements stay bare, which
  only diverges from tree ancestry for hand-crafted anchors (native shapes
  terminate at the boundary).
