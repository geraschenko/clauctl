# Session Snapshot and Forest

Supersedes the `get-tree` portions of
[session-tree-and-set-context.md](session-tree-and-set-context.md).

# SPEC

## Problem

`get-tree` serializes the session forest as *nested* JSON (`TreeNode` with
recursive `children`). A mostly-linear session nests one level per entry, and
`JSON.stringify` overflows the call stack near depth ~5000, so resuming or
attaching to a long session (observed: 5213 entries) **crashes the daemon**
(`RangeError: Maximum call stack size exceeded` in `respond()`). The nested
representation is a tripping hazard with no information advantage: the forest
is a pure function of the flat entries.

## What we want

1. **No nested structures on the wire.** `get-tree` is removed entirely
   (wire type, daemon handler, `clauctl get-tree` command, `parseSessionTree`).
   Clients build the forest locally from flat entries via shared code.
2. **`get-entries` returns a `SessionSnapshot`** — every file entry verbatim
   plus the daemon's context tip: `leaf` is the effective-chain tip minus a
   live filterTail override's dropped uuids — exactly `get-tree`'s leaf
   computation today. It names an occurrence present in `entries`, resolved
   to the correct tree copy (raw or viaBoundary).
3. **The forest is represented flat**: a parent relation over occurrences
   (`Forest`), not a recursive node type. `TreeNode` and `SessionTree` are
   deleted. All traversals over session-length data are iterative.
4. **The daemon survives serialization failure**: `respond()` degrades to an
   `ok: false` error response instead of crashing.
5. **`format tree` accepts `get-entries` output** (the snapshot document) and
   raw session JSONL (leaf derived by the existing `seedFromEntries` chain
   logic).

## Success criteria

- `clauctl spawn -a -- --resume <5000+-entry session>` attaches without
  crashing the daemon; history renders; `/tree` opens and picks work.
- Fresh agent + attach: empty transcript, no error banner.
- `clauctl get-entries | clauctl format tree` renders the forest.
- `clauctl format tree < ~/.claude/projects/<slug>/<id>.jsonl` renders the
  forest with the chain-derived leaf as cursor.
- A forced-unserializable response produces an error banner client-side; the
  daemon keeps running.
- All existing tests pass (updated where behavior changed); no recursion over
  session-length structures remains in clauctl code.

## Definitions

- **State leaf**: `AgentState.leaf` (renamed from `leafTreeNodeRef`) — the
  attach boundary tracked by the fold.

## Type design

```ts
// tree.ts — TreeNode and SessionTree are DELETED.
// TreeNodeRef, formatTreeNodeRef, parseTreeNodeRef, treeNodeRefsEqual: unchanged.

export interface ForestNode {
  ref: TreeNodeRef;
  parent: TreeNodeRef | null; // null = root
}

/** Parent relation over occurrences. Key: formatTreeNodeRef(node.ref) —
 *  string keys because Map uses reference equality for objects and refs are
 *  produced independently (fold, wire, parse). Iteration order =
 *  materialization order: raw entries at file position, relinked occurrences
 *  at their boundary's summary position. */
export type Forest = ReadonlyMap<string, ForestNode>;

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
 *  Iterative parent walk (calls nothing per node). */
export function pathToLeaf(
  forest: Forest,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
  leaf: TreeNodeRef | null,
): PathNode[];

/** Children per parent key (formatTreeNodeRef), roots under null.
 *  Materialization order. Derived by inverting `forest`. */
export function forestChildren(
  forest: Forest,
): Map<string | null, TreeNodeRef[]>;

/** No child of this occurrence continues the same assistant API message.
 *  False for non-assistant entries. */
export function isFinalAssistantEntry(
  ref: TreeNodeRef,
  children: ReadonlyMap<string | null, readonly TreeNodeRef[]>,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
): boolean;
```

```ts
// forest.ts (renamed from build-tree.ts)
/** Same relink algorithm as before (already iterative), emitting the parent
 *  relation instead of nested nodes. Throws on a duplicate occurrence key —
 *  valid files cannot produce one, so a duplicate means the session file is
 *  corrupt; the error is loud so the user learns about it. */
export function buildForest(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): Forest;
```

```ts
// session-file.ts — addition
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
// crashing the daemon.
```

