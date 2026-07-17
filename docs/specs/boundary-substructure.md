# Spec: boundary substructure — relink-aware chain and tree

> Status: **implemented.** Follow-up to
> `docs/specs/session-tree-and-set-context.md` (which shipped `get-tree` and
> deferred the boundary substructure) and `docs/specs/format-tree.md` (which
> fixed the node identity `(uuid, viaBoundary)` — called "occurrence
> identity" there — and ships a rendering already prepared for duplicate
> nodes).

## SPEC (stable requirements)

### Problem

Two related information losses, one root cause:

- `effectiveChain` returns bare `UUID[]`. At walk time it knows whether each
  parent step came from a boundary's relink map or from a raw `parentUuid`,
  and discards that. Once the tree contains multiple nodes for one uuid, no
  downstream code can reconstruct which node the chain traverses from
  `(tree, leafUuid)` alone — the information must be retained at the source.
- `buildTree` ships the raw forest only: a boundary's relinked context (the
  loader's actual post-compaction context) is invisible in `get-tree`, and
  entries written after a boundary attach to raw pre-compaction nodes
  instead of the context they were actually written against.

Consequence today: `get-tree`'s `leaf.viaBoundary` can never be set, and the
handler hard-codes that fact with a comment instead of deriving it.

This spec makes `effectiveChain` return tree-node references and makes
`buildTree` emit the boundary substructure, so the get-tree `leaf` is the
chain's tip — no assumptions across module boundaries.

### Definitions

- **Tree-node identity** is the pair `(uuid, viaBoundary)`. A **raw node**
  (no `viaBoundary`) sits at the entry's own `parentUuid` placement. A
  **relinked node** (`viaBoundary = B`) sits where boundary `B`'s relink
  places the entry. Every entry with a uuid gets exactly one raw node,
  except the from-shape summary (below), whose only node is relinked.
- **Valid relink** of a boundary: `compactMetadata.preservedMessages` is
  present, `uuids` is non-empty, contains no duplicates, and every listed
  uuid names an entry earlier in the file. Anything else is **invalid** and
  the relink is skipped entirely — the boundary behaves as if it had no
  `preservedMessages` (loader parity: P1 d, P3 m4 — a missing or duplicated
  uuid silently skips the relink; context = summary only).
