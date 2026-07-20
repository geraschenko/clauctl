# Session Snapshot and Tree

Supersedes the `get-tree` portions of
[session-tree-and-set-context.md](session-tree-and-set-context.md).

# SPEC

## Problem

`get-tree` serializes the session tree as _nested_ JSON (`TreeNode` with
recursive `children`). A mostly-linear session nests one level per entry, and
`JSON.stringify` overflows the call stack near depth ~5000, so resuming or
attaching to a long session (observed: 5213 entries) **crashes the daemon**
(`RangeError: Maximum call stack size exceeded` in `respond()`). The nested
representation is a tripping hazard with no information advantage: the tree
is a pure function of the flat entries.

## What we want

1. **No nested structures on the wire.** `get-tree` is removed entirely
   (wire type, daemon handler, `clauctl get-tree` command, `parseSessionTree`).
   Clients build the tree locally from flat entries via shared code.
2. **`get-entries` returns a `SessionSnapshot`** — every file entry verbatim
   plus the daemon's context tip: `leaf` is the effective-chain tip minus a
   live filterTail override's dropped uuids — exactly `get-tree`'s leaf
   computation today. It names an occurrence present in `entries`, resolved
   to the correct tree copy (raw or viaBoundary).
3. **The tree is represented flat**: a parent relation over occurrences
   (`ParentMap`), not a recursive node type. The nested `TreeNode` and
   `SessionTree` are deleted. All traversals over session-length data are
   iterative.
4. **The daemon survives serialization failure**: `respond()` degrades to an
   `ok: false` error response instead of crashing.
5. **`format tree` accepts `get-entries` output** (the snapshot document) and
   raw session JSONL (leaf derived by the existing `seedFromEntries` chain
   logic).

## Success criteria

- `clauctl spawn -a -- --resume <5000+-entry session>` attaches without
  crashing the daemon; history renders; `/tree` opens and picks work.
- Fresh agent + attach: empty transcript, no error banner.
- `clauctl get-entries | clauctl format tree` renders the tree.
- `clauctl format tree < ~/.claude/projects/<slug>/<id>.jsonl` renders the
  tree with the chain-derived leaf as cursor.
- A forced-unserializable response produces an error banner client-side; the
  daemon keeps running.
- All existing tests pass (updated where behavior changed); no recursion over
  session-length structures remains in clauctl code.

## Definitions

- **State leaf**: `AgentState.leaf` (renamed from `leafTreeNodeRef`) — the
  attach boundary tracked by the fold.

## Type design

```ts
// tree.ts — the nested TreeNode and SessionTree are DELETED (no replacement
// node type: the structure is logically edges, so a node struct would
// duplicate the map key).
// TreeNodeRef, formatTreeNodeRef, parseTreeNodeRef, treeNodeRefsEqual: unchanged.

/** Child occurrence id → parent occurrence id (null = root). Both sides are
 *  formatTreeNodeRef output: Map keys need strings because JS Maps compare
 *  objects by reference (refs are produced independently — fold, wire,
 *  parse), and the value matches so edges stay in one id space and the map
 *  composes with itself. Iteration order = materialization order: raw
 *  entries at file position, relinked occurrences at their boundary's
 *  summary position. */
export type ParentMap = ReadonlyMap<string, string | null>;

/** get-entries response: every file entry verbatim, plus the daemon-computed
 *  context tip resolved to its occurrence in these entries. */
export interface SessionSnapshot {
  entries: SessionEntry[];
  leaf: TreeNodeRef | null;
}

/** One occurrence with its entry payload — the render/path unit. */
export interface PathNode {
  ref: TreeNodeRef;
  entry: SessionEntry;
}

/** Root-first path to the leaf occurrence; [] when leaf is null or absent.
 *  Iterative parent walk (no recursion); throws on a parent cycle (visited
 *  set) or an occurrence whose uuid is missing from entryOf — both are
 *  corruption, impossible from buildTree + entriesByUuid over the same
 *  entries. PathNode keeps the parsed ref (parseTreeNodeRef once per node);
 *  the walk itself is string-keyed: current = parents.get(current). */
export function pathToLeaf(
  parents: ParentMap,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
  leaf: TreeNodeRef | null,
): PathNode[];

/** Children ids per parent id, roots under null. Materialization order.
 *  Derived by inverting `parents`. */
export function treeChildren(
  parents: ParentMap,
): Map<string | null, string[]>;

/** No child of this occurrence continues the same assistant API message.
 *  False for non-assistant entries. */
export function isFinalAssistantEntry(
  id: string,
  children: ReadonlyMap<string | null, readonly string[]>,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
): boolean;
```

