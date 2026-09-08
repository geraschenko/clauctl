// Online topological merge of N ordered, lossy views of one process.
// Spec: docs/specs/stream-merge.md. No clauctl imports (extraction candidate).
//
// Mental model. One process emits events with distinct ids; each *stream* is
// a faithful but lossy view of it (every id appears on some non-empty subset
// of the streams, in process order), and no stream is synchronized with any
// other. Observing an id on a stream appends it to that stream's *chain*;
// the union of the chains is a DAG whose *ancestor* relation is all the
// order the streams jointly establish. Every claim below is about that DAG,
// never about the process's hidden order.
//
// A node is *closed* w.r.t. stream T when T can only ever produce its
// successors — it is T's tail or an ancestor of it — so closedness is
// ancestor-closed and is kept current by propagating marks backwards on
// every edge insertion. *Excluded* from T is the caller's promise that the
// id never appears on T; it removes T from the node's condition and nothing
// more. A node is *resolved* once observed somewhere, closed w.r.t. every
// non-excluded stream, and all its predecessors are resolved; resolution
// order is therefore a topological sort and, once resolved, no future
// observation can become an ancestor. *Pending* on S = observed on S and
// unresolved. Resolved nodes are forgotten: a node is in the state iff it
// is unresolved, which is what keeps memory proportional to stream lag.
//
// The state is plain data and every operation is a pure function of it:
// callers keep the returned state, and the one they passed in is unchanged.

import { err, ok, type Result } from "neverthrow";

export type StreamName = string;

export interface StreamRef<Id extends string, S extends StreamName> {
  readonly stream: S;
  readonly id: Id;
}

/** An unresolved node. `predecessors` lists unresolved predecessors only;
 *  the three stream lists are sets. */
export interface MergeNode<Id extends string, S extends StreamName> {
  readonly id: Id;
  readonly predecessors: readonly StreamRef<Id, S>[];
  readonly successors: readonly StreamRef<Id, S>[];
  readonly seenOn: readonly S[];
  readonly closedOn: readonly S[];
  readonly excludedFrom: readonly S[];
}

/** The whole merge as an immutable JSON-plain value; `observe` and
 *  `excludeFrom` return a new one sharing untouched nodes with the
 *  input. `nodes` holds exactly the unresolved nodes; `tails` lists only
 *  streams whose tail is unresolved. */
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

const fail = (kind: MergeErrorKind, message: string) =>
  err<never, MergeError>({ kind, message });

function getNode<Id extends string, S extends StreamName>(
  nodes: Readonly<Record<Id, MergeNode<Id, S>>>,
  id: Id,
): MergeNode<Id, S> | undefined {
  return Object.hasOwn(nodes, id) ? nodes[id] : undefined;
}

const refFor = <Id extends string, S extends StreamName>(
  refs: readonly StreamRef<Id, S>[],
  stream: S,
): Id | undefined => refs.find((ref) => ref.stream === stream)?.id;

/** `invalid-streams` on an empty list or a repeated name. `S` is the
 *  stream-name type: a literal union when the names are known statically,
 *  `string` when they are data. Ids are strings, never duplicated within a
 *  stream and never re-observed after resolution (the caller
 *  deduplicates); resolved ids are forgotten. */
export function createMerge<Id extends string, S extends StreamName>(
  streams: readonly S[],
): Result<MergeState<Id, S>, MergeError> {
  if (streams.length === 0) {
    return fail("invalid-streams", "no streams declared");
  }
  if (new Set(streams).size !== streams.length) {
    return fail(
      "invalid-streams",
      `repeated stream name in ${JSON.stringify(streams)}`,
    );
  }
  return ok({
    streams: [...streams],
    tails: [],
    nodes: {} as Record<Id, MergeNode<Id, S>>,
  });
}

