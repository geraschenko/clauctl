# Handoff: adopt pictl's shared `flat-tree.ts` (dedupe the flat→layout adapter)

## Context

After clauctl's session-snapshot-and-forest change
(`docs/specs/session-snapshot-and-forest.md`, this repo), pictl implemented
its client-side equivalent: `format tree` builds the tree from flat
`get_entries` output instead of consuming pi's nested `get_tree` shape.
Spec: `docs/specs/format-tree-from-entries.md` in the pictl repo.

That work deliberately placed the generic flat→layout logic in a new
**shared file** so clauctl can stop maintaining its own copy:

- `pictl/src/format/flat-tree.ts` — `ParentMap`
  (`ReadonlyMap<string, string | null>`, child id → parent id, null = root)
  and `toLayoutTree<P>(parentMap, payloadOf: (id: string) => P):
  LayoutNode<P>[]` (iterative two-pass adapter; an id whose parent is not a
  map key becomes a root).
- `pictl/src/format/flat-tree.test.ts` — its tests.

It is self-contained next to `tree-layout.ts` (imports only within the
format sync set), specifically so it drops into clauctl's
`scripts/sync-from-pictl.mjs` format `SYNC_SET`.

## The task in clauctl

1. Add `flat-tree.ts` (and `flat-tree.test.ts`, matching how
   `pty-screen.test.ts` etc. are synced in the core set) to the format
   sync set in `scripts/sync-from-pictl.mjs`; run the sync.
2. Refactor clauctl onto the generated copy:
   - `src/core/tree.ts` defines an identical `ParentMap` — delete it and
     import from `src/format/generated/flat-tree.ts` (decide whether core
     importing from format/generated is acceptable, or re-export from
     core/tree.ts).
   - `src/format/tree.ts` has a local `toLayoutTree(parentMap, entryOf)`
     returning `LayoutNode<SessionEntry>[]` — replace with the generic one;
     the Claude-specific part (occurrence id → entry via
     `parseTreeNodeRef(id).uuid`) becomes the `payloadOf` closure.
3. Note the payload difference: pictl's payload is `{entry, label?}`
   (pi labels); clauctl's is bare `SessionEntry`. The generic `P` covers
   both — no behavior change intended in clauctl.

## Also picked up by the next sync

`parseJsonInput` was **removed** from pictl's `core/read-input.ts` (its
only consumer died with pictl's `parseTreeInput`). Verified unused in
clauctl — the regenerated `src/core/generated/read-input.ts` just loses a
dead export.

## Verification

- `node scripts/sync-from-pictl.mjs --check` passes after regeneration.
- Existing tree tests (`src/format/tree.test.ts`, `src/core/tree.test.ts`,
  TUI selector tests) pass unchanged — this is a pure dedupe.

## Suggested skills

- `/reviewer` for a fresh-context review; the change should be small and
  mechanical, so a full `/spec` is likely overkill unless signatures drift.
