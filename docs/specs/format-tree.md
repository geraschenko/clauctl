# Spec: `clauctl format tree` — readable rendering of the session tree

> **Superseded (layout):** the indented layout described here is replaced
> by the renderdag DAG rendering of `docs/specs/tree-presentation.md`;
> filters and `entrySummary` remain as specified here.

> Status: **implemented; superseded (layout) by docs/specs/tree-presentation.md.** Follow-up to
> `docs/specs/format.md` (which deferred `format tree`) and
> `docs/specs/session-tree-and-set-context.md` (which shipped `get-tree`).
> Prerequisite: the pictl-side tree-layout extraction
> (`pictl/docs/specs/tree-layout-extraction.md`).

## SPEC (stable requirements)

### Problem

`get-tree` emits the session forest as raw JSON — unreadable for a human and
uneconomical for an LLM, exactly the gap `format messages`/`format events`
close for their inputs. `clauctl format tree` renders it as an indented tree,
one line per visible entry, matching the behavior of `pictl format tree`.

The tree's consumers choose `set-context` targets, so the rendering must show
_where the session currently is_: `get-tree`'s response today carries no
current-leaf information at all. This spec also reshapes that response.

### Command surface

- **`clauctl format tree [file]`** — formats `get-tree` output (one JSON
  document). `[file]` optional, `-` or absent = stdin. Flags:
  - `--filter conversation|no-tools|user-only|all` (default `conversation`)
  - `--width <num>` (default 120) — total line width; summaries truncate to fit.

  It does NOT take the `format messages`/`events` flags (`--tool-results`
  etc.) — there are no tool-result bodies in a tree line.

### Scope changes to existing commands

`get-tree`'s response is reshaped (socket protocol change; the CLI printing
stays a single pretty-printed JSON document):

- `TreeNode` embeds its entry (`entry: SessionEntry`) instead of carrying
  `entryUuid` alongside a shared `entries` record. The record's payload
  sharing existed for the future boundary-substructure's duplicate nodes;
  embedding means those will serialize their payload once per node —
  accepted (decided 2026-07-16) in exchange for a self-contained format
  input and near-verbatim reuse of pictl's rendering code.
- `SessionTree` becomes
  `{ tree: TreeNode[]; leaf: { uuid: UUID; viaBoundary?: UUID } | null }`.
  `leaf` names the **current-leaf occurrence** — the position the next turn
  attaches to. `leaf.uuid` is the tip of the daemon's current effective
  context: the last element of the effective chain, minus a live filterTail
  override's `droppedUuids` (so a no-write rewind moves the leaf to the
  rewind target). The override is consulted with the same freshness
  rule `get-messages` applies (stale once `lastTranscriptUuid` moves).
  `null` when the session file has no chain entries.
- **Occurrence identity is the pair `(entry uuid, viaBoundary)`** (decided
  2026-07-16). Once the boundary substructure sets `viaBoundary`
  (`docs/specs/boundary-substructure.md`), the same entry uuid can appear at
  multiple tree positions, so a bare uuid cannot name "the" leaf — and the
  distinction matters: per the session-tree spec's TUI mapping, a raw
  occurrence and a viaBoundary occurrence of the same uuid map to
  _different_ set-context actions. The pair suffices because duplicates only
  arise from relink edges and every relink-edge node carries `viaBoundary`
  (raw placement is unique per uuid — each entry appears once in the file),
  provided one boundary's rendered chain never repeats a uuid: true for
  valid data (set-context rejects duplicate uuids; the CLI loader silently
  skips a relink containing them). The substructure `buildTree` implements
  the same skip for degenerate hand-edited boundaries — the synced layout
  treats unique layout ids as a checked precondition and throws on
  duplicates, so a violation would crash `format tree` rather than merely
  rendering oddly. `leaf.viaBoundary` mirrors the node field.
- `buildTree` returns the forest only (`TreeNode[]`); the get-tree handler
  composes the `SessionTree`.

### Rendering rules

Behavioral parity with `pictl format tree`; the layout geometry comes from
the same code, synced from pictl (see Type design). No ANSI, ever.

- One line per visible node:
  `<gutters/connector><marker><uuid8> <summary>`, right-truncated so the
  whole line fits `--width`, trailing whitespace trimmed.
  - `<uuid8>` = the first 8 characters of the entry uuid. (Full uuids are
    the machine handle; a later spec makes `set-context` accept unique
    prefixes.)
  - `<marker>` = `*` on the current leaf, `•` on its ancestors, empty
    otherwise.