/** Append `id` to `stream`'s chain. */
export function observe<Id extends string, S extends StreamName>(
  state: MergeState<Id, S>,
  stream: NoInfer<S>,
  id: Id,
): Result<MergeStep<Id, S>, MergeError> {
  if (!state.streams.includes(stream)) {
    return fail("unknown-stream", `unknown stream ${stream}`);
  }
  const existing = getNode(state.nodes, id);
  if (existing?.excludedFrom.includes(stream)) {
    return fail(
      "excluded-observed",
      `${id} observed on ${stream}, which it is excluded from`,
    );
  }
  if (existing?.closedOn.includes(stream)) {
    return fail(
      "order-violation",
      `${id} observed on ${stream} after a successor of it`,
    );
  }
  const draft = new MutableMergeState(state);
  const node = draft.node(id);
  node.seenOn.add(stream);
  node.closedOn.add(stream);
  const previousTail = draft.tails.get(stream);
  draft.tails.set(stream, id);
  if (previousTail !== undefined) {
    draft.node(previousTail).successors.set(stream, id);
    node.predecessors.set(stream, previousTail);
  }
  const marked = propagateClosure(draft, node);
  const resolved = resolve(draft, [...marked.reverse(), node]);
  return ok({ state: draft.finish(), resolved });
}

/** Promise that `id` will never be observed on `streams`. May precede any
 *  observation of `id`. Must not name an already-resolved id (it would
 *  create a node that never resolves; undetectable). */
export function excludeFrom<Id extends string, S extends StreamName>(
  state: MergeState<Id, S>,
  streams: readonly NoInfer<S>[],
  id: Id,
): Result<MergeStep<Id, S>, MergeError> {
  const unknown = streams.find((stream) => !state.streams.includes(stream));
  if (unknown !== undefined) {
    return fail("unknown-stream", `unknown stream ${unknown}`);
  }
  if (streams.length === 0) return ok({ state, resolved: [] });
  const existing = getNode(state.nodes, id);
  const seen = streams.find((stream) => existing?.seenOn.includes(stream));
  if (seen !== undefined) {
    return fail(
      "excluded-observed",
      `${id} excluded from ${seen}, which has observed it`,
    );
  }
  const excluded = new Set([...(existing?.excludedFrom ?? []), ...streams]);
  if (excluded.size === state.streams.length) {
    return fail("excluded-from-all", `${id} excluded from every stream`);
  }
  const draft = new MutableMergeState(state);
  const node = draft.node(id);
  for (const stream of streams) node.excludedFrom.add(stream);
  const resolved = resolve(draft, [node]);
  return ok({ state: draft.finish(), resolved });
}

/** Observed on `stream` and unresolved, in `stream`'s order. */
export function pending<Id extends string, S extends StreamName>(
  state: MergeState<Id, S>,
  stream: NoInfer<S>,
): readonly Id[] {
  const ids: Id[] = [];
  for (
    let id = refFor(state.tails, stream);
    id !== undefined;
    id = refFor(getNode(state.nodes, id)!.predecessors, stream)
  ) {
    ids.push(id);
  }
  return ids.reverse();
}

/** `pending(state, stream).length > 0`, without walking the chain. */
export function hasPending<Id extends string, S extends StreamName>(
  state: MergeState<Id, S>,
  stream: NoInfer<S>,
): boolean {
  return refFor(state.tails, stream) !== undefined;
}

// A node under edit: the same information as `MergeNode` with cheap
// updates; predecessors and successors are by id.
interface MutableMergeNode<Id extends string, S extends StreamName> {
  readonly id: Id;
  readonly predecessors: Map<S, Id>;
  readonly successors: Map<S, Id>;
  readonly seenOn: Set<S>;
  readonly closedOn: Set<S>;
  readonly excludedFrom: Set<S>;
}

const toMutable = <Id extends string, S extends StreamName>(
  node: MergeNode<Id, S>,
): MutableMergeNode<Id, S> => ({
  id: node.id,
  predecessors: new Map(node.predecessors.map((r) => [r.stream, r.id])),
  successors: new Map(node.successors.map((r) => [r.stream, r.id])),
  seenOn: new Set(node.seenOn),
  closedOn: new Set(node.closedOn),
  excludedFrom: new Set(node.excludedFrom),
});

// The next state under construction. `nodes` starts as a shallow copy of
// the input record; a node is converted to mutable form on first touch and
// written back by `finish`, so untouched nodes are shared with the input.
// The copy is a Map rather than a record because `record[id] = node` with
// id `"__proto__"` would set the prototype instead of a property.
class MutableMergeState<Id extends string, S extends StreamName> {
  readonly streams: readonly S[];
  readonly tails: Map<S, Id>;
  private readonly nodes: Map<Id, MergeNode<Id, S>>;
  private readonly touched = new Map<Id, MutableMergeNode<Id, S>>();