```ts
// build-tree.ts (keeps its name; buildTree reworked in place)
/** Same relink algorithm as before (already iterative), emitting the parent
 *  relation instead of nested nodes. The internal uuid → occurrence map
 *  holds formatted ids, so parent resolution yields the value directly.
 *  Throws on a duplicate occurrence key — valid files cannot produce one,
 *  so a duplicate means the session file is corrupt; the error is loud so
 *  the user learns about it. */
export function buildTree(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): ParentMap;
```

```ts
// session-file.ts — addition
/** Last entry wins on a duplicate uuid; duplicate *detection* is
 *  buildTree's job (it throws), and consumers build the tree from the
 *  same entries before using this lookup. */
export function entriesByUuid(
  entries: readonly SessionEntry[],
): Map<UUID, SessionEntry>;
```

```ts
// request-handlers.ts — get-tree case deleted; get-entries becomes:
//   flush-wait (unchanged key: viaBoundary ?? uuid)
//   → leaf = chain tip minus a live filterTail override's dropped uuids
//     (the leaf computation formerly in the get-tree case, verbatim;
//     freshOverride stays shared by get-messages and get-entries)
//   → { entries, leaf } satisfies SessionSnapshot
// No session: { entries: [], leaf: null }.
```

```ts
// sdk-server.ts — respond() wraps JSON.stringify; on failure it writes
// { id, ok: false, error: "response serialization failed: …" } instead of
// crashing the daemon. The fallback embeds only String(error) — no part of
// the original response data — so it cannot itself fail to serialize.
```

```ts
// sdk-commands.ts — the `get-tree` command is deleted. `get-entries`
// switches from jsonlRequestCommand (iterates the response as an array —
// would break on an object) to bareRequestCommand, printing the snapshot
// as one JSON document; its brief is updated.
```

```ts
// format/tree.ts
/** Iterative adapter to the layout's nested input (replaces recursive
 *  toLayoutNode). Layout ids ARE the ParentMap keys. */
export function toLayoutTree(
  parents: ParentMap,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
): LayoutNode<SessionEntry>[];

/** Flat scan over all entries (needs no tree). */
export function collectToolNames(
  entries: readonly SessionEntry[],
): Map<string, string>;

export function collectFinalAssistantIds(
  parents: ParentMap,
  children: ReadonlyMap<string | null, readonly string[]>,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
): Set<string>;

/** Replaces formatSessionTree. */
export function formatSessionSnapshot(
  snapshot: SessionSnapshot,
  options: TreeFormatOptions,
): string;
```

```ts
// format/input.ts
/** Replaces parseSessionTree. Accepts:
 *  (1) one JSON document with an `entries` array and a `leaf` that is null
 *      or `{uuid: string, viaBoundary?: string}` (same leniency as the old
 *      parseSessionTree: entry elements are validated by the same rule
 *      parseSessionEntries uses — records with a string `type`; uuids are
 *      not syntax-checked; a missing `leaf` property is a UsageError);
 *  (2) raw session-entry JSONL via parseSessionEntries, leaf derived via
 *      the seedFromEntries chain logic (deliberately: the last
 *      user/assistant occurrence, which can differ from the daemon's
 *      chain-tip leaf when a chain ends in a non-conversational entry —
 *      for file rendering the conversational cursor is the useful one).
 *  Tail-shaped input → cross-pointing UsageError. Anything else (including
 *  old get-tree documents) → generic "not a session snapshot" UsageError.
 *  Tree-level corruption (duplicate occurrence keys) is NOT the parser's
 *  job: buildTree throws later, and format commands let that error
 *  surface loudly. */
export function parseSessionSnapshot(input: string): SessionSnapshot;
```

```ts
// TUI
export function pathUpToBoundary(
  path: PathNode[],
  leaf: TreeNodeRef | undefined,
): { nodes: PathNode[]; boundaryMissing: boolean }; // logic unchanged, retyped

// transcript.ts
appendPathNode(node: PathNode): void; // reads only node.entry

// tree-selector.ts
export function resolveTreePick(
  parents: ParentMap,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
  pick: TreeNodeRef,
): TreePickAction;
// TreeSelectorComponent constructor:
//   (leaf: TreeNodeRef | null, parents: ParentMap,
//    entryOf: ReadonlyMap<UUID, SessionEntry>,
//    onSelect: (pick: TreeNodeRef) => void, onCancel: () => void)
// The selector's parentById field dies — the ParentMap IS that map, held
// directly for nearest-visible-ancestor recovery.
// interactive-mode builds parents + entryOf once per get-entries read and
// passes them explicitly (reloadHistory and openTreeSelector both switch
// from get-tree to get-entries).
```

**Renames**: `AgentState.leafTreeNodeRef` → `leaf`;
`SessionFileSeed.leafTreeNodeRef` → `leaf`. ("Leaf" is strictly inaccurate — the
tip need not be a tree leaf — but communicates the meaning: where the next
message attaches. `contextChanged.leaf` and `SessionSnapshot.leaf` already
use it.)

