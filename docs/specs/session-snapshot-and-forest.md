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

Additionally, `get-tree`'s `leaf` is computed from the file's effective chain,
while the attach protocol treats the SDK event stream as authoritative — a
file that is *ahead* of the stream can produce a snapshot the subscriber's
fold has not confirmed.

## What we want

1. **No nested structures on the wire.** `get-tree` is removed entirely
   (wire type, daemon handler, `clauctl get-tree` command, `parseSessionTree`).
   Clients build the forest locally from flat entries via shared code.
2. **`get-entries` returns a `SessionSnapshot`** — the entries plus the
   daemon's context tip:
   - The SDK stream is authoritative: entries are **truncated at the state
     leaf's on-disk witness** (definition below), so the snapshot contains
     nothing the subscriber's event stream has not confirmed.
   - `leaf` is the state leaf resolved to its occurrence: the effective-chain
     tip of the *truncated* entries. By construction it names an occurrence
     present in `entries`.
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
- **Leaf witness**: the last file entry required to materialize the leaf
  occurrence. Raw ref `{uuid}`: the entry with that uuid. ViaBoundary ref:
  the boundary's *summary* entry (relinked occurrences materialize at the
  summary's file position); the boundary entry itself when the boundary has
  no summary.
- **Truncation**: `entries.slice(0, witnessIndex + 1)`. When the leaf is
  undefined or the witness is absent, the whole array (fallback, not error).

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

/** get-entries response: entries truncated at the context tip's witness,
 *  plus that tip resolved to its occurrence in these entries. */
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
 *  relation instead of nested nodes. */
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

// effective-chain.ts — addition (lives here, not session-file.ts: the
// viaBoundary witness lookup needs summaryOf, and session-file.ts cannot
// import effective-chain.ts without a cycle)
/** Entries up to the leaf witness (see Definitions); the whole array when
 *  the leaf is undefined or the witness is absent. */
export function truncateAtLeaf(
  entries: SessionEntry[],
  leaf: TreeNodeRef | undefined,
): SessionEntry[];
```

```ts
// request-handlers.ts — get-tree case deleted; get-entries becomes:
//   flush-wait (unchanged key: viaBoundary ?? uuid)
//   → truncateAtLeaf(entries, agentState.leaf)
//   → leaf = effectiveTreeNodeChain(truncated, log).at(-1) ?? null
//   → { entries: truncated, leaf } satisfies SessionSnapshot
// No session: { entries: [], leaf: null }.
// The filterTail chain-subtraction dies here (truncation subsumes it);
// freshOverride remains for get-messages only.
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

- **Witness absent after flush-wait**: `truncateAtLeaf` returns the full
  array; the chain tip is then the file's own tip (today's behavior). In
  practice set-context writes boundary+summary before emitting
  `contextChanged`, so a viaBoundary leaf's witness is on disk by the time a
  read can observe the leaf.
- **Truncation drops post-witness entries of every kind** — future messages,
  queue-operations, file-history-snapshots, concurrent sidechain entries.
  `get-entries` semantics change from "the file verbatim" to "the session as
  confirmed by the stream". Accepted.
- **Dead-branch window**: between a no-write rewind and the next transcript
  write, the abandoned tail is truncated away, so `/tree` does not show it
  (previously it showed as a dead branch with the cursor moved back). It
  reappears once new entries move the leaf past it in file order. Accepted.
- **Flush-wait key**: remains `viaBoundary ?? uuid` (the boundary entry), not
  the summary — a latent gap that predates this change; the witness-absent
  fallback covers it.
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
- **Convergence argument** for the leaf: truncating at the state leaf's
  witness makes the truncated entries' chain tip *be* the state leaf's
  correct occurrence (raw or viaBoundary), so "stream-authoritative content"
  and "file-resolved occurrence" agree by construction. This is also what
  lets the filterTail subtraction die: after a no-write rewind the state
  leaf is the rewind target and truncation removes the dropped tail.
- **`pathUpToBoundary` already implements the client-side cut** at the
  client's fold leaf with a structural carve-out (viaBoundary occurrences,
  boundaries, summaries always replay — they never stream). Daemon
  truncation composes: daemon leaf ≥ client leaf; replay-dedupe
  (`replayedUuids`) covers the overlap. Keep its logic byte-for-byte;
  only types change.
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
- **Duplicate-uuid failure mode changes**: a corrupt file repeating a uuid
  currently yields duplicate layout ids and a loud `flattenVisibleTree`
  throw; `Forest`'s map keys make duplicates impossible by construction
  (last occurrence wins), so rendering silently drops the earlier one
  instead. Judged acceptable — the loud check guarded adapter bugs, and the
  adapter's ids now come from the same map.
- **Order of work**: core types + buildForest first (with tests ported from
  build-tree.test.ts), then daemon (snapshot + truncation + respond
  hardening), then format layer, then TUI, then docs. Each step compiles and
  passes tests before the next.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [ ] Core: `Forest`/`ForestNode`/`PathNode`/`SessionSnapshot` types;
      `buildForest` (rename build-tree.ts → forest.ts); `pathToLeaf`,
      `forestChildren`, `isFinalAssistantEntry`; delete `TreeNode`,
      `SessionTree`; port tests.
- [ ] session-file.ts: `entriesByUuid`, `truncateAtLeaf` + tests.
- [ ] Daemon: get-entries → SessionSnapshot (truncation, leaf resolution,
      filterTail subtraction removal); delete get-tree handler/wire
      type/command; respond() hardening; tests.
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