  constructor(state: MergeState<Id, S>) {
    this.streams = state.streams;
    this.tails = new Map(state.tails.map((ref) => [ref.stream, ref.id]));
    this.nodes = new Map(
      Object.entries(state.nodes) as [Id, MergeNode<Id, S>][],
    );
  }

  node(id: Id): MutableMergeNode<Id, S> {
    const existing = this.touched.get(id);
    if (existing !== undefined) return existing;
    const stored = this.nodes.get(id);
    const mutable =
      stored === undefined
        ? {
            id,
            predecessors: new Map<S, Id>(),
            successors: new Map<S, Id>(),
            seenOn: new Set<S>(),
            closedOn: new Set<S>(),
            excludedFrom: new Set<S>(),
          }
        : toMutable(stored);
    this.touched.set(id, mutable);
    return mutable;
  }

  forget(id: Id): void {
    this.touched.delete(id);
    this.nodes.delete(id);
    for (const [stream, tail] of this.tails) {
      if (tail === id) this.tails.delete(stream);
    }
  }

  finish(): MergeState<Id, S> {
    const refs = (map: Map<S, Id>): StreamRef<Id, S>[] =>
      this.streams.flatMap((stream) => {
        const id = map.get(stream);
        return id === undefined ? [] : [{ stream, id }];
      });
    for (const node of this.touched.values()) {
      this.nodes.set(node.id, {
        id: node.id,
        predecessors: refs(node.predecessors),
        successors: refs(node.successors),
        seenOn: [...node.seenOn],
        closedOn: [...node.closedOn],
        excludedFrom: [...node.excludedFrom],
      });
    }
    return {
      streams: this.streams,
      tails: refs(this.tails),
      nodes: Object.fromEntries(this.nodes) as Record<Id, MergeNode<Id, S>>,
    };
  }
}

// Closedness is ancestor-closed, so a predecessor already carrying every
// one of `node`'s marks has ancestors that do too; the walk stops there.
// Returns the newly marked nodes in marking order (descendants first).
function propagateClosure<Id extends string, S extends StreamName>(
  draft: MutableMergeState<Id, S>,
  node: MutableMergeNode<Id, S>,
): MutableMergeNode<Id, S>[] {
  const marked: MutableMergeNode<Id, S>[] = [];
  const stack = [node];
  for (
    let current = stack.pop();
    current !== undefined;
    current = stack.pop()
  ) {
    for (const stream of draft.streams) {
      const predecessorId = current.predecessors.get(stream);
      if (predecessorId === undefined) continue;
      const predecessor = draft.node(predecessorId);
      let added = false;
      for (const mark of node.closedOn) {
        if (!predecessor.closedOn.has(mark)) {
          predecessor.closedOn.add(mark);
          added = true;
        }
      }
      if (added) {
        marked.push(predecessor);
        stack.push(predecessor);
      }
    }
  }
  return marked;
}

// Kahn's worklist over the DAG sources among `candidates`: a node with an
// unresolved predecessor can only become resolvable in this pass through
// that predecessor resolving, at which point it is queued — so every node
// enters the queue at most once.
function resolve<Id extends string, S extends StreamName>(
  draft: MutableMergeState<Id, S>,
  candidates: readonly MutableMergeNode<Id, S>[],
): Resolved<Id, S>[] {
  const resolved: Resolved<Id, S>[] = [];
  const queue = candidates.filter((node) => node.predecessors.size === 0);
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    if (!isResolvable(draft.streams, node)) continue;
    draft.forget(node.id);
    for (const stream of draft.streams) {
      const successorId = node.successors.get(stream);
      if (successorId === undefined) continue;
      const successor = draft.node(successorId);
      successor.predecessors.delete(stream);
      if (successor.predecessors.size === 0) queue.push(successor);
    }
    resolved.push({
      id: node.id,
      seenOn: [...node.seenOn],
      excludedFrom: [...node.excludedFrom],
    });
  }
  return resolved;
}

function isResolvable<Id extends string, S extends StreamName>(
  streams: readonly S[],
  node: MutableMergeNode<Id, S>,
): boolean {
  return (
    node.seenOn.size > 0 &&
    node.predecessors.size === 0 &&
    streams.every(
      (stream) => node.closedOn.has(stream) || node.excludedFrom.has(stream),
    )
  );
}