- **Active path = tree-edge ancestry**: the walk from the leaf occurrence's
  node to its root follows the tree's parent edges (NOT raw `parentUuid` — they
  diverge at boundary nodes, which hang under `logicalParentUuid`). This is
  genealogy, not effective context: after a compaction, the walk runs
  through the preserved tail's raw ancestry, so the summarized-away region
  is marked while the boundary and summary nodes — which ARE in context —
  sit on an unmarked side branch. Accepted consequence (decided 2026-07-16):
  it is the honest raw-forest lineage, and representing "lineage through the
  boundary" is exactly what the boundary-substructure follow-up's duplicate
  nodes are for.
- At every fork, the branch containing the active path sorts first. A single
  root renders unindented; multiple roots hang under a virtual root (one
  extra connector level, like pictl).
- After filtering, the visible structure is recomputed: a visible node whose
  parent was filtered out re-attaches to its nearest visible ancestor, so
  connectors and gutters stay correct.
- Last line, always: `[cursor: <leaf.uuid>]` (full uuid, no viaBoundary
  qualifier — the cursor feeds uuid-taking commands), or `[cursor: null]`
  when there is no leaf. An empty tree renders just the cursor line.

Per-entry summaries (each one-lined, truncated to the remaining width):

| entry                                               | summary                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user, text content (incl. mixed text + tool_result) | `user: <text>`                                                                                                                                                                                                                                                   |
| user, `isCompactSummary`                            | `compaction: <text>`                                                                                                                                                                                                                                             |
| user, tool_result blocks only                       | `<Name>: ok` / `<Name>: error` — name via an id→name pre-pass over all entries' `tool_use` blocks; first block names the line, `error` if any block has `is_error`                                                                                               |
| assistant                                           | `assistant:` + parts joined by spaces: `[thinking]` if a thinking block, `[tool: Name]` per tool_use block, the text one-lined; no text and an abnormal `stop_reason` (present, not `end_turn`/`tool_use`) → `(<stop_reason>)`; no parts at all → `(no content)` |
| system, `compact_boundary`                          | `[compaction: <N>k tokens]` from `compactMetadata.preTokens` (rounded); `[compaction]` if absent                                                                                                                                                                 |
| anything else                                       | `<type>` or `<type>: <subtype>`                                                                                                                                                                                                                                  |

Filter modes (a hidden node's visible descendants re-attach, per above; per
the 2026-07-14 decision, nothing is dropped unconditionally — anything
hidden is hidden by a filter mode and visible under `all`):

- **`conversation`** (default): user entries with text content (hides
  tool_result-only and `isMeta` entries; keeps `isCompactSummary`),
  assistant entries with text OR an abnormal `stop_reason` OR that are the
  current leaf, and `compact_boundary` entries.
- **`no-tools`**: everything except tool_result-only user entries and
  tool-use-only assistant entries. The current-leaf exemption applies to the
  assistant suppression only (pictl parity): a tool_result leaf is still
  hidden, and the `*` marker simply doesn't appear.
- **`user-only`**: only user entries with text content (non-meta,
  non-tool-result-only; includes `isCompactSummary`).
- **`all`**: every tree node, no suppression. (Deviation from pictl's
  `pi-all`, which still suppresses tool-only assistants; our `all` is the
  escape hatch, `no-tools` is the suppressing mode.)

### Concrete example

`clauctl get-tree A | clauctl format tree` (illustrative; exact geometry is
pinned by the synced layout code):

```
• 0a1b2c3d user: Fix the failing test in src/foo.test.ts
• 4e5f6a7b assistant: The assertion is stale after the rename; fixing it.
├─ • 8c9d0e1f user: Actually, revert that and mock the clock instead
│  • 2a3b4c5d assistant: Mock in place; tests green.
│  * 6e7f8a9b assistant: Added the edge-case regression test too.
└─ 4a5b6c7d user: What does the timeout in foo.test.ts actually guard?
[cursor: 6e7f8a9b-9dd5-4524-bb56-d8aaeb982094]
```

A compaction, under `conversation` (boundary + summary visible, off the
active path):