## Edge cases

- **Dead branches stay visible**: `get-entries` returns the file verbatim,
  so after a no-write rewind the abandoned tail remains in the snapshot and
  `/tree` shows it with the cursor moved back — navigating back and then
  forward again without adding an entry keeps working.
- **File ahead of stream**: the snapshot may contain entries the client's
  fold has not confirmed; the client-side cut (`pathUpToBoundary` at the
  client's fold leaf) handles attach consistency, as it does today.
- **Flush-wait key**: remains `viaBoundary ?? uuid` (the boundary entry, not
  its summary — a relinked occurrence fully materializes only at the
  summary's file position). A latent gap that predates this change; in
  practice set-context writes boundary+summary before emitting
  `contextChanged`.
- **No session yet**: `{ entries: [], leaf: null }` (established by the
  preceding fix; get-messages returns `[]` likewise).

## Non-goals

- get-messages and its override machinery: unchanged.
- Layout machinery (pictl-shared `tree-layout.ts`): unchanged — it is
  already iterative; nested `LayoutNode` remains its in-memory input.
- The daemon-revival resume-id loss (issue 3) and the why-did-resume-fork
  investigation: separate work.
- Streaming/pagination of large snapshots: entries pass whole; only nesting
  is eliminated.

## Deliverables beyond code

- Amend `session-tree-and-set-context.md`: `get-tree` superseded, link here.
- `/handoff` documents for **pi** and **pictl** covering the
  respond()-stringify hardening (their daemons/servers may share the
  crash-on-unserializable-response shape). Written at the end of
  implementation.

# IMPLEMENTATION IDEAS

- **Crash mechanics** (verified): `JSON.stringify` overflows near depth
  ~5000 (Node 23); `JSON.parse` survives 6000+. The daemon dies before any
  client parses. 5213-entry session reproduces it.
- **Why entries are NOT truncated at the leaf** (decision record): a
  stream-authoritative daemon-side truncation was considered and rejected.
  The transcript never needed it — `pathToLeaf` stops at the leaf by
  definition, and `pathUpToBoundary` already cuts at the client's fold leaf
  (with a structural carve-out: viaBoundary occurrences, boundaries,
  summaries always replay since they never stream). The only user-facing
  surface that exposes post-leaf entries is tree rendering (`/tree`, `format
  tree`), where showing them is the point:
  navigating back with a no-write rewind and then forward again requires
  the abandoned tail in the snapshot. Hence verbatim entries + the
  override-aware leaf computation carried over from get-tree.
- **No path consumer uses `children`** (`appendPathNode`, `resolveTreePick`,
  `pathUpToBoundary` read only entry + `ref.viaBoundary`) — hence `PathNode`.
- **`buildTree`**: keep the existing relink algorithm (pendingRelink
  deferral, uuid → occurrence map overwriting); `attach` records the parent
  id instead of pushing into `children`; the occurrence map holds formatted
  ids so parent resolution yields the ParentMap value directly.
- **`toLayoutTree`**: two passes over the parent map — create all
  `{id, children: [], payload}` shells first, then link each into its
  parent's (mutable) children array or the roots list. Two passes make the
  adapter independent of any parent-precedes-child ordering assumption;
  structural typing satisfies the readonly `LayoutNode` interface.
- **`tree-selector` parentById**: derivable directly from the parent map
  (key → parent key) — the recursive layout walk in the constructor dies.
- **`format messages` cross-pointing**: snapshot-shaped input (an object
  with an `entries` array) fed to `format messages`/`format events` should
  point at `format tree`. Old `{tree: …}` documents get no special case.
- **Duplicate-uuid loud check moves to buildTree**: a corrupt file
  repeating a uuid currently dies in `flattenVisibleTree`'s unique-layout-id
  precondition. A `ParentMap` would silently collapse duplicates, hiding
  on-disk corruption from the user — so `buildTree` throws on a duplicate
  occurrence key instead (earlier and with a clearer message than the layout
  check, which remains as backstop).
- **Order of work**: core types + buildTree first (with tests ported from
  build-tree.test.ts), then daemon (snapshot + respond hardening), then
  format layer, then TUI, then docs. Each step compiles and passes tests
  before the next.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Core: `ParentMap`/`PathNode`/`SessionSnapshot` types; `buildTree`
      (build-tree.ts reworked in place); `pathToLeaf`, `treeChildren`,
      `isFinalAssistantEntry`; delete the nested `TreeNode`, `SessionTree`;
      port tests.
- [x] Review round 2: `ParentMap` (`ReadonlyMap<string, string | null>`)
      replaces the `TreeNode`-valued map — implemented across core, format,
      TUI, and tests.
- [x] session-file.ts: `entriesByUuid` + tests (covered via tree.test.ts /
      tree.test.ts fixtures).
- [x] Daemon: get-entries → SessionSnapshot (leaf computation moved from the
      get-tree case); delete get-tree handler/wire type/command; respond()
      hardening; tests (new sdk-server.test.ts pins the hardening:
      per-response failure, connection keeps serving).
- [x] Renames: `AgentState.leafTreeNodeRef` → `leaf`,
      `SessionFileSeed.leafTreeNodeRef` → `leaf`.
- [x] CLI: delete `get-tree` command; `get-entries` → bareRequestCommand
      (one JSON document) + brief.
- [x] Format: `toLayoutTree`, `collectToolNames(entries)`,
      `collectFinalAssistantIds`, `formatSessionSnapshot`,
      `parseSessionSnapshot` (envelope + raw JSONL); command wiring; tests.
- [x] TUI: reloadHistory + openTreeSelector on get-entries; `PathNode`
      retypes (`pathUpToBoundary`, `appendPathNode`, `renderPathNode`);
      `resolveTreePick` + `TreeSelectorComponent` signatures; tests.
- [x] Docs: supersession note (session-tree-and-set-context.md header); pi +
      pictl /handoff docs
      (`~/git/earendil-works/pi/docs/respond-stringify-hardening-handoff.md`;
      `~/git/geraschenko/pictl/docs/specs/respond-stringify-hardening-handoff.md`).
- [x] End-to-end verification against the 5213-entry session
      (078b1e79): daemon spawn with `--resume` survives; `get-entries`
      returns a 15 MB snapshot (5213 entries, non-null leaf) and the daemon
      keeps serving; `get-entries | format tree` and
      `format tree < session.jsonl` both render; fresh agent returns
      `{entries: [], leaf: null}` and `format tree` prints `[cursor: null]`;
      full presubmit green (after the usual treefmt re-run).

## Implementation-Time Decisions

- **Relink diagnostics in the format layer are declared-ignored**
  (`buildTree(entries, () => {})` in `formatSessionSnapshot`;
  `seedFromEntries(entries, () => {})` in `parseSessionSnapshot`'s raw-JSONL
  branch): the agreed signatures take no sink, interleaving diagnostics with
  rendered output would corrupt it, and invalid relinks still render
  (un-relinked). The daemon path reports the same diagnostics to its log
  when computing the leaf. The TUI passes a banner-adding sink instead.
- **From-shape raw summary is never registered in `occurrenceOf`**: the old
  buildTree registered the unattached raw summary node in its uuid map
  before the relink overwrote it; nothing can resolve a parent to it in that
  window (the anchor is the boundary, preserved uuids are earlier entries),
  so buildTree skips the dead registration.
- **`format messages` brief** now reads "get-messages or session-file JSONL"
  — get-entries no longer emits entry JSONL, so it left the brief.
- **`ParentMap` replaces the `TreeNode`-valued map** (review round 2, owner
  TDC): the node struct was logically an edge and duplicated its map key
  (`node.ref` == `parseTreeNodeRef(key)`). New type:
  `ReadonlyMap<string, string | null>` — child occurrence id → parent
  occurrence id, both `formatTreeNodeRef` output, so edges live in one id
  space and the map composes with itself (`key = map.get(key)` walks up).
  Consumers that need the ref parse it from the id (lossless, validated);
  the selector's `parentById` field dies because the ParentMap is that map.
  Trade-off accepted: `string` is weaker than a ref type, mitigated by
  boundary validation (`parseTreeNodeRef` throws on malformed ids).
- **"Forest" terminology renamed to "tree" at review time** (owner request):
  `Forest` → `Tree`, `ForestNode` → `TreeNode` (the name freed by deleting
  the nested type), `buildForest` → `buildTree`, `forestChildren` →
  `treeChildren`, `toLayoutForest` → `toLayoutTree`; forest.ts back to
  build-tree.ts. "Tree" matches how people talk about the conversation even
  though multiple roots make it technically a forest — same spirit as "leaf".
  The spec above was updated in place; this file keeps its historical name.
- **`SDK_SOCKET_VERSION` stays 1**: the spec-review disposition initially
  proposed bumping to 2 for the get-entries shape change + get-tree removal;
  the owner reversed it (pre-release, no compatibility surface to protect),
  and that reversal is recorded here rather than silently.
- **`/tree` tool names scan uuid-bearing entries only**: the selector calls
  `collectToolNames([...entryOf.values()])` (its inputs are `tree` +
  `entryOf` per the agreed signature), while `formatSessionSnapshot` scans
  all snapshot entries. Uuid-less entry kinds (file-history-snapshot,
  queue-operation) carry no tool_use blocks, so the outputs match; if a
  uuid-less kind ever grows tool blocks, pass precomputed tool names in.

_Work log: implementation complete. All 370 tests pass, `tsc --noEmit`
clean, presubmit green, e2e verified against the 5213-entry session
(details in the checklist above)._
