# Spec: get-context — the context tree as the one source of context and leaf

> Status: **implemented (2026-09-07).** Follow-up to
> docs/specs/context-tree.md (phase C review round 70ab34e). Derisk
> discussion rounds are summarized in the WORK LOG.

# SPEC

## Problem

`get-messages` is answered two ways: from the SDK's `getSessionMessages`
by default, and from a daemon-held `GetMessagesOverride` after a
`set-context`, because `getSessionMessages` reports the wrong chain when
the file ends in a boundary (docs/derisk/compact-boundary-injection
FINDINGS P9). The override comes with a "synthesis window", an
`installedAtLeaf` staleness pin, and startup reconstruction — bookkeeping
about _when the SDK path becomes right again_. Meanwhile the context tree
(`ContextTree.contextAt`, docs/specs/context-tree.md) already answers "the
assistant context at any occurrence" from the file alone, and
`loadedContext` — the loader model the override chain was taken from —
survives in five product call sites as a second implementation of the
same relation.

Wanted:

- **One source.** The context at a tip is `contextTree.contextAt(tip)`;
  the current tip is `contextTree.leaf`. Every product use of
  `loadedContext` is replaced; `loadedContext` remains only as the test
  oracle behind `context-check.ts`.
- **`get-context`**, replacing `get-messages`: the assistant's context at
  the current leaf, or at any occurrence with `--at <ref>`. The name says
  what the subcommand answers; `get-messages` was named after the SDK
  method it no longer calls.
- **Delete `daemon/get-messages.ts`** and everything that existed only to
  keep the SDK answer honest.
- **Tree selector picks through the context tree**: the summary pick's
  fresh-compaction context is `contextAt` of the block's tip; the boundary
  undo's pre-boundary tip is the leaf of the context tree over the file
  prefix.
- **Verbatim entries, no projection.** `get-context` returns the
  context's `SessionEntry` records as the file holds them — isMeta
  prompts, `system` and `attachment` entries included, the same record
  shape `get-entries` uses. Which of those become API content is stage-5
  wire normalization, unmodeled and the subject of the planned
  ground-truth check; a filter here would be a guess (the old
  `getSessionMessages`-mirroring projection silently dropped isMeta
  entries the assistant sees — see docs/thoughts/subagent-activity.md).
  Consumers project: `format messages` already accepts entries input.
  isMeta rows get their own glyph in the tree.

## Success criteria

1. `get-context` on a session whose file ends in a boundary (any shape:
   up_to with summary, from-shape, no-summary rewind, wipe) returns the
   context the loader would load — the same list the deleted override
   produced — with no daemon state consulted beyond the file. Restarting
   the daemon between the `set-context` and the `get-context` changes
   nothing.
2. `get-context --at <ref>` returns `contextAt(ref)` mapped to messages,
   for a raw ref and for a relinked ref `X@B`; an absent ref is a request
   error (`… is not a context-tree occurrence`); a session with no entries
   returns `[]`.
3. `get-entries.leaf`, `get-context`'s default tip, the `contextChanged`
   leaf after `set-context`, and the startup seed's context all derive
   from `ContextTree.leaf` over the same file read. `get-context` equals
   `contextAt(get-entries.leaf)` by construction.
4. `contextAt(ContextTree.leaf)` presents the same context as
   `loadedContext` over the whole file, for every fixture and real file the
   existing `context-check` covers, except where the two are documented to
   differ (re-persisted duplicates: first-wins vs last-wins; trailing
   non-turn entries: see Edge cases). Whole-file rather than per settled
   prefix — see Implementation-Time Decisions.
5. `get-context` output is the `contextAt` path's entries verbatim:
   isMeta, `system`, and `attachment` entries on the path are present with
   their file fields; `clauctl get-context | clauctl format messages`
   renders as `format messages` over entries does. `format tree --filter
all` renders isMeta rows with the meta glyph; the default filters hide
   them as today.
6. Every `/tree` pick is a rewind to a context-tree occurrence (or the
   empty context): a real user prompt (`userWithText`) → its context-tree
   parent, with the prompt's text as editorText; summary and boundary →
   the compaction's tip (up_to: `P.last@B`, else the summary;
   the other candidate when that one is not an occurrence; null when
   neither is); anything else → itself. (Amended in review; see WORK LOG.)
7. `src/core/daemon/get-messages.ts`, `GetMessagesOverride`,
   `loadedContextUuids`, and the `get-messages` request/subcommand no
   longer exist; `loadedContext` has no importer outside
   `tree/context-check.ts` and its own tests.
