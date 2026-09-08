# Phase 1: rolling builders

> Work log for phase 1 of docs/specs/session-tracker.md (IMPLEMENTATION
> IDEAS, "Rolling builders"). Status: **review round 1 addressed** (2026-09-11).

## Scope

Convert `buildTree`, `toContextTree`, `toDisplayTree` (src/core/tree/)
into `SessionTreeBuilder`, `ContextTreeBuilder`, `DisplayTreeBuilder`
per the spec's type design (section "Rolling builders"); keep the three
functions as `pushAll` + `finish` conveniences so the seven external
callers are untouched; add `lastAssistantOn` and `awaitingAnchors`;
retire the AGENTS.md one-pass bullet. Pure, no daemon changes.

## Plan

1. `SessionTreeBuilder`: the `buildTree` loop body becomes `push`, its
   closure state fields, the trailing dangling-anchor flush `finish()`;
   `nodes` appended in `setParent`; `awaitingAnchors` from the deferred
   blocks.
2. `ContextTreeBuilder`: the `toContextTree` loop body becomes the
   per-row placement, driven by a cursor over `nodes`; `excluded`/`leaf`/
   `group` live; `tree` a `ContextTree` over the live maps;
   `lastAssistantOn` a parent walk; `awaitingAnchors` delegates.
3. `DisplayTreeBuilder`: the first loop becomes the per-row placement;
   the second pass (`nearestVisibleAncestor`) folds into the same push.
   Sound because a row's hidden status is final by its own push: hiding
   touches only the boundary being pushed and its own block rows, which
   are materialized after it (`flushBlock` runs after the boundary's
   `setParent`, the up_to summary follows its boundary in the file).
4. AGENTS.md bullet.

## Implementation-Time Decisions

### Criterion 2 was verified once, not kept as a test

The spec's wording ("a fresh builder fed k entries then finish()ed
equals buildTree(prefix)") compares the wrapper to itself once the
functions are `pushAll + finish`. The property the daemon relies on is
that dependents observing every intermediate state end up where a
single batch ends (a group's `excluded` is added at group end, one node
later than the display builder's processing of the preceding node). A
throwaway `rollingMismatch` (rolling chain vs fresh batch chain at
every prefix, O(n²)) confirmed this on every fixture and ten real logs,
then was deleted: Anton (2026-09-11) — the existing tree tests are the
behavior guard, `scripts/check-context-at.ts` on real logs covers the
context tree, the TUI the display tree; no per-prefix check in the
suite.

### Wrappers consume a `FullTreeView`, not a `SessionTreeBuilder`

`toContextTree(fullTree: ParentMap, byUuid)` keeps its signature but the
builder consumes `SessionTreeBuilder.rows`. The dependents' input is
therefore an interface `FullTreeView {parentMap, rows, awaitingAnchors}`
which `SessionTreeBuilder` implements and which the wrappers derive from
a `ParentMap` (`rows = [...parentMap.keys()]`, `awaitingAnchors = []` —
a `ParentMap` value is a finished tree, so nothing is deferred).

### `ContextTreeBuilder` has a `finish()` too

The spec puts `finish()` only on `SessionTreeBuilder`, but
`toContextTree` also has an end-of-input step: the open trailing tool
group's `excludedAtEnd()` (a call with no result at end of file is dead
for the loader). The live view must not apply it (the result may still
arrive), so the batch wrapper needs `ContextTreeBuilder.finish()` with
the same contract as the session builder's: the daemon never calls it.

### `nodes` is an array beside `parentMap`, not `parentMap.keys()`

Dependents resume from an integer cursor across pushes. A Map key
iterator visits appended keys only while it is unfinished; once `next()`
reports done it stays done, so a dependent could not hold one across
pushes, and re-iterating `keys()` past the cursor is O(n) per push. The
array costs one string reference per node. Anton's review (ca15309)
asked for `parentMap` (not `relation`) and `nodes` (not `rows`): both
are public readonly fields typed mutable rather than a getter over a
differently named private field.

### `awaitingAnchors` lists boundary uuids, keyed by anchor internally

Spec: "the uuids of boundaries still deferred, in file order";
`pendingBlockByAnchor` is keyed by anchor uuid, so the pending record
now carries the boundary uuid alongside its rows. Two boundaries naming
the same absent anchor (hand-crafted only) keep today's behavior: the
later replaces the earlier's pending rows.

### A result persisted ahead of its call is not modeled

Found by the rolling check on a real log (2048 project, 2026-08-24, CLI
wrote a `tool_result` at line 8778 before the assistant `tool_use` at
8781 that it names as parent). The batch judges "result with no call
entry" over the whole prefix; the rolling builder judges it on arrival
and never revisits, so the live `excluded` keeps such a result while a
batch over the same prefix would not. Anton (2026-09-11): anomalous
old-CLI behavior, do not model it (the full tree roots such a result
anyway — its parent was not materialized when it arrived).

### `DisplayTreeBuilder` takes `Pick<ContextTreeBuilder, "tree">`

So `toDisplayTree(fullTree, contextTree: ContextTree, byUuid)` keeps
its signature: the wrapper passes `{tree: contextTree}`. `get tree` on
the context builder allocates a `ContextTree` over the live maps per
call (a small object; `leaf` is a value, the maps are shared).

## WORK LOG

- 2026-09-11: plan and decisions above; implementation started.
- 2026-09-11: builders + wrappers done; suite green (647); presubmit
  green (8e3bc65). Rolling check run: no rolling mismatch on the six
  most recent clauctl logs nor on four other sampled compaction logs
  (with the result-ahead-of-call exclusion lift, since reverted); the
  2048 log (32k entries) was not re-checked — the O(n²) check is too
  slow at that size and was killed. The loader-vs-contextAt mismatch
  counts those runs print are pre-existing (identical with HEAD's script
  on the same files; old file formats / SDK behavior per Anton — out of
  scope). AGENTS.md one-pass bullet removed.
- 2026-09-11: review round ca15309 addressed: `rolling-check.ts` and
  its three test hooks and script call deleted; `TreeNodeStr` added in
  parent-map.ts and threaded through nodes.ts, loader.ts, the builders,
  format/tree.ts, tree-selector.ts; `rows` → `nodes`; `relation`/
  `materialized` → public `parentMap`/`nodes`; `orphanResultsByCall` and
  its test removed. "Row" stays as the prose term for a tree occurrence
  in comments and the tree specs; only the identifiers changed.