```ts
// format/tree.ts
/** Iterative adapter to the layout's nested input (replaces recursive
 *  toLayoutNode). Ids are formatTreeNodeRef output. */
export function toLayoutForest(
  forest: Forest,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
): LayoutNode<SessionEntry>[];

/** Flat scan over all entries (needs no tree). */
export function collectToolNames(
  entries: readonly SessionEntry[],
): Map<string, string>;

export function collectFinalAssistantIds(
  forest: Forest,
  children: ReadonlyMap<string | null, readonly TreeNodeRef[]>,
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
/** Replaces parseSessionTree. Accepts: (1) one JSON document with an
 *  `entries` array and a null-or-ref `leaf`; (2) raw session-entry JSONL,
 *  leaf derived via the seedFromEntries chain logic. Tail-shaped input →
 *  cross-pointing UsageError. Anything else (including old get-tree
 *  documents) → generic "not a session snapshot" UsageError. */
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
  forest: Forest,
  entryOf: ReadonlyMap<UUID, SessionEntry>,
  pick: TreeNodeRef,
): TreePickAction;
// TreeSelectorComponent constructor:
//   (leaf: TreeNodeRef | null, forest: Forest,
//    entryOf: ReadonlyMap<UUID, SessionEntry>,
//    onSelect: (pick: TreeNodeRef) => void, onCancel: () => void)
// interactive-mode builds forest + entryOf once per get-entries read and
// passes them explicitly (reloadHistory and openTreeSelector both switch
// from get-tree to get-entries).
```

**Renames**: `AgentState.leafTreeNodeRef` → `leaf`;
`StartupSeed.leafTreeNodeRef` → `leaf`. ("Leaf" is strictly inaccurate — the
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
  summaries always replay since they never stream). The only consumer that
  sees post-leaf entries is `/tree`, where showing them is the point:
  navigating back with a no-write rewind and then forward again requires
  the abandoned tail in the snapshot. Hence verbatim entries + the
  override-aware leaf computation carried over from get-tree.
- **No path consumer uses `children`** (`appendPathNode`, `resolveTreePick`,
  `pathUpToBoundary` read only entry + viaBoundary) — hence `PathNode`.
- **`buildForest`**: keep the existing relink algorithm (pendingRelink
  deferral, uuid → node map overwriting); the internal map value becomes the
  occurrence's `ForestNode` instead of a nested node; `attach` records
  `parent` instead of pushing into `children`.
- **`toLayoutForest`**: one pass over `forest` in iteration order, creating
  `{id, children: [], payload}` shells and pushing each into its parent's
  (mutable) children array or the roots list; structural typing satisfies
  the readonly `LayoutNode` interface. Parent shells always precede children
  (materialization order is topological).
- **`tree-selector` parentById**: derivable directly from `forest`
  (key → parent key) — the recursive layout walk in the constructor dies.
- **`format messages` cross-pointing**: snapshot-shaped input (an object
  with an `entries` array) fed to `format messages`/`format events` should
  point at `format tree`. Old `{tree: …}` documents get no special case.
- **Duplicate-uuid loud check moves to buildForest**: a corrupt file
  repeating a uuid currently dies in `flattenVisibleTree`'s unique-layout-id
  precondition. A `Forest` map would silently collapse duplicates, hiding
  on-disk corruption from the user — so `buildForest` throws on a duplicate
  occurrence key instead (earlier and with a clearer message than the layout
  check, which remains as backstop).
- **Order of work**: core types + buildForest first (with tests ported from
  build-tree.test.ts), then daemon (snapshot + respond hardening), then
  format layer, then TUI, then docs. Each step compiles and passes tests
  before the next.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [ ] Core: `Forest`/`ForestNode`/`PathNode`/`SessionSnapshot` types;
      `buildForest` (rename build-tree.ts → forest.ts); `pathToLeaf`,
      `forestChildren`, `isFinalAssistantEntry`; delete `TreeNode`,
      `SessionTree`; port tests.
- [ ] session-file.ts: `entriesByUuid` + tests.
- [ ] Daemon: get-entries → SessionSnapshot (leaf computation moved from the
      get-tree case); delete get-tree handler/wire type/command; respond()
      hardening; tests.
- [ ] Renames: `AgentState.leafTreeNodeRef` → `leaf`,
      `StartupSeed.leafTreeNodeRef` → `leaf`.
- [ ] Format: `toLayoutForest`, `collectToolNames(entries)`,
      `collectFinalAssistantIds`, `formatSessionSnapshot`,
      `parseSessionSnapshot` (envelope + raw JSONL); command wiring; tests.
- [ ] TUI: reloadHistory + openTreeSelector on get-entries; `PathNode`
      retypes (`pathUpToBoundary`, `appendPathNode`, `renderPathNode`);
      `resolveTreePick` + `TreeSelectorComponent` signatures; tests.
- [ ] Docs: supersession note; pi + pictl /handoff docs.
- [ ] End-to-end verification against the 5213-entry session.

*Work log entries go here*