8. Existing tests stay green except where they assert removed behavior
   (the SDK-divergence, synthesis-window, and field-for-field parity
   tests are deleted; `entryToSessionMessage` and its test are untouched).

## Examples

File `u1 a1 u2 a2`, then `set-context --rewind-to a1 u2` (no summary;
boundary B, preserved `[u1 a1 u2]`, anchor = B):

- `get-context` → the entries `u1, a1, u2`, verbatim, one JSONL line each.
- `get-entries.leaf` → `u2@B`.
- `get-context --at a2` → `[u1, a1, u2, a2]`; `--at u2` → `[u1, a1, u2]`
  (the raw occurrence); `--at u2@B` → the same list as the default.
- `get-context --at 0000…` → error `contextAt: 0000… is not a
context-tree occurrence`.

Native `/compact` with summary S (up_to, preserved `[u2 a2]`): default
tip `a2@B`; `get-context` → `[S, u2, a2]`. Summary or boundary pick in
`/tree` → `rewindTo a2@B`. From-shape (anchor = B, summary S after the
block): tip = `S`; `get-context` → `[u2, a2, S]`; summary/boundary pick →
`rewindTo S`. A post-compaction prompt `u3` (parented on `a2@B`) picked in
`/tree` → `rewindTo a2@B`, editorText = u3's text.

File ending in a `turn_duration` system entry after `a3`: `leaf` =
that system entry; `get-context` → the entries through `a3` and then the
system entry itself; `get-entries.leaf` reports the system entry, which
the display tree maps to its nearest visible row.

A skill invocation: `u1 (isMeta) a1`. `get-context` → both entries, `u1`
with its `isMeta: true` file field. `format tree --filter all` shows `◌`
for `u1`.

## Type design

```ts
// src/core/tree/context-tree.ts
export class ContextTree {
  /** Where the next turn attaches: the last row of the walk that is not a
   *  boundary row, boundary rows resetting it — so a bare wipe yields null,
   *  an up_to compaction its last preserved relinked row, a from-shape
   *  compaction its summary, and any later entry itself (system and
   *  attachment entries included: the CLI parents turns on them). */
  readonly leaf: TreeNodeRef | null;
  // parentMap, excluded, occurrencesOf, nonExcludedPredecessor, contextAt unchanged
}
// toContextTree: sets leaf during its existing single walk; constructor gains the parameter.

// src/core/session/file.ts — unchanged. entryToSessionMessage stays the
// presentation projection for stream-shaped consumers (TUI replay,
// MessageProjector, format input classification); get-context no longer
// uses it.

// src/core/sdk-socket.ts
// Response data is SessionEntry[]: the assistant context at `at`, or at
// the file's current leaf, entries verbatim in context order. File-derived,
// not an SdkControlRead.
| { type: "get-context"; at?: TreeNodeRef }
// `get-messages` removed.
/** {uuid, viaBoundary?} of uuids from untrusted JSON; throws with `label`
 *  otherwise. Used by parseSetContextRequest (rewindTo) and get-context (at). */
function parseWireTreeNodeRef(value: unknown, label: string): TreeNodeRef;

// src/core/sdk-commands.ts
// "get-context" replaces "get-messages": --at <uuid[@boundary]> (unique
// prefixes accepted), JSONL output (one entry per line) as today.
/** "<uuid>" or "<uuid>@<boundary>" text with unique-prefix resolution
 *  against the session's entry uuids; UsageError naming `flagName` on bad
 *  syntax. Shared by --rewind-to and --at. */
function resolveNodeRefText(text: string, flagName: string, sessionUuids: readonly UUID[]): TreeNodeRef;

// src/core/daemon/request-handlers.ts
export interface RequestHandlerDeps { /* startupEntries removed */ }
// get-context case (inline): flush-wait on agentState.leaf, read, build the
// context tree, tip = at ?? tree.leaf, contextAt → byUuid entries.
// get-entries case: leaf = tree.leaf.

// src/core/daemon/set-context.ts
export interface SetContextShared {
  gate: RwGate;
  setQueryAvailable(available: boolean): void;   // installOverride removed
}
// changedLeaf = toContextTree(buildTree(reread), byUuid).leaf

// src/core/session/seed.ts
// contextRefs = tree.contextAt(tree.leaf) (empty when leaf is null);
// lastAssistantMessage and leaf derive from it as today, under the
// stream fold's eligibility filter (the seed bridges the file into
// stream-shaped state; docs/thoughts/old/get-entries-caching.md (implemented by docs/specs/session-tracker.md)).

// src/tui/components/tree-selector.ts (amended in review; see WORK LOG)
/** A pick is always a rewind; null = the empty context. */
export interface TreePick { rewindTo: TreeNodeRef | null; editorText?: string }
export function resolveTreePick(
  contextTree: ContextTree,
  byUuid: ReadonlyMap<UUID, SessionEntry>,
  pick: TreeNodeRef,
): TreePick;
// summary/boundary → compactionTip(boundary, summary): the first of
// [P.last@B, summary] (up_to) or [summary, P.last@B] (other shapes) that
// is a context-tree occurrence, else null; a real user prompt
// (format/tree.ts userWithText, exported) → its context-tree parent (null
// at a root) + editorText; anything else → {pick}.
// TreePickAction, summaryChainUuids deleted. interactive-mode sends
// {rewindTo} or {uuids: []}.

// src/tui/glyphs.ts
export const META_GLYPH = "◌";
// src/format/tree.ts treeRowGlyph: isMeta user → META_GLYPH, before the user-with-text case.

// src/core/tree/context-check.ts
// leafContextMismatch(entries): the whole file's contextAt(leaf) against
// loadedContext (see Implementation-Time Decisions for why whole-file).

// Deleted: src/core/daemon/get-messages.ts (GetMessagesOverride,
// synthesizeMessages, startupOverride), loader.ts loadedContextUuids,
// request-handlers.ts freshOverride. loadedContext stays exported for
// context-check.ts only.
```