```
• 815b1fad user: Set up the build and get the tests running
• 54a37d1c assistant: Build green; three tests failing.
├─ • 309f0cfc user: Fix the first failure
│  * 7844a932 assistant: Fixed; two failures left.
└─ c8afccff [compaction: 42k tokens]
   59e71878 compaction: Earlier we set up the build; the failing test is…
```

### Type design

**pictl prerequisite** (`pictl/docs/specs/tree-layout-extraction.md`): the
entry-type-agnostic layout geometry of pictl's `src/format/tree.ts` moves to
an import-free `src/format/tree-layout.ts`, with the two `entry.parentId`
walks (active path, filtered re-attachment) replaced by tree-parent-map
walks — behavior-identical in pi, required here. clauctl syncs it verbatim:

**`src/format/generated/tree-layout.ts`** (synced; `scripts/sync-from-pictl.mjs`
format set gains `tree-layout.ts`):

```ts
/** Structural tree node; each consumer adapts its own node type via one O(n) map. */
export interface LayoutNode<P> {
  readonly id: string;
  readonly children: readonly LayoutNode<P>[];
  readonly payload: P;
}
export interface TreeGutter {
  readonly position: number;
  readonly show: boolean;
}
export interface FlatLayoutNode<P> {
  readonly node: LayoutNode<P>;
  readonly indent: number;
  readonly showConnector: boolean;
  readonly isLast: boolean;
  readonly gutters: readonly TreeGutter[];
  readonly isVirtualRootChild: boolean;
  readonly isOnActivePath: boolean;
  readonly isCurrentLeaf: boolean;
}
/** flattenAll → active path (tree-parent walk from currentLeafId) → filter →
 *  recalculateVisibleStructure. The predicate closes over whatever it needs
 *  (filter mode, current-leaf exemptions); pass `() => true` for the full
 *  unfiltered list. */
export function flattenVisibleTree<P>(
  roots: readonly LayoutNode<P>[],
  currentLeafId: string | null,
  passesFilter: (node: LayoutNode<P>) => boolean,
): readonly FlatLayoutNode<P>[];
export function treePrefix(flatNode: FlatLayoutNode<unknown>): string;
```

