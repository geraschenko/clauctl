# Spec: stream merge — online topological merge of N ordered views of one process

> Status: **IMPLEMENTED 2026-09-10** (`src/core/stream-merge.ts`,
> tests green, presubmit green); awaiting Anton's review of code and
> doc. Extracted from the design discussion of
> docs/specs/session-tracker.md, which will be rewritten on top of this
> library (see "Rewind package" below). Written with an eye toward
> extraction into its own package: no clauctl imports.

# SPEC

## Problem

One process (the claude CLI) emits events; we observe them through
several streams (the query stream, the session log, our own actions).
Each stream is a faithful, ordered, lossy view: every event appears on
some non-empty subset of the streams, in the process's order, and no
stream is synchronized with any other — one may lag arbitrarily behind
another. We rebroadcast every event the moment it arrives on any stream
(no lag), and we need to know, for every event we have seen, whether it
is **resolved**: no future arrival on any stream can precede it in the
order the streams jointly define (the DAG below). Every claim in this
spec is about that DAG, never about the process's hidden order — where
the chains do not relate two events, nothing can. "The session log has
caught up with the query stream" (settledness) is "nothing observed on
the query stream is unresolved".

The session-tracker design grew ad hoc rules for this — two pending
lists with a truncation rule, a shared-class predicate, history-replay
bits, per-file resets — each correct for one situation and hard to
reason about together. This library states the general problem once,
so the daemon can stop reasoning about it.

## Model

- **Stream**: a named sequence of distinct **ids**. `N` streams are
  declared at construction.
- **Node**: an id, shared across streams. Observing an id on a stream
  appends it to that stream's **chain**: for consecutive observations
  `a`, `b` on one stream there is an edge `a → b`.
- **DAG**: the union of the chains. It is acyclic because the streams
  are views of one order; an observation that would create a cycle is
  a caller error the library detects (Errors, below). **Ancestor** is
  the transitive closure of `→`.
- **Tail** of a stream: its most recent observation.
- **Closed w.r.t. stream `T`**: a node `x` is closed w.r.t. `T` when
  every future observation on `T` is a successor of `x` — equivalently,
  `x` is `T`'s tail or an ancestor of it. Closedness w.r.t. `T` is
  therefore ancestor-closed: if `x` is closed w.r.t. `T`, so is every
  ancestor of `x`. Nothing is closed w.r.t. a stream that has observed
  nothing.
- **Excluded from `T`**: a caller promise that the node will never be
  observed on `T`. Exclusion is _not_ closure — `T` may still produce
  ancestors of an excluded node — it only removes `T` from the node's
  resolution condition.
- **Resolved**: a node is resolved when it has been observed on at
  least one stream, it is closed w.r.t. every stream it is not excluded
  from, and every ancestor is resolved (equivalently: every direct
  predecessor is resolved).
- **Pending on `S`**: observed on `S` and not resolved. `pending(S)` is
  these nodes in `S`'s order.