Dependencies: `toContextTree` → `ContextTree` (leaf); request-handlers
get-context → `readEntriesAfterStreamFlush`, `entriesByUuid`, `buildTree`,
`toContextTree`, `entryToSessionMessage`; set-context → `toContextTree`
(changedLeaf); seed → `toContextTree`; tree-selector → `compactBoundaryOf`,
`ContextTree.contextAt`/`.leaf`/`.nonExcludedPredecessor`; sdk-commands
get-context → the `--rewind-to` ref parsing/prefix resolution.

## Data flow

**get-context.** `agentState.leaf` (stream-reported) → flush wait keyed on
`leaf.viaBoundary ?? leaf.uuid` → `readSessionEntries` → `entriesByUuid`,
`buildTree(entries, log)`, `toContextTree` → `tip = request.at ??
tree.leaf` → `null` → `[]`; else `tree.contextAt(tip)` (throws on an
absent `at`) → `byUuid.get(ref.uuid)` per ref → response. No daemon state besides `agentState.leaf` for the wait.

**get-entries.** Same read; `leaf = tree.leaf`.

**set-context.** Unchanged through the append; the post-append re-read
feeds `toContextTree(...).leaf` for the `contextChanged` event; the
override install is gone.

**Startup seed.** `toContextTree(buildTree(startupEntries))` →
`contextAt(leaf)` → usage/model/leaf as today.