- **Relinked uuids** of a valid relink: the preserved `uuids`, plus the
  summary entry's uuid when the relink re-parents it — from-shape
  (`anchorUuid` = the boundary's own uuid) with a summary present. For
  preserved uuids the relinked node is a **duplicate** — the raw node stays,
  anchoring the pre-compaction history. For the from-shape summary the raw
  node (a stub child of the boundary, its placement fully represented by
  the relinked node) is **omitted**. In up_to shape (`anchorUuid` = the
  summary's uuid) the summary keeps its raw parent (the boundary) and is
  not relinked.
- **Relink parent map** (existing `effectiveParentMap` semantics, unchanged):
  `uuids[i] → uuids[i-1]`, `uuids[0] → anchorUuid`, and in from-shape
  `summary → uuids[last]`.

### `effectiveTreeNodeChain`

- New function returning the loader-true effective chain as tree-node
  references, root → tip: the same uuid sequence `effectiveChain` produces
  today, each element annotated `viaBoundary = B` iff its uuid is in the
  **last** boundary's relinked uuids (last-wins, P3 m5), bare otherwise.
  Elements reached below the anchor via raw parents are bare.
- `effectiveChain` becomes a thin wrapper mapping the chain to uuids. All
  current callers keep their signatures and behavior, with one deliberate
  exception:
- **Loader-parity fix (behavior change)**: `effectiveChain` today applies
  invalid relinks (a duplicated uuid is silently deduped by `Map.set`; a
  missing uuid is walked into nothing). Per the probes the loader skips such
  relinks and lands on summary-only context. Both walks must use the shared
  validity check, so an invalid relink yields `[summary]` (or an empty chain
  when there is also no summary).

### `buildTree` substructure

- For each boundary with a **valid relink**, in file order, emit relinked
  nodes for its relinked uuids: each embeds the entry verbatim (accepted in
  format-tree.md — payload serialized once per node) and carries
  `viaBoundary` = the boundary's uuid, children initially empty. The
  from-shape summary gets no raw node.
- **Attachment follows the relink parent map through a running node map** —
  the exact logic of the effective chain, applied forward. The builder
  maintains `uuid → current attachment node`; processing a valid relink
  overwrites the entries for its relinked uuids to point at the relinked
  nodes. Thus:
  - `relinked(uuids[0])` attaches to the anchor's current node — under the
    raw summary node (up_to) or directly under the boundary node
    (from-shape); each subsequent relinked node chains onto the previous
    one; in from-shape the relinked summary ends the chain.
  - Entries written after the boundary (including the CLI's synthetic
    `"No response requested."` assistant), and later boundaries' anchors and
    `logicalParentUuid` targets, attach to relinked nodes automatically.
- An **invalid relink emits no substructure and leaves the running map
  untouched** — post entries attach to raw nodes, and an invalid from-shape
  boundary keeps its raw summary node, matching the loader's skip.
- Boundaries with no `preservedMessages` (including legacy segment-only
  boundaries) emit no substructure, as today.

### get-tree `leaf`

- The handler composes `leaf` from `effectiveTreeNodeChain(entries)`
  (filterTail override's `droppedUuids` filtered **by uuid**, freshness rule
  unchanged): `leaf = chain.at(-1) ?? null`. No node-identity reasoning in
  the handler; `viaBoundary` flows from the chain. The chain tip always lies
  in the last boundary's skeleton or after it, where the chain and the tree
  agree, so the leaf always names an existing tree node.

### Type design

```ts
// effective-chain.ts
/** Identifies one tree node: a raw node (viaBoundary absent) or a
 *  boundary-substructure relinked node (viaBoundary = the boundary's
 *  uuid). */
export interface TreeNodeRef {
  uuid: UUID;
  viaBoundary?: UUID;
}

/** The validated relink of the boundary at entries[boundaryIndex];
 *  undefined when preservedMessages is absent or the relink is invalid
 *  (= behave as a no-relink boundary). Consumed by both walks. */
export interface BoundaryRelink {
  /** Ordered uuids receiving @boundary relinked nodes: preserved uuids,
   *  plus the re-parented summary (from-shape). */
  relinkedUuids: UUID[];
  /** Effective-parent overrides (uuid → parent uuid). */
  parentMap: Map<UUID, UUID>;
}
/** Sink for corrupt-session-file diagnostics (a relink that fails
 *  validation, a parentUuid cycle). Required so ignoring them is a
 *  visible choice at the call site; daemon callers pass the daemon log.
 *  Threaded through every function that walks entries (including
 *  seedFromEntries, buildTree, and get-messages' startupOverride). */
export type OnInvalid = (message: string) => void;

export function validRelink(
  entries: SessionEntry[],
  boundaryIndex: number,
  onInvalid: OnInvalid,
): BoundaryRelink | undefined;

/** Loader-true tree-node chain, root → tip. Calls validRelink. */
export function effectiveTreeNodeChain(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): TreeNodeRef[];

/** Uuid projection of effectiveTreeNodeChain. */
export function effectiveChain(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): UUID[];

// build-tree.ts — TreeNode and SessionTree shapes unchanged;
// SessionTree.leaf's inline literal becomes TreeNodeRef | null (same
// shape). buildTree calls validRelink + summaryOf and now emits relinked
// nodes with viaBoundary set.
```

`effectiveParentMap` (private) is subsumed by `validRelink`. The exact
`BoundaryRelink` field shape may be refined during implementation if the two
consumers want different projections; the function boundary, name, and
"undefined = behave as no relink" contract are fixed.

### Concrete examples

Entries are listed in file order; `(p=x)` is `parentUuid`. `S` entries are
summaries (`isCompactSummary`, `p=` the boundary). Trees show nodes; `x@B`
is a relinked node.

**A — up_to shape.** `u1, u2(p=u1), u3(p=u2), B{anchor=S, uuids=[u2,u3],
logicalParent=u3}, S(p=B), u4(p=u3)`:

```
u1 → u2 → u3 → B → S → u2@B → u3@B → u4
```

(one path: B under u3, raw S under B, relinked nodes under S, u4 under
`u3@B`). Chain: `[S, u2@B, u3@B, u4]`.

**B — from shape.** `u1, u2(p=u1), u3(p=u2), B{anchor=B, uuids=[u1,u2],
logicalParent=u2}, S(p=B), u4(p=S)`:

```
u1 → u2 → u3
       └─ B → u1@B → u2@B → S@B → u4
```

Chain: `[u1@B, u2@B, S@B, u4]`. `S` has no raw node — `S@B` is its only
placement; `u4`'s parent uuid is `S`, resolved to it.

**C — stacked boundaries.** `a, b(p=a), c(p=b), B1{anchor=S1, uuids=[c],
logicalParent=c}, S1(p=B1), d(p=c), B2{anchor=S2, uuids=[d],
logicalParent=d}, S2(p=B2), e(p=d)`:

```
a → b → c → B1 → S1 → c@B1 → d → B2 → S2 → d@B2 → e
```

`d` attaches to `c@B1` (the running map after B1); `e` attaches to `d@B2`.
Chain (last-wins, B1 ignored): `[S2, d@B2, e]`. The pair `(d, ∅)` vs
`(d, B2)` distinguishes the two `d` nodes.

**D — invalid relink (skip).** `u1, u2(p=u1), u3(p=u2), B{anchor=S,
uuids=[u2, u2], logicalParent=u3}, S(p=B)` (equivalently `[u2, uX]` with
`uX` not in the file): no relinked nodes are emitted and the chain is
`[S]` — summary-only, matching the loader. A subsequent write parents onto
the summary (P1 d), so with `u4(p=S)` appended the chain is `[S, u4]`, all
bare.

### Success criteria

1. `effectiveTreeNodeChain` unit tests pin shapes A–D, including the
   no-post-entries tips (up_to → `uuids[last]@B`; from → `S@B`; invalid or
   no relink → bare summary).
2. `effectiveChain` still passes its existing tests except where they
   contradict loader parity on invalid relinks; the skip behavior gets its
   own test.
3. `buildTree` tests pin the A–D forests — including the omitted from-shape
   raw summary — entry identity shared between raw and relinked nodes, and
   attachment of post entries and stacked boundaries to relinked nodes.
4. A daemon-level test shows `get-tree` returning `leaf.viaBoundary` when
   the chain tip is a relinked node (boundary appended, no post entries).
5. `clauctl format tree` renders a `buildTree`-produced compacted session
   end-to-end: substructure visible, `*` on the correct node, and the
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
  the substructure at the anchor's current node; the chain reports those
  below-anchor elements as bare (loader-true). Accepted; `format tree`
  markers derive from tree ancestry and the leaf still names an existing
  node.
- A preserved uuid that is also on the anchor's raw ancestor chain (loader
  behavior untested) is annotated by relinked-uuid membership; not
  otherwise specified.
- Non-goals: TUI rendering of substructure; node-ref-aware `set-context`
  targets (the session-tree spec's TUI mapping); modeling legacy
  `preservedSegment` boundaries; any `format tree` rendering changes (the
  adapter already keys by `(uuid, viaBoundary)` and is tested with
  hand-built duplicate nodes).

## IMPLEMENTATION IDEAS

- **Substructure build timing**: the summary entry appears after the
  boundary in the file, so the boundary's substructure cannot attach at
  boundary-processing time in up_to/from shapes (parent node missing).
  Build it when its parent exists — e.g. look ahead with `summaryOf` at the
  boundary, and emit the substructure right after processing the summary's
  file position (in from-shape, emitting the skeleton _instead of_ a raw
  summary node), or immediately for a valid relink with no summary. Entries
  between boundary and summary (snapshots etc.) are unaffected — they don't
  parent onto the skeleton.
- The running node map generalizes buildTree's current
  `nodes: Map<UUID, TreeNode>` — same map, entries overwritten to point at
  relinked nodes as relinks are processed. Raw-node identity for leaf-lookup
  is not needed; only attachment goes through the map.
- `validRelink`'s missing-uuid check is "named entry appears earlier in the
  file", which the single forward pass gives for free (lookup in the map
  built so far).
- The chain walk keeps its current structure (tip selection + backward
  walk); it swaps `effectiveParentMap` for `validRelink` and annotates
  elements via a `Set` of the last boundary's relinked uuids.
- P9(b): preserved uuids may include an earlier boundary's summary or
  entries it summarized away — no special handling; relinked nodes are
  emitted for whatever entries the uuids name.
- The synthetic `"No response requested."` assistant is an ordinary
  post-boundary entry (parent = summary) and needs no special handling —
  answering the open question in session-tree-and-set-context.md's ideas
  section.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-16: Derisked and wrote the spec. Key decisions from the
  discussion: relink info retained at the source (`effectiveTreeNodeChain`)
  with `effectiveChain` as a uuid projection; attachment-to-relinked-nodes
  via a running node map ("same logic as the chain, forward"); the
  from-shape summary is a relinked uuid (amendment to the
  preserved-uuids-only rule); invalid relinks (duplicate or missing uuid)
  skip loader-style in **both** walks — fixing a pre-existing
  `effectiveChain` divergence; below-anchor chain elements stay bare, which
  only diverges from tree ancestry for hand-crafted anchors (native shapes
  terminate at the boundary).
- 2026-07-16 (review round): dropped the "occurrence" terminology for plain
  tree-node language (`OccurrenceRef` → `TreeNodeRef`,
  `effectiveOccurrenceChain` → `effectiveTreeNodeChain`, `duplicatedUuids`
  → `relinkedUuids`); the from-shape raw summary node is omitted from
  buildTree (its placement is fully represented by the relinked node) —
  example B, the definitions, and the child-ordering implementation note
  updated accordingly (the ordering question disappeared with the raw
  summary).
- 2026-07-16 (implemented): types landed exactly as designed. Success
  criteria 1–5 covered by tests (274 pass): shapes A–D pinned for both
  walks (effective-chain.test.ts, build-tree.test.ts, including the
  missing-uuid invalid variant, the no-summary immediate emission, and
  shared entry identity); the existing daemon test "rewind to an abandoned
  branch appends a no-summary boundary" became the criterion-4 test — its
  leaf expectation gained `viaBoundary` (the spec-sanctioned behavior
  change, and the only pre-existing test the change touched); criterion 5
  is an end-to-end tree.test.ts case over `buildTree` +
  `effectiveTreeNodeChain` with the `*` landing on the relinked duplicate.
  Criterion 6: handler comment and build-tree TODO removed, format-tree.md
  notes updated.
- 2026-07-17 (implementation review round): buildTree's deferred emission
  became a single `pendingRelink` (decision entry updated below) and its
  loop was reordered typical-case-first; the validRelink guards cite their
  probes (P1e; P3 m4/P1 d). New type `OnInvalid`, a required callback
  threaded through `validRelink` / `effectiveTreeNodeChain` /
  `effectiveChain` / `seedFromEntries` / `buildTree` / `startupOverride`
  and wired to the daemon log: invalid relinks (duplicate/unknown uuid)
  and the chain walk's cycle guard now report corruption instead of
  silently skipping. The guard itself stays — the walk follows raw
  unvalidated `parentUuid` pointers, so a corrupt file (or a hand-crafted
  anchor whose raw ancestry re-enters a relinked uuid) can cycle. Tests:
  well-formed fixtures use a throwing sink, invalid-relink tests assert
  the diagnostic, plus a new parentUuid-cycle test (275 pass). Anton
  approved the diagnostic line (no `onInvalid` for absent
  preservedMessages / empty uuids) and the round; spec marked implemented.

### Implementation-Time Decisions

- **Substructure attachment mirrors the walk's parent resolution**:
  `emitSubstructure` attaches each relinked node at
  `parentMap.get(uuid) ?? entry.parentUuid` — the same
  map-first-raw-fallback the chain walk uses. Only reachable for `uuids[0]`
  when `preservedMessages` lacks `anchorUuid` (valid per the definitions,
  which don't require an anchor); the alternative (root fallback) would
  diverge from the chain for no reason.
- **Deferred emission holds a single `pendingRelink`** (review round: was a
  map keyed by summary uuid): a summary always follows its boundary before
  the next boundary in any CLI/clauctl-written file, so at most one relink
  is pending at a time; in a hand-crafted interleaving the later boundary
  displaces the earlier pending substructure. At the summary's file
  position the from-shape summary node is created unattached and
  registered in the running map purely so `emitSubstructure` can read its
  entry — the relink immediately overwrites the registration with the
  relinked node, and the raw node never enters the tree.
- **A uuid-less boundary annotates nothing**: `effectiveTreeNodeChain`
  skips the relinked-uuid annotation when the boundary entry itself has no
  uuid (there is no value for `viaBoundary`), while the parent map still
  applies so the walk stays loader-true. Degenerate hand-edit territory;
  buildTree never sees it (uuid-less entries get no node).
- **Empty `uuids` classified invalid is not a behavior change**: the old
  tip-selection fallback already produced summary-only context for empty
  uuids; `validRelink` folding it into "invalid" keeps the same result with
  one rule. It does not fire `onInvalid`: absent `preservedMessages` is
  normal (legacy segment-only boundaries) and empty `uuids` reads as "keep
  nothing", not corruption — only duplicate/unknown uuids and walk cycles
  are diagnostics.