**Anticipated consumer — TUI `/tree`** (a later spec; recorded here because
it shaped the API): a clauctl TUI tree navigator à la pi's `/tree` is the
same pipeline with interactive state on top. pi's `TreeSelectorComponent`
holds flatten → filter → visible-structure-recalc as instance state and
re-runs it per filter toggle, adding only selection index, scroll viewport,
keybindings, and themed rendering — which is why `tree-layout.ts` (itself
descended from pi's TreeSelector via pictl) stays pure: no ANSI, no I/O,
filter as an injected predicate, `isOnActivePath`/`isCurrentLeaf` as data.
The TUI reuses `flattenVisibleTree` as-is (calling it twice — once with an
always-true predicate — where pi keeps both full and filtered lists for
nearest-visible-selection on filter switches) plus `tree.ts`'s
`entrySummary`/`passesFilter`, which therefore stay standalone functions and
get exported when that spec lands. Selection, scrolling, and theming are
TUI-side; nothing here renders differently to accommodate them.

**`src/core/build-tree.ts`** (reshaped):

```ts
export interface TreeNode {
  entry: SessionEntry; // was entryUuid; the SessionTree entries record is deleted
  children: TreeNode[];
  viaBoundary?: UUID; // unchanged; set by the boundary substructure
}
export interface SessionTree {
  tree: TreeNode[];
  /** The current-leaf occurrence — where the next turn attaches. uuid =
   *  tip of the current effective context, daemon-computed (the effective
   *  chain minus a live filterTail override). viaBoundary mirrors the node
   *  field and identifies the occurrence once duplicates exist. Null when
   *  the session has no chain entries. */
  leaf: { uuid: UUID; viaBoundary?: UUID } | null;
}
export function buildTree(entries: SessionEntry[]): TreeNode[]; // forest only
```

**`src/core/daemon/request-handlers.ts`** — the get-tree case composes
`{ tree: buildTree(entries), leaf }`, sharing the override-freshness
check with the get-messages case (calls `effectiveChain`).

**`src/format/tree.ts`** (clauctl-specific rendering):

```ts
export const FILTER_MODES = [
  "conversation",
  "no-tools",
  "user-only",
  "all",
] as const;
export type FilterMode = (typeof FILTER_MODES)[number];
export interface TreeFormatOptions {
  filter: FilterMode;
  width: number;
}
/** Whole-input formatter for `format tree`: adapts TreeNode[] to
 * LayoutNode<SessionEntry>[], calls flattenVisibleTree, renders lines +
 * the cursor line. Layout ids are adapter-internal occurrence composites —
 * `uuid` when the node has no viaBoundary, else `${uuid}@${viaBoundary}`
 * ("@" cannot appear in a uuid) — and currentLeafId is the same composite
 * over `input.leaf`. Unique layout ids are a checked precondition of the
 * synced layout: `flattenVisibleTree` throws on duplicates, so an adapter
 * bug fails loudly. Entry summaries and filters are private helpers here
 * (split into a filter.ts later only if another subcommand grows filtering). */
export function formatSessionTree(
  input: SessionTree,
  options: TreeFormatOptions,
): string;
```

**`src/format/input.ts`**:

```ts
/** One JSON document with a `tree` array and a `leaf` that is null or an
 * object with a string `uuid` (and optional string `viaBoundary`).
 * Tail-shaped or session-entry JSONL input → UsageError pointing at the
 * other subcommands. */
export function parseSessionTree(input: string): SessionTree;
```

`parseSessionEntries` and `parseTailRecords` gain the reverse hint: input
that is a single object with a `tree` array → UsageError "looks like
get-tree output; use `clauctl format tree`".

**`src/format/command.ts`** — `tree` subcommand on the existing `format`
routemap; flags `filter` (enumFlag over `FILTER_MODES`) and `width`
(parsedFlag, positive integer), same optional file positional.

**Modified files:** `src/core/build-tree.ts`, `src/core/sdk-socket.ts`
(get-tree response comment), `src/core/daemon/request-handlers.ts`,
`scripts/sync-from-pictl.mjs` (format set gains `tree-layout.ts`),
`src/format/{tree,input,command}.ts`, plus tests
(`build-tree.test.ts`, `request-handlers.test.ts` fixtures reshaped).
`docs/specs/session-tree-and-set-context.md` gets a work-log note recording
the response reshape.

### Success criteria

1. `clauctl get-tree A | clauctl format tree` on a session with a branch
   point and a compaction renders both branches, the boundary and summary
   nodes, `•`/`*` markers along the tree-edge ancestry of the leaf, and the
   trailing full-uuid cursor line.
2. `get-tree` returns `{tree, leaf}`; after a no-write rewind, `leaf.uuid`
   is the rewind target (filterTail override consulted, freshness rule
   shared with get-messages); after a boundary append, it is the new
   effective tip. `leaf.viaBoundary` is absent (raw forest).
3. Each `--filter` mode shows/hides per its definition; filtered parents
   re-attach children without breaking connectors; `all` shows every node.
4. Wrong-shape input fails with cross-pointing `UsageError`s in all
   directions (tree ↔ messages ↔ events).
5. `node scripts/sync-from-pictl.mjs --check` passes with the synced
   `tree-layout.ts`; pictl's own tests are unaffected (pictl-side criterion).
6. Unit tests cover: marker placement and active-branch-first ordering,
   multi-root virtual root, filter re-attachment, every summary row of the
   table above, width truncation, empty tree, leaf-not-in-tree degradation
   (no markers, cursor still prints), a hand-built input with a duplicated
   uuid where only the `viaBoundary`-matching occurrence gets `*` (the
   composite-id contract, testable before the substructure lands), and the
   UsageError paths.

### Edge cases

- Empty session / no chain entries → `leaf: null`, `format tree` prints
  only `[cursor: null]`.
- `leaf` matching no tree node (shouldn't happen) → no `*`/`•` markers;
  cursor line still prints `leaf.uuid`.
- Uuid-less entries (`file-history-snapshot`, `queue-operation`) have no
  tree node (unchanged `buildTree` behavior) and thus never render.
- `leaf.uuid` inherits `effectiveChain`'s documented tip-selection limitation
  (uuid-bearing attachment/sidechain entries could win the tip); already
  flagged in session-tree-and-set-context.md, not worsened here.
- Sidechain entries (`isSidechain`) render like any user/assistant entry;
  current CLIs put sidechains in separate session files, so they effectively
  don't appear.

### Non-goals

- Boundary-substructure rendering (duplicate nodes, `viaBoundary`) — the
  follow-up spec, `docs/specs/boundary-substructure.md` (the composite-id
  adapter here needed no changes when it landed).
- TUI `/tree` (interactive navigation) — anticipated consumer, see the note
  in Type design; no TUI code in this spec.
- Prefix-accepting `set-context` uuids — later spec (the cursor line prints
  the full uuid until then).
- Labels (`pi-labeled-only` has no clauctl analog), `--timestamps`,
  streaming input.

## IMPLEMENTATION IDEAS (evolving)

- Sequencing: (1) pictl lands the tree-layout extraction (handoff doc in
  `pictl/docs/specs/tree-layout-extraction.md`, written alongside this
  spec); (2) clauctl syncs and builds the rest. Everything except the synced
  file and the sync-script line is implementable against a hand-copied
  `tree-layout.ts` if we want to parallelize, but the sync `--check`
  criterion needs the pictl side landed.
- The abnormal-`stop_reason` exemption needs one empirical check during
  implementation: how aborted/errored assistant turns actually appear in
  real Claude session files (pi records `stopReason: "aborted"` /
  `errorMessage`; the Claude analog is unverified — interrupts may only
  leave user-side text). The filter rule is written to degrade safely: if no
  abnormal stop_reasons exist in practice, the clause simply never fires.
- The reverse hint in `parseSessionEntries`/`parseTailRecords` needs a
  whole-document check BEFORE the per-line JSONL parse: `get-tree` output is
  pretty-printed, so its first line is just `{` and line-parsing throws a
  generic JSONL error first. Pattern: input trimmed starts with `{` AND
  parses as one JSON object with a `tree` array → the cross-pointing error
  (same try-single-object-first shape as pictl's `parseEntriesInput`).
- The id→name pre-pass for tool_result naming is a walk over ALL entries
  (not just visible ones), same memoization idea as `FormatState.toolNames`
  but tree-local and immutable — build the map once before rendering.
- get-tree handler: extract the override-freshness check ("drop when
  `installedAtLeafUuid !== lastTranscriptUuid`") from the get-messages case
  into a closure-local helper both cases call; get-tree then subtracts
  `droppedUuids` from `effectiveChain(entries)` and takes the last remaining
  uuid. The synthesize variant needs nothing: `effectiveChain` over the
  re-read file already reflects the appended boundary.
- Test fixtures: reuse the branch+boundary jsonl style from
  `build-tree.test.ts`; a fixture with a filterTail override exercises
  criterion 2 (request-handlers.test.ts already builds that state for
  get-messages tests).
- Geometry tests: adapt pictl's `format.test.ts` tree cases (gutters,
  virtual root, re-attachment) to clauctl fixtures rather than inventing new
  shapes — parity is the point.

## WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-16: Derisk discussion with Anton; spec written. Decisions:
  `TreeNode` embeds its entry (wire duplication of future duplicate-node
  payloads accepted); `SessionTree` = `{tree, leafUuid}` with
  daemon-computed leaf (effectiveChain minus filterTail override — the
  override consultation was flagged during derisk and confirmed); active
  path = tree-edge ancestry walk, NOT effectiveChain (genealogy semantics,
  matching pi's own crossing of compactions; boundary/summary off-path in
  the raw forest is an accepted consequence until the substructure spec);
  uuids render as 8-char prefixes, cursor line keeps the full uuid until
  prefix-accepting set-context lands; filter set conversation/no-tools/
  user-only/all with `all` truly unfiltered (deviation from pi-all noted);
  layout geometry extracted pictl-side into an import-free, syncable
  `tree-layout.ts` (payload-adapter `LayoutNode<P>` shape over accessor
  callbacks; parentId walks become tree-parent-map walks) — handoff doc
  written to `pictl/docs/specs/tree-layout-extraction.md`.
- 2026-07-16 (later): TUI-`/tree` anticipation round after checking pi's
  `TreeSelectorComponent`: the selector is this same pipeline plus
  selection/scroll/keys/theming, so no structural change was needed — but
  `flattenTreeForFormat` was renamed `flattenVisibleTree` before the API
  froze (a second consumer was already planned; renaming a synced file later
  touches two repos), and the anticipated-consumer note was added to Type
  design (twice-called flatten for full+filtered lists; summaries/filters
  stay standalone). Handoff doc updated to match.
- 2026-07-16 (duplicate-id round): Anton flagged (while reviewing the pictl
  handoff) that a bare `leafUuid` breaks once the substructure follow-up
  produces duplicate nodes — and the pictl-side layout was hardened for
  duplicate ids (reference keying, every-matching-occurrence semantics; see
  the handoff's same-date work log). clauctl-side resolution: a daemon-set
  `isCurrentLeaf` node flag was considered and rejected (Anton) in favor of
  the occurrence pair `(uuid, viaBoundary)` — the discriminator is already
  node data, `buildTree` stays pure, and the response stays declarative.
  `SessionTree.leafUuid` became `leaf: {uuid, viaBoundary?} | null`; layout
  ids are adapter-internal composites (`uuid` / `uuid@viaBoundary`, plain
  concatenation over hashing for debuggability), keeping the synced
  layout's unique-id assumption true; the cursor line prints `leaf.uuid`
  only (Anton's call). Recorded assumption handed to the substructure
  follow-up: pair uniqueness requires that a boundary's rendered chain
  never repeats a uuid — valid data guarantees it (set-context rejects
  duplicates; the loader skips degenerate relinks), and the follow-up's
  buildTree must mirror the loader's skip.
- 2026-07-16 (pi-diffability round, pictl `bdb98fe`): Anton overturned the
  pictl-side reference-keying decision — the layout file must stay
  structurally diffable against pi's `TreeSelector`, so internals stay
  id-keyed and duplicate layout ids become a **checked precondition**
  (`flattenVisibleTree` throws, one Set pass while flattening) instead of a
  tolerated input. clauctl consequences: the composite ids already satisfy
  the precondition for valid data (nothing to change in the design); the
  formatSessionTree doc comment's "every-matching-occurrence semantics
  stays a robustness guarantee" wording was replaced with the precondition
  statement; and the substructure follow-up's obligation hardened from
  "assumption recorded" to "must implement the degenerate-boundary skip" —
  violating it now crashes `format tree` instead of rendering oddly.
- 2026-07-16 (implemented): pictl landed the extraction (`cfd664b`);
  clauctl side implemented per the type design. All criteria except the
  live-daemon end-to-end (criterion 1) are covered by tests — 261 pass,
  sync `--check` green. The rendering was smoke-tested through the real
  CLI on a buildTree-generated document, matching the spec's first
  example.

### Implementation-Time Decisions

- **Multi-root rendering pins a pictl↔pi divergence.** pi's TreeSelector
  shifts EVERY node's display indent left by one under multiple roots
  (`tree-selector.ts` renderTree `displayIndent`), while pictl's
  `treePrefix` shifts only the virtual-root children themselves — so
  virtual-root children render flush without connectors, and deeper
  multi-root trees show connectors one level right of their gutters
  (probe: a fork under a multi-root root renders `├─ …` with its
  grandchild gutter at column 0). pictl's `tree-layout.test.ts` pins this,
  the extraction handoff required byte-identical output, and this spec
  defines parity as "whatever the synced code does" — so clauctl pins it
  too (`tree.test.ts` multi-root test) rather than unilaterally changing
  the synced file. Multi-root DOES occur in clauctl (a boundary without
  `logicalParentUuid` roots itself), so if the misalignment matters it
  should be fixed pictl-side (where pi-diffability argues for adopting
  pi's all-nodes shift) and resynced. The spec sentence "one extra
  connector level, like pictl" describes the indent shift the virtual
  root imposes on descendants, not a connector on the roots themselves.
- **Uuid-less nodes in hand-crafted parse input** are not validated away:
  the adapter stringifies `entry.uuid` (`"undefined"` for a missing one),
  and two such nodes collide in the layout's duplicate-id guard. Lenient
  by the same policy as `format messages` (verbatim entries drift);
  `buildTree` output never contains them.
- **`freshOverride` helper** (request-handlers.ts): the get-messages
  staleness check moved into a closure-local helper as planned; get-tree
  filters `effectiveChain` through it inline in the shared
  get-entries/get-tree case, after an early `get-entries` return.
- **Fallback names**: entries with no `type` summarize as `unknown`
  (`<type>[: <subtype>]` needs something to print); unnamed tool results
  and tool_use blocks fall back to `tool`, matching `sdk-message.ts`'s
  existing fallback.