**/tree pick.** interactive-mode already builds the context tree for the
display tree; it passes it to `resolveTreePick`, which reads only
`contextTree.parentMap` and `byUuid` (summary pick: boundary =
`byUuid.get(summary.parentUuid)`; boundary pick: summary = the
`isCompactSummary` entry parented on it). The daemon's `set-context
rewindTo` accepts any occurrence and writes `contextAt(rewindTo)`.

## Cost

Per `get-context`/`get-entries` request: `buildTree` + `toContextTree`
over the whole file (two O(n) passes, two maps), the same price the TUI
pays client-side per `get-entries`. Concentrated in the daemon on chatty
pollers. The boundary pick builds a second context tree over a prefix — a
user action, negligible. The rolling-daemon follow-up
(docs/thoughts/old/get-entries-caching.md (implemented by docs/specs/session-tracker.md)) caches exactly `entries`, `byUuid`,
and the context tree; `leaf` as a per-row assignment is what that cache
maintains incrementally.

## Edge cases

- **Leaf vs the stream's leaf.** `agentState.leaf` folds only user/assistant
  stream messages; `tree.leaf` is the last row of any kind, so after a turn
  they differ (`turn_duration` vs the assistant). Same `contextAt`
  messages; the flush wait keys on `agentState.leaf` as today. Kept as is.
- **Leaf vs the loader's tip.** `loadedContext` climbs to the nearest
  user/assistant before appending; `tree.leaf` does not, so a trailing run
  of system/attachment entries is on `contextAt(leaf)` but not on the
  loader's list (the next turn parents on it; the request builder sends
  none of them). The context-check climbs the raw chain the same way
  before comparing whole contexts.
- **Excluded leaf.** A trailing thinking-only assistant or dangling tool
  call is the leaf; `contextAt` drops it from the path. Nothing special.
- **Deferred block.** A block whose anchor never arrives is flushed at end
  of file by `buildTree`, so a file ending at an up_to boundary without its
  summary still yields `leaf = P.last@B`.
- **Parallel tool result order.** `contextAt` linearizes groups in file
  order; the loader uses the CLI's splice order. `get-context` output
  therefore orders same-message tool results by file order — a documented
  deviation from `getSessionMessages` (the request builder merges them into
  one user message; block order is not observable in the API call).
- **Rejected relink, summary or boundary pick.** No `@B` occurrences
  exist; the tip falls to the summary (context = the summary alone) or,
  without one, to null (empty context).
- **Wipe boundary pick** → the empty context.

## Non-goals

- Modelling stage-5 wire normalization (which `attachment`/`system`/isMeta
  chain entries become API content). The mitmproxy ground-truth check
  (planned rewrite of scripts/check-context-at.ts) will inform this.
- Changing `entryToSessionMessage` (its isMeta/isSidechain filter is a
  presentation choice for stream-shaped consumers, revisited separately).
- Relaxing `agentState.leaf`'s stream-derived eligibility
  (docs/thoughts/old/get-entries-caching.md (implemented by docs/specs/session-tracker.md), "Two streams, one leaf").
- Retiring `loadedContext` altogether — after the ground-truth check
  replaces it as oracle.
- Daemon-side cached trees (docs/thoughts/old/get-entries-caching.md (implemented by docs/specs/session-tracker.md)) — next.
- `/btw` side questions and subagent activity views
  (docs/thoughts/subagent-activity.md).
- A `get-messages` alias.

# IMPLEMENTATION IDEAS

- `toContextTree` leaf: `let leaf: string | null = null;` in the walk;
  `if (entry.subtype === "compact_boundary") { leaf = null; continue; }`
  then `leaf = id` after `parentMap.set`. Materialization order does the
  rest (relinked block after the boundary; up_to summary before its block,
  from-shape summary after).
- get-context handler shares its read with get-entries — extract nothing;
  both are a few lines and the caching follow-up will restructure them.
- `--at` parsing: `--rewind-to` already parses `uuid[@boundary]` with prefix
  resolution against a `get-entries`; the same code path serves `--at`
  (a shared helper if the flag parsing is not already one).
- Tests to delete: "KNOWN DIVERGENCE: raw getSessionMessages…", "startup
  inside the synthesis window…", "startup after the window closed…", the
  `startupOverride` unit; rename "synthesized get-messages matches raw
  getSessionMessages field-for-field" deleted. Add: `--at` raw and `X@B`,
  `--at` error, default == `contextAt(get-entries.leaf)`,
  restart-independence (criterion 1), isMeta/system entries present.
- Selector tests: existing summary/boundary pick tests keep their
  expectations; the fixture builds a context tree.
- Docs to update: README (get-messages → get-context, `--at`),
  docs/architecture.md:84/99, docs/specs/session-tree-and-set-context.md
  criterion 3 wording, docs/session-views.md §2 (ContextTree is the
  product view; `loadedContext` the loader-fidelity oracle behind
  context-check); seed.ts doc comment.
- `/btw` lead (not this spec): `forkSession` + one-shot `query({resume})`,
  or a probe of the CLI's `side_question` control request through `Query`.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

## 2026-09-07 — derisk rounds (summary)

- Round 1: proposed always-file-derived get-messages via the context tree,
  `--at`, deletion of get-messages.ts; Anton: rename to `get-context`,
  `ContextTree` needs `leaf` (it replaces `loadedContext`), accept the
  tool-result order deviation, remove every product `loadedContext` use.
- Round 2: leaf definition; Anton: leaf = last uuid-bearing row of any
  kind (contextAt owns exclusion), boundary rows reset it. isMeta/
  isSidechain/btw surveyed (docs/thoughts/subagent-activity.md): isMeta is
  context (include, flag, own glyph), isSidechain legacy (keep filtering).
  Non-user/assistant entries stay filtered in the message mapping (stage-5
  unmodeled; SDK shape cannot represent them). Approved.

## 2026-09-07 — critique batch (resolved with Anton, ff7c6b4)

1. Seed leaf keeps the stream fold's eligibility filter (the seed bridges
   file → stream-shaped state); relaxing it is deferred to the two-streams
   discussion in docs/thoughts/old/get-entries-caching.md (implemented by docs/specs/session-tracker.md).
2. get-context returns verbatim `SessionEntry[]`, no projection: which
   system/attachment/isMeta entries reach the API is empirical (stage 5);
   `entryToSessionMessage` (TUI replay, MessageProjector, format input
   classification) is untouched. The isMeta drop went unnoticed because
   check-context-at compares two entry-level models of ours; the
   projection ran after both and the oracle is not the API.
3. `parseWireTreeNodeRef` (sdk-socket.ts) approved.
4. `resolveNodeRefText` (sdk-commands.ts) approved.

## 2026-09-07 — implementation

Implemented per the type design; presubmit green (620 tests). Real-file
check (`scripts/check-context-at.ts` over the 12 largest clauctl
sessions): the whole-file leaf check is clean on 11; the one mismatch
(474b3175) is on a file whose final prefixes already fail the tip probe —
the documented pre-existing loader/tree divergence class, not a leaf
defect. A second file (429cb369) was investigated on a false alarm from
the quadratic probe below: a re-persisted copy of a compaction (line 1452
duplicating line 584), first-wins vs last-wins as documented.

## Implementation-Time Decisions

- **`resolveNodeRefText` wraps the existing `resolveTreeNodeRef`**
  (tree/nodes.ts already parses `uuid[@boundary]` with prefix resolution).
  The helper adds the UsageError with the flag name; its `sessionUuids`
  parameter is `ReadonlySet<UUID>` (what `sessionEntryUuids` returns), not
  the spec's `readonly UUID[]`. setContext keeps its pre-connect syntax
  precheck (it exists to avoid a pointless daemon revival on malformed
  input); getContext resolves after connecting, fetching `get-entries` only
  when a half is a prefix.
- **loader.test.ts keeps a test-local `loadedContextUuids`** so the loader's
  own tests need no rewrite when the exported projection is deleted.
- **format/tree.test.ts's "get-entries leaf composition" test** switches
  its leaf to `toContextTree(...).leaf` (it documents the handler's
  composition, which changes); context-tree.test.ts keeps importing
  `loadedContext` as the criterion-1 oracle.
- **Leaf check is whole-file, not per settled prefix** (success criterion
  4 narrowed). The leaf is a property of one materialization walk, so a
  per-prefix check rebuilds the tree per prefix — O(n²), 15k-entry files
  did not finish in 5 minutes. `leafContextMismatch(entries)` checks the
  whole file at O(n); coverage comes from running it over many files. The
  per-prefix leaf check returns once the tree is built incrementally (the
  `tail -f` model), against the mitmproxy-captured request rather than the
  loader model (comment in context-check.ts).
- **Review amendment (Anton, 17cc947 round): `/tree` picks resolve on the
  context tree alone.** Since `set-context rewindTo` accepts any
  context-tree occurrence (70ab34e round), the assistant-only rewind target
  that shaped `resolveTreePick` — nearest-assistant climb over the full
  tree, `setChain` for summaries, `newRoot` — was a fossil. A pick is
  always "rewind to the state at X": a real user prompt (`userWithText`:
  typed text, not isMeta, not a tool result) → its context-tree parent
  (the state before the prompt; system/attachment parents included);
  summary and boundary → the compaction's tip; anything else → itself (the
  boundary pick keeps the boundary rather than undoing it — undo is the row
  above). The display tree is not the resolution object: it collapses
  occurrences (hidden matched blocks re-anchor on raw rows), and a rewind
  target is an occurrence. `fullTree`, `entries`, `onInvalid` leave the
  signature; the pre-boundary prefix tree is gone. Changes on the old
  behavior: a post-compaction user pick rewinds to its parent (`u@B`)
  rather than the nearest assistant; a rejected-relink summary pick
  rewinds to the summary alone instead of user-row semantics.
- **get-context and get-entries share one handler case**: same gate, same
  flush wait, same file read and tree build; they diverge only at the
  return. Avoids duplicating the read-consistency logic.

Checklist:

- [x] ContextTree.leaf
- [x] context-check leaf comparison (whole-file; see above)
- [x] META_GLYPH
- [x] parseWireTreeNodeRef; resolveNodeRefText
- [x] get-context request/handler/subcommand; get-messages removed
- [x] get-entries leaf, set-context changedLeaf, seed via the tree
- [x] get-messages.ts deleted; override plumbing removed
- [x] tree-selector via context tree; loadedContextUuids deleted
- [x] tests and docs