Resolution is final: once a node is resolved, no future observation on
any stream becomes an ancestor of it in the DAG — resolution order is a
topological sort. Proof sketch: a new ancestor of `x`
would have to arrive on some stream `U`; `x` is closed w.r.t. every
non-excluded `U` (so `U`'s future is successors of `x`); for an
excluded `U`, the new node `a` would reach `x` through some edge
`a → b` on `U` with `b` an ancestor of `x` seen on a non-excluded
stream, and `b` resolved (as an ancestor of resolved `x`) means `b` is
closed w.r.t. `U`, so `a` (before `b` on `U`) was already observed —
contradiction.

## Guarantees

1. **Topological resolution.** The sequence of resolved nodes across
   all calls is a topological sort of the DAG. Within one stream,
   resolution order is the stream's order.
2. **Pending ⇔ possibly preceded.** A node is pending on `S` iff some
   stream may still observe a node that becomes an ancestor of it in
   the DAG. (The "only if" is finality above; the "if" is that the
   library resolves a node as soon as its condition holds — it never
   waits for information it does not need.)
3. **No lag.** `observe` and `excludeFrom` are synchronous and return
   the nodes they resolved; the caller rebroadcasts the observed item
   before or after as it likes.
4. **Memory is the lag.** Resolved nodes are forgotten. Residency is
   the number of unresolved nodes — observed ones, bounded by how far
   the streams are apart, plus nodes declared by `excludeFrom` and not
   yet observed — never the length of the history.
5. **Pure and plain.** `observe` and `excludeFrom` are pure functions
   from a `MergeState` value to a new one; the state is JSON-plain
   data (records, arrays, strings) and survives a JSON round trip
   unchanged, so it can live inside a serialized, purely folded
   `AgentState` and every holder of the same state and events computes
   the same resolutions (same lists, same order) and pendings.
   Resolution order within one call is a fixed function of the state
   and the call (Data flow 4).

## Success criteria

1. Property tests (fast-check, `src/core/stream-merge.test.ts`) over
   random instances — a hidden total order of ids, each id carried by a
   random non-empty subset of `N ∈ {1, 2, 3, 4}` streams, exclusions
   declared for the other streams at a random point before the id's
   first observation or immediately after it, arrivals
   interleaved randomly with each stream's order preserved — assert:
   (a) the concatenated `resolved` lists form a topological sort of the
   DAG; (b) finality: no observation is an ancestor of an already
   resolved node; (c) completeness: when every stream is exhausted,
   every node is resolved and every `pending` is empty; (d) when every
   id is carried by every stream, resolution order equals the hidden
   order; (e) replacing the state by its JSON round trip at a random
   step, then the remaining arrivals, yields the same resolutions and
   pendings as the uninterrupted run, and no call mutates the state it
   was given.
2. Example-based tests for every example and error below.
3. `src/core/stream-merge.ts` imports nothing from clauctl.

## Examples

Two streams `query` and `session` unless stated; `q(x)` / `s(x)` =
`observe("query", x)` / `observe("session", x)`; `→ [..]` = the
`resolved` ids returned, in order.

- **Log lags** (the normal case): `q(a) → []`, `q(b) → []`,
  `pending(query) = [a, b]`; `s(a) → [a]`, `pending(query) = [b]`;
  `s(b) → [b]`, both pendings empty ("settled").
- **Log skipped an id** (the tracker's head-mismatch): `q(a)`, `q(b)`,
  `s(b) → [a, b]`. `b` is closed w.r.t. `session` by being observed;
  `a` is an ancestor of `b` (query chain), so closed too; `a` resolves
  with `seenOn = {query}` — the caller's signal that the session log
  never delivered it — then `b`.
- **Log leads**: `s(x) → []`, `pending(session) = [x]`; `q(x) → [x]`.
- **Exclusion relaxes, does not close**: `q(a)`, `q(r)`,
  `excludeFrom(["session"], r)`. `r` is closed w.r.t. `query` (its
  tail) and excluded from `session`, but `a` is unresolved, so
  `r` is pending. `s(a) → [a, r]`.
- **Exclusion before observation**: `excludeFrom(["query"], k)` for
  an id the caller knows in advance the query will never show;
  `pending` unchanged (never observed); `s(k) → [k]` provided `k`'s
  session predecessor is resolved.
- **Three streams** `A`, `B`, `C`: `observe("A", x)`,
  `excludeFrom(["C"], x)`: `x` still needs closure w.r.t. `B`.
  `observe("C", y)` with `y` unrelated: `x` still pending.
  `observe("B", x) → [x]`.
- **Closure through another stream**: streams `A`, `B`, `C`;
  `observe("A", x)`, `observe("A", y)`, `observe("B", y)`,
  `observe("C", y)`: `y` is every tail; `x` is its ancestor, so `x`
  is closed w.r.t. all three without ever appearing on `B` or `C`
  → `[x, y]`, `x.seenOn = {A}`.
- **Errors** (`Err<MergeError>` from `neverthrow`; nothing
  throws; the instance is unchanged):
  observing an id on a stream w.r.t. which it is already closed
  (`order-violation`: the new edge tail → id would close a cycle,
  since closed w.r.t. `T` means "ancestor of `T`'s tail or the tail
  itself"; re-observation on the same stream is the one-node case, and
  every cycle among resident nodes is caught at the observation that
  would create it because edges are only ever added at tails and
  closure marks are kept current — see Data flow and Edge cases); observing an id on a stream it is excluded from,
  or excluding an id from a stream that has observed it
  (`excluded-observed`); excluding an id from every stream
  (`excluded-from-all`); naming an undeclared stream
  (`unknown-stream`); creating with no streams or a repeated name
  (`invalid-streams`); restoring a malformed snapshot
  (`invalid-snapshot`). Not errors: a name repeated within one
  `excludeFrom` call or excluded twice (idempotent);
  `excludeFrom([], id)` (a no-op that creates nothing); `pending` /
  `hasPending` of an undeclared stream (`[]` / `false` — nothing was
  observed there). The stream-name type parameter `S` lets a caller
  with literal stream names make `unknown-stream` a compile-time
  error; a caller whose stream names are data uses `S = string`.

## Type design

```ts
// src/core/stream-merge.ts — no clauctl imports.
import { type Result } from "neverthrow";

export type StreamName = string;

export interface StreamRef<Id extends string, S extends StreamName> {
  readonly stream: S;
  readonly id: Id;
}

/** An unresolved node. `predecessors` lists unresolved predecessors
 *  only; the four stream lists are sets. */
export interface MergeNode<Id extends string, S extends StreamName> {
  readonly id: Id;
  readonly predecessors: readonly StreamRef<Id, S>[];
  readonly successors: readonly StreamRef<Id, S>[];
  readonly seenOn: readonly S[];
  readonly closedOn: readonly S[];
  readonly excludedFrom: readonly S[];
}

/** The whole merge as JSON-plain data. `nodes` holds exactly the
 *  unresolved nodes; `tails` lists only streams whose tail is
 *  unresolved. Never mutated: every operation returns a new state
 *  sharing untouched nodes. */
export interface MergeState<Id extends string, S extends StreamName> {
  readonly streams: readonly S[];
  readonly tails: readonly StreamRef<Id, S>[];
  readonly nodes: Readonly<Record<Id, MergeNode<Id, S>>>;
}

/** A node the merge has finished with. A stream in neither `seenOn` nor
 *  `excludedFrom` skipped the node: it resolved because a successor
 *  arrived there first. */
export interface Resolved<Id extends string, S extends StreamName> {
  readonly id: Id;
  readonly seenOn: readonly S[];
  readonly excludedFrom: readonly S[];
}

export interface MergeStep<Id extends string, S extends StreamName> {
  readonly state: MergeState<Id, S>;
  /** Topological order. */
  readonly resolved: readonly Resolved<Id, S>[];
}

export type MergeErrorKind =
  | "order-violation"
  | "excluded-observed"
  | "excluded-from-all"
  | "unknown-stream"
  | "invalid-streams";

/** Plain data, never thrown. */
export interface MergeError {
  readonly kind: MergeErrorKind;
  readonly message: string;
}

/** `invalid-streams` on an empty list or a repeated name. `S` is the
 *  stream-name type: a literal union when the names are known
 *  statically, `string` when they are data. Ids are strings, never
 *  duplicated within a stream and never re-observed after resolution
 *  (the caller deduplicates); resolved ids are forgotten. */
export function createMerge<Id extends string, S extends StreamName>(
  streams: readonly S[],
): Result<MergeState<Id, S>, MergeError>;

/** Append `id` to `stream`'s chain. */
export function observe<Id extends string, S extends StreamName>(
  state: MergeState<Id, S>, stream: S, id: Id,
): Result<MergeStep<Id, S>, MergeError>;

/** Promise that `id` will never be observed on `streams`. May precede
 *  any observation of `id`. Must not name an already-resolved id (it
 *  would create a node that never resolves; undetectable). */
export function excludeFrom<Id extends string, S extends StreamName>(
  state: MergeState<Id, S>, streams: readonly S[], id: Id,
): Result<MergeStep<Id, S>, MergeError>;

/** Observed on `stream` and unresolved, in `stream`'s order. */
export function pending<Id extends string, S extends StreamName>(
  state: MergeState<Id, S>, stream: S,
): readonly Id[];

/** `pending(state, stream).length > 0`, in O(1). */
export function hasPending<Id extends string, S extends StreamName>(
  state: MergeState<Id, S>, stream: S,
): boolean;
```

Dependencies: `observe` and `excludeFrom` both end in the same
resolution pass (Implementation ideas); `pending` walks a stream's
chain back from its tail. `Record` lookups go through `Object.hasOwn`
so an id such as `"constructor"` cannot alias a prototype property.

## Data flow

`observe(state, T, x)` — validation reads `state`; steps 2–4 run on a
draft (a shallow copy of `nodes` plus mutable copies of the nodes they
touch) that becomes the returned state; `state` itself is never
written:

1. Validate: `T` declared; `x` not excluded from `T`; `x` not already
   closed w.r.t. `T`.
2. Get or create the node; link `T`'s previous tail → `x`; `x` becomes
   `T`'s tail; `x` joins `pending(T)`.
3. **Closure propagation**: mark `x` closed w.r.t. `T`; then propagate
   _all_ of `x`'s closure marks backwards along predecessor edges —
   into `T`'s previous tail and its ancestors — adding each mark where
   absent and stopping where every mark is already present or the node
   is resolved. Propagating all of `x`'s marks, not just `T`, is what
   keeps closedness current when the new edge joins a chain to a node
   that other streams have already passed (`x` seen on `A` and `B`;
   `T`'s previous tail gains closure w.r.t. `A` and `B` through `x`).
4. **Resolution pass** (Kahn): a FIFO worklist seeded with the DAG
   sources (no unresolved predecessor) among the nodes step 3 marked,
   in reverse marking order (predecessors visited in declared-stream
   order, so ancestors come first), then `x` if it is a source. Each
   node whose condition holds resolves; a successor is enqueued, in
   declared-stream order, when its last unresolved predecessor
   resolves — so every node enters the queue at most once. This order is a
   function of the state and the call alone. Each resolved node is
   forgotten: removed from the node record, from its successors'
   predecessor lists, and from any stream tail it occupies. Return the
   new state and the resolved nodes in resolution order.

`excludeFrom(state, streams, x)`: validate; get or create the node;
record the exclusion; resolution pass from `x`.

## Cost

- **Time.** Each node is marked closed w.r.t. each stream at most once,
  and a mark examines the node's `≤ N` predecessor edges: `O(n·N²)`
  total over `n` nodes, `O(n)` for `N = 2`. The resolution pass touches
  each edge once per resolution: `O(n·N)`. `pending(S)` is `O(|pending(S)|)`;
  "is `pending(S)` empty" is `O(1)` (`S` has no tail). Per call, on
  top of that, **the copy: `O(m)`** for the shallow copy of the node
  record (`m` = resident nodes) plus `O(N)` per touched node for its
  fresh lists. Total `O(n·m)`: acceptable exactly because `m` is the
  stream lag, not the history — a caller that lets `m` grow to the
  history length (e.g. by observing a whole scanned log on one stream
  without excluding it from the others) makes the merge quadratic.
  Alternative if that bound ever fails: a persistent map (`O(log m)`
  per update) instead of record copies.
- **Memory.** Unresolved nodes only: `O(N·m)` where `m` bounds how far
  any stream can run ahead of the others, plus exclusion-only nodes
  (declared, not yet observed) — the caller keeps those few by
  declaring exclusions near the observation. A resolved node is
  unreferenced by the new state the moment it resolves; old states the
  caller drops release their exclusive nodes.
- **Where it concentrates.** The closure walk when one stream has
  lagged far behind and then catches up: one observation can close and
  resolve `m` nodes.

## Edge cases

- **A stream that never observes anything** closes nothing, so every
  node not excluded from it stays pending forever. That is the correct
  answer to "could an earlier item arrive there?"; the caller declares
  exclusions or does not declare the stream.
- **Exclusion after the node resolved and was forgotten** creates a
  fresh node that resolves only if observed later. Undetectable;
  caller contract.
- **Re-observation of a forgotten (resolved) id** is a fresh node.
  Undetectable; caller contract (first-wins upstream).
- **Contradictory streams** (`A: x, y`; `B: y, x`; a third stream `C`
  has not passed `x`): observing `x` on `B` finds `x` closed w.r.t.
  `B` (`y` is `B`'s tail, `x` its ancestor via `A`) →
  `order-violation`. Every cycle among _resident_ nodes is of this
  form at the moment it would be created. Without `C`, `B: y` closes
  `x` w.r.t. both streams, `x` and `y` resolve and are forgotten, and
  `B: x` is the re-observation case above — undetectable, and
  harmless to the DAG claims (the forgotten `x` is a different node).

## Non-goals

- Deduplication within a stream, persistence, timeouts, knowledge of
  what the streams contain, recovery from contract violations.
- Deciding what to log: the caller interprets `seenOn`.

# IMPLEMENTATION IDEAS

## Node structure

The state is the type-design `MergeState`; there is no hidden
structure. Each call builds a **draft**: `nodes` copied into a
`Map`, `tails` as a `Map`, and a `touched: Map<Id, MutableMergeNode>` where
`MutableMergeNode` is the node with `Map`/`Set` fields for cheap updates.
`draft.node(id)` returns the mutable copy (converting from the stored
node on first touch, or creating it); resolution deletes from `nodes`
and `touched`; `draft.finish()` writes each surviving touched node
back as a plain `MergeNode` and returns the new state with `nodes`
rebuilt by `Object.fromEntries`. Untouched nodes are shared by
reference between old and new states. The draft is a `Map`, not a
record copy, because `record[id] = node` with id `"__proto__"` sets
the prototype; `fromEntries` and `Object.hasOwn` are both safe.

A node's existence in `nodes` is its unresolvedness: an empty
`predecessors` means every predecessor has resolved, `pending(S)` is
the chain walked back from the `S` tail via the `S` predecessor
(reversed), and a stream with no tail entry has nothing pending. A
resolved tail can be dropped without loss: no unresolved node is an
ancestor of a resolved one.

Resolution condition for `node`: `seenOn` non-empty, `predecessors`
empty, and every stream `s` in `closedOn` or `excludedFrom`. The
resolution pass is a worklist seeded by the sources among the nodes
the call touched; resolving a node deletes it from each successor's
`predecessors` and queues the successor when that was its last one.
Because a node's stream predecessors resolve before it, the worklist
emits in topological order; a `seenOn`-empty node (excluded before
observed) is skipped until observed.

Order-violation check: `closedOn` contains `T` before linking.

## Property tests

`fast-check` arbitraries: `n` ids in a hidden order; for each id a
non-empty subset of `N` streams; the chains follow from those; an
interleaving is a random merge of the chains; each id's exclusions
(its complement subset) are declared at a random point at or before
its first observation.

State example cases (reviewer round 3): exclusion-only nodes; every
tail already resolved (empty `tails`); several incomparable successors
resolving in one call; a JSON round trip immediately before an
`order-violation` observation still reports it.

## Fits in clauctl

Streams `query` (SDK messages plus daemon actions — the daemon already
injects dequeues into the query stream, so an action is a query-stream
item) and `session` (log entries). One `MergeState` per session file,
a field of `AgentState`, advanced by the same pure fold on both sides.
Settled ⇔ `pending("query")` empty. `Resolved.seenOn` lacking
`session` for a query item is the head-mismatch log. Exclusions: a
`result` is excluded from `session`; log-only entry classes are
excluded from `query`; a daemon-appended boundary is a synthetic
`query` observation (see Rewind package). Predicate-excluded classes
are declared as exclusions instead of being filtered out of the merge.

## Rewind package (for the session-tracker agent)

Anton will rewind the session-tracker conversation to before this
library existed; everything since then is gone. What that agent needs:

- **Replace the two pending lists** in `AgentState` with a
  `MergeState<UUID, "query" | "session">` per session file;
  `settled ⇔ !hasPending(merge, "query")`. The merge is plain data
  inside `AgentState`, so `nextAgentState` stays pure: it calls
  `observe`/`excludeFrom` and stores the returned state; the subscribe
  snapshot carries it as-is and clients fold the same events with the
  same code. `observe`/`excludeFrom` return `neverthrow` `Result`s; an
  `order-violation` from the CLI's streams is a logged data error the
  tracker must decide how to survive, not an exception. Uuid-less log
  entries never enter the merge (they are broadcast and folded like
  any event, but touch no merge state). The shared-class predicate
  becomes exclusions declared to the merge; nothing is filtered out
  before it. Head-mismatch logging = a `Resolved` with a stream in
  neither `seenOn` nor `excludedFrom`.
- **Scanned history is excluded from `query`.** Every entry the
  startup scan (or a `/fork` copy scan) observes on `session` is
  `excludeFrom(["query"])` at the same time, so it resolves at once
  and residency stays the live lag — the merge's per-call copy is
  `O(resident)`, so letting a whole file sit unresolved would make the
  scan quadratic (Cost). The SDK does not replay history on the query
  stream; if it ever echoed a scanned uuid the merge reports
  `excluded-observed`, which the tracker logs and drops.
- **Delete the history machinery**: `historyReplayed`, `historyPending`,
  "history entries never join `pendingSession`". Scan entries are
  `session` observations excluded from `query` (above); nothing waits
  for a live match.
- **One leaf.** The query-side/session-side split is gone: `leaf(state)`
  is an accessor — the last leaf-eligible id in `pending("query")` if
  any (query messages the log has not yet delivered; a `result` is a
  query node but not leaf-eligible), else the tracker's context-tree
  leaf. `sessionEntry.queryLeaf` and the seeding rule are deleted;
  `AgentState` keeps only the tree leaf it folds from
  `sessionEntry.leaf`.
- **Actions are query-stream items** (the daemon already injects
  dequeues there): a set-context append is `observe("query", B)` at
  the moment of the append — a synthetic query-stream item — so
  `pending("query")` holds `B` until the log delivers it and settledness
  waits for it, exactly as `sessionAppended → pendingQuery` did. (Not
  `excludeFrom(["query"])`: an excluded, never-observed node is pending
  nowhere, so settledness would not wait for it.)
- **Tracker replacement — state is per session file.** A session file
  switch is irreversible for the CLI (it can never again touch the old
  file's entries), so tracker-derived state (merge instance, tree
  leaf, `awaitingAnchors`, `lastUsage`/`model`) lives in a per-file
  record: `AgentState = { …per-agent (queued messages, query
  availability, version, permission mode)…, files: Map<sessionId,
  FileState>, active: sessionId }`. The daemon routes every query item
  by its `session_id`; the reader never pauses. Items for a new session
  id create the new `FileState` (its merge instance starts collecting
  query items at once) and flag a pending switch; when the old
  `FileState` settles (`pending("query")` empty — it holds only
  old-session items, so this is reachable; bounded by
  `SETTLE_TIMEOUT_MS`, timeout logs and switches anyway) the daemon
  closes the old follower, opens the new file, emits
  `sessionFileChanged {sessionId}` (drops the old `FileState`; clients
  reset their trees), and scans the new file into the new instance —
  `/fork` copies are fresh nodes there, so no re-observation hazard.
  `system/init` resets nothing. After settling, the daemon also waits
  for the old file to go quiet (`SESSION_FILE_QUIET_MS` without new
  bytes) so log-only trailing rows drain. Draining the old file at all
  serves `tail --type entries` — the CLI cannot use those rows, and
  nothing else in the daemon needs them; document this in the tracker
  spec.
- **Follower** owns path switching (`switchTo(path)` after `quietMs`
  of no activity), retries read errors from the last offset, fails on
  truncation/inode replacement (byte ranges would be stale; the CLI
  never does this).
- **Query restarts**: a boundary observed in the log restarts the Query
  only if it is down; only set-context stops it (natural compactions do
  not restart today; keep that).
- **Handoff**: every event folds into the client's `AgentState`; the
  client's own tree builders (`byUuid`, `SessionTreeBuilder`,
  `ContextTreeBuilder`, `DisplayTreeBuilder`) are fed the snapshot and
  then live `sessionEntry` events only — the `sessionEntry` events
  received between `subscribe` and the `get-entries` response are
  already in the snapshot and are not fed to the builders.
- **Error policy is the tracker's to specify.** On any `Err` the
  instance is unchanged, so the tracker can log and drop the offending
  observation without corrupting the merge. `order-violation` means
  the CLI's streams contradict each other (or an id was re-observed
  after it resolved and was forgotten — indistinguishable); the
  tracker spec must say what happens next (suggested: log at warn,
  drop, continue). `excluded-observed` / `excluded-from-all` can only
  come from the tracker's own classification and should be treated as
  bugs (log at error).
- **Classification is a table the tracker spec must state**: entry /
  message class → the set of streams that carry it; every class maps
  to a non-empty set (an empty set is `excluded-from-all`). Declare
  exclusions at the item's first observation (just before or just
  after `observe`) — an exclusion-only node is resident until
  observed, so never declare exclusions far ahead of the observation,
  and never for an id that may already have resolved.
- **Each stream must be duplicate-free upstream.** The library cannot
  see a re-observation of a forgotten id. Query items: the CLI does
  re-emit a uuid in at least one case (a preserved local-command output
  re-sent after `/compact`; the copies are equal modulo `message.id`),
  so the daemon dedups query uuids first-wins before `observe`. Session
  entries: the file scan and the live tail must not overlap (scan up to
  an offset, tail from that offset).
- **Code pointers**: `src/core/stream-merge.ts` (library: pure
  functions over `MergeState`), `src/core/stream-merge.test.ts`
  (examples + fast-check properties; `node --test
  src/core/stream-merge.test.ts`); tests use `_unsafeUnwrap` —
  product code matches on `isOk()`/`isErr()`.
- **State of docs/specs/session-tracker.md**: revised through reviewer
  round 9 (pictl agent 250edc4d); its two open round-9 blockers
  (log-side `historyPending` arithmetic; follower failure/quiet
  contract) are moot under the above. Anton's note at the top of that
  file records the rewind point.

## References

Consulted while derisking (2026-09-10); none is a drop-in.

- Online/incremental topological ordering (harder problem: arbitrary
  edge insertion over a maintained total order):
  Katriel & Bodlaender, [An O(n^2.75) algorithm for online topological
  ordering](https://www.cs.princeton.edu/courses/archive/fall07/cos521/handouts/SWAT06.pdf);
  Bender, Fineman & Gilbert, [A new approach to incremental topological
  ordering](https://www3.cs.stonybrook.edu/~bender/newpub/BenderFiGi-soda09.pdf);
  Haeupler, Kavitha, Mathew, Sen & Tarjan, [Faster algorithms for
  online topological ordering](https://arxiv.org/pdf/0711.0251);
  Bernstein & Chechik, [Incremental topological sort and cycle
  detection in Õ(m√n) expected total time](https://aaronbernstein.cs.rutgers.edu/wp-content/uploads/sites/43/2018/12/Dynamic-Cycle-Detection.pdf).
  Our edges only append at chain tails and resolved nodes are dropped,
  which is why online Kahn suffices.
- Stream-processing watermarks (the "release when every source has
  passed it" rule, with positions comparable only through shared ids
  here): patents on [ordered event stream merging](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11340792)
  and [offset-based watermarks](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11782982).
- npm, none matching: batch sorters [toposort](https://www.npmjs.com/package/toposort),
  [topological-sort-group](https://www.npmjs.com/package/topological-sort-group);
  single-input [topsort-stream](https://github.com/PeterHancock/topsort-stream);
  fan-in without id semantics [merge2](https://www.npmjs.com/package/merge2),
  [merge-stream](https://www.npmjs.com/package/merge-stream).
- Property testing: [fast-check](https://fast-check.dev/) (to be added
  as a dev dependency).

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- 2026-09-10 — derisk with Anton: model (closure vs. exclusion —
  exclusion relaxes the resolution condition, it is not closure, since
  an excluded stream can still produce ancestors); separate
  `excludeFrom`; throw on contract violations; resolved ids forgotten
  (dedup is upstream; a `/fork` copy is "first" in the new tracker's
  instance); general `N` (the interface, not the daemon, should make
  the special cases disappear); resolution order kept despite no
  consumer (it states the pending guarantee precisely); fast-check
  adopted; location `src/core/stream-merge.ts` with extraction in mind.
- 2026-09-10 — critique: closure marks propagate on every edge
  insertion (all of the new tail's marks, not just its stream's);
  every cycle is therefore detected; a set-context boundary is a
  synthetic query observation, not an exclusion. Anton: `Resolved`
  carries `seenOn` + `excludedFrom`; no instrumentation counter.
- 2026-09-10 — round-1 fixes applied (Anton: all claims are about the
  DAG, nothing about the hidden order; `hasPending` hides `tail`;
  `StreamMerge` serializable via `snapshot`/`restore` so clients
  rehydrate and own their instance; uuid-less entries never enter).
- 2026-09-10 — reviewer round 2: BLOCKED on snapshot semantics only:
  total `tails` record cannot express resolved tails; JSON round-trip
  breaks object-Id identity; resolution order after restore must be
  deterministic for Guarantee 5; malformed snapshots undefined. Fixes:
  `tails` and `predecessors` as `{stream, id}` lists (also avoids
  `__proto__`-style record keys); `Id extends string`; FIFO worklist
  with declared-stream-order enqueueing and creation-ordered
  `snapshot.nodes`; `restore` validates structure (`invalid-snapshot`),
  trusts closure marks/acyclicity.
- 2026-09-10 — reviewer round 3: APPROVED; non-blocking clarifications
  (worklist enqueues each node once; list-shaped `predecessors`; the
  snapshot cases above) applied.
- 2026-09-10 — pure rewrite (Anton, from the rewind discussion): class
  → functions over `MergeState`; snapshot/restore/`invalid-snapshot`
  removed; property (e) is now JSON round trip + input-state
  immutability; tracker must exclude scanned history from `query`
  (Rewind package). Suite green.
- [x] Spec review (Anton) — approved 2026-09-10 (snapshot stays plain
      data; no serde-style library in TS, and a cyclic node graph would
      need a flat representation regardless).
- [x] Implement `StreamMerge` + tests — 2026-09-10; 21 tests (7
      examples, 5 error, 4 snapshot, 5 properties), presubmit green.
- [x] Pure rewrite — 2026-09-10; 20 tests (9 examples, 6 error, 5
      properties), presubmit green.
- [ ] Rewind package handed to the session-tracker agent

## Implementation-Time Decisions

- **Pure functions over a plain state** (Anton, after the rewind
  discussion surfaced that a mutable instance inside the purely
  folded, serialized `AgentState` breaks the fold on both sides —
  the reviewer's round-1 flag). `StreamMerge` class, `snapshot`,
  `restore`, `invalid-snapshot` and property (e)'s restore form are
  gone; the state is the former snapshot shape with `nodes` as a
  record. Cost: an `O(m)` record copy per call, acceptable because the
  tracker keeps `m` at the live lag (scanned history excluded from
  `query`). Persistent-map dependency rejected: the residency bound is
  wanted anyway. `Resolved` carries arrays, not sets, so it is
  event-payload-ready.

- **Contradictory-streams example needed a third stream.** With only
  `A`, `B`, the observation `B: y` closes `x` w.r.t. both streams, so
  `x` and `y` resolve and are forgotten before the contradicting
  `B: x` arrives, which is then the (undetectable) re-observation
  case. The SPEC's Edge cases and Errors now say cycles are caught
  among _resident_ nodes; the example tests use a never-observing
  `C`. Discovered by the example test failing.
- **Worklist seeds are sources only.** A first version seeded every
  marked node and re-queued nodes as predecessors resolved; Anton's
  review flagged the descendants-first seed order and the re-queueing.
  Kahn proper: seed the marked nodes that have no unresolved
  predecessor (ancestors first), enqueue a successor only when its
  last predecessor resolves. Order stays a function of state + call,
  so Guarantee 5 holds (property (e) round-trips via JSON).
- **Nothing throws** (Anton's review): every failure is a `neverthrow`
  `Result`, including `create` (the constructor is private) and
  `restore`. Anton's argument: every kind is a data error for _some_
  caller — stream names and exclusions may come from data, snapshots
  cross the wire — so the programmer-vs-data split I first proposed
  was clauctl-specific. `MergeError` is a plain interface, not
  an `Error` subclass (no stack capture, nothing to throw). Callers
  with literal stream names get `unknown-stream` at compile time via
  the `S` type parameter; queries on an undeclared stream are total.
- **Resolved sets are not copied.** `Resolved.seenOn`/`excludedFrom`
  are the forgotten node's own sets; nothing else references them.
- 2026-09-10 — reviewer 250edc4d round 1: BLOCKED. (1) The Problem/
  Guarantees overclaim "no event that _truly_ happened earlier can
  still arrive": with `x` on `A` only (excluded from `B`) and `a` on
  `B` only, hidden order `a < x`, `x` resolves after `A:x` and `B:a`
  arrives later — no chain ever relates them, so no library could
  know. Proposed fix: state finality relative to the DAG (no future
  observation becomes an _ancestor_), which is what the proof proves
  and what Anton asked for ("a valid topological sort of the set as a
  whole"). (2) Three-stream example wrong: `B:y` before `B:x` makes
  `y → x`, so `x` cannot resolve before `y`. (3) Memory guarantee must
  count exclusion-only nodes. Interface nits: reject empty/duplicate
  stream names; duplicate names in `excludeFrom` idempotent;
  `excludeFrom([], id)` no-op; add O(1) `hasPending(stream)`;
  `seenOn`/`excludedFrom` are snapshots; `Id` uses `Map` identity.
  Rewind-package flags: a mutable merge instance inside the
  serialized, purely-folded `AgentState` breaks the wire/same-fold
  invariant (option: daemon runs the merge and events carry
  `resolved`, so the fold stays pure); uuid-less log entries never
  enter the merge. Pending Anton's decision before editing SPEC.
