import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { Result } from "neverthrow";
import {
  createMerge,
  excludeFrom,
  hasPending,
  type MergeState,
  type MergeStep,
  observe,
  pending,
  type MergeError,
  type MergeErrorKind,
} from "./stream-merge.ts";

type State = MergeState<string, string>;
type Step = MergeStep<string, string>;

const create = (streams: readonly string[]): State =>
  createMerge<string, string>(streams)._unsafeUnwrap();

const must = <T>(result: Result<T, MergeError>): T => result._unsafeUnwrap();

const ids = (step: Step): string[] => step.resolved.map((node) => node.id);

function assertErrKind(
  result: Result<unknown, MergeError>,
  kind: MergeErrorKind,
): void {
  assert.equal(result.isErr() ? result.error.kind : "ok", kind);
}

// Threads state through a sequence of calls, asserting each succeeds and
// leaves its input state untouched.
class Runner {
  state: State;
  constructor(streams: readonly string[]) {
    this.state = create(streams);
  }
  observe(stream: string, id: string): string[] {
    return this.apply(observe(this.state, stream, id));
  }
  excludeFrom(streams: readonly string[], id: string): string[] {
    return this.apply(excludeFrom(this.state, streams, id));
  }
  pending(stream: string): readonly string[] {
    return pending(this.state, stream);
  }
  hasPending(stream: string): boolean {
    return hasPending(this.state, stream);
  }
  private apply(result: Result<Step, MergeError>): string[] {
    const before = structuredClone(this.state);
    const step = must(result);
    assert.deepEqual(this.state, before, "input state mutated");
    this.state = step.state;
    return ids(step);
  }
}

describe("examples", () => {
  test("log lags", () => {
    const merge = new Runner(["query", "session"]);
    assert.deepEqual(merge.observe("query", "a"), []);
    assert.deepEqual(merge.observe("query", "b"), []);
    assert.deepEqual(merge.pending("query"), ["a", "b"]);
    assert.deepEqual(merge.observe("session", "a"), ["a"]);
    assert.deepEqual(merge.pending("query"), ["b"]);
    assert.deepEqual(merge.observe("session", "b"), ["b"]);
    assert.equal(merge.hasPending("query"), false);
    assert.equal(merge.hasPending("session"), false);
    assert.deepEqual(merge.state.nodes, {});
    assert.deepEqual(merge.state.tails, []);
  });

  test("log skipped an id", () => {
    const merge = new Runner(["query", "session"]);
    merge.observe("query", "a");
    merge.observe("query", "b");
    const step = must(observe(merge.state, "session", "b"));
    assert.deepEqual(ids(step), ["a", "b"]);
    assert.deepEqual(step.resolved[0]!.seenOn, ["query"]);
    assert.deepEqual(step.resolved[1]!.seenOn, ["query", "session"]);
  });

  test("log leads", () => {
    const merge = new Runner(["query", "session"]);
    assert.deepEqual(merge.observe("session", "x"), []);
    assert.deepEqual(merge.pending("session"), ["x"]);
    assert.deepEqual(merge.observe("query", "x"), ["x"]);
  });

  test("exclusion relaxes, does not close", () => {
    const merge = new Runner(["query", "session"]);
    merge.observe("query", "a");
    merge.observe("query", "r");
    assert.deepEqual(merge.excludeFrom(["session"], "r"), []);
    assert.deepEqual(merge.pending("query"), ["a", "r"]);
    const step = must(observe(merge.state, "session", "a"));
    assert.deepEqual(ids(step), ["a", "r"]);
    assert.deepEqual(step.resolved[1]!.excludedFrom, ["session"]);
  });

  test("exclusion before observation", () => {
    const merge = new Runner(["query", "session"]);
    assert.deepEqual(merge.excludeFrom(["query"], "k"), []);
    assert.deepEqual(merge.pending("session"), []);
    assert.deepEqual(merge.observe("session", "k"), ["k"]);
  });

  test("three streams: exclusion leaves the other stream's closure needed", () => {
    const merge = new Runner(["A", "B", "C"]);
    merge.observe("A", "x");
    merge.excludeFrom(["C"], "x");
    assert.deepEqual(merge.observe("C", "y"), []);
    assert.deepEqual(merge.pending("A"), ["x"]);
    assert.deepEqual(merge.observe("B", "x"), ["x"]);
  });

  test("closure through another stream", () => {
    const merge = new Runner(["A", "B", "C"]);
    merge.observe("A", "x");
    merge.observe("A", "y");
    merge.observe("B", "y");
    const step = must(observe(merge.state, "C", "y"));
    assert.deepEqual(ids(step), ["x", "y"]);
    assert.deepEqual(step.resolved[0]!.seenOn, ["A"]);
  });

  test("several incomparable successors resolve in one call", () => {
    const merge = new Runner(["A", "B", "C"]);
    merge.observe("A", "root");
    merge.observe("B", "root");
    merge.observe("A", "a1");
    merge.excludeFrom(["B", "C"], "a1");
    merge.observe("B", "b1");
    merge.excludeFrom(["A", "C"], "b1");
    assert.deepEqual(merge.observe("C", "root"), ["root", "a1", "b1"]);
  });

  test("state is plain data: ids that collide with Object.prototype", () => {
    const merge = new Runner(["A", "B"]);
    assert.deepEqual(merge.observe("A", "constructor"), []);
    assert.deepEqual(merge.observe("A", "__proto__"), []);
    assert.deepEqual(merge.pending("A"), ["constructor", "__proto__"]);
    assert.deepEqual(merge.observe("B", "__proto__"), [
      "constructor",
      "__proto__",
    ]);
    assert.deepEqual(merge.state.nodes, {});
  });
});

describe("errors", () => {
  test("order violation on re-observation and on contradictory streams", () => {
    // Stream C never observes, so x stays resident (a resolved x would be
    // forgotten and B: x would be a fresh node).
    const merge = new Runner(["A", "B", "C"]);
    merge.observe("A", "x");
    assertErrKind(observe(merge.state, "A", "x"), "order-violation");
    merge.observe("A", "y");
    merge.observe("B", "y");
    assertErrKind(observe(merge.state, "B", "x"), "order-violation");
    assert.deepEqual(merge.pending("B"), ["y"]);
  });

  test("excluded-observed in both directions", () => {
    const merge = new Runner(["A", "B"]);
    merge.excludeFrom(["B"], "x");
    assertErrKind(observe(merge.state, "B", "x"), "excluded-observed");
    merge.observe("A", "y");
    assertErrKind(excludeFrom(merge.state, ["A"], "y"), "excluded-observed");
  });

  test("excluded-from-all, including across calls", () => {
    const merge = new Runner(["A", "B"]);
    assertErrKind(
      excludeFrom(merge.state, ["A", "B"], "x"),
      "excluded-from-all",
    );
    merge.excludeFrom(["A"], "x");
    assertErrKind(excludeFrom(merge.state, ["B"], "x"), "excluded-from-all");
  });

  test("unknown-stream and invalid-streams", () => {
    assertErrKind(createMerge([]), "invalid-streams");
    assertErrKind(createMerge(["A", "A"]), "invalid-streams");
    const merge = new Runner(["A"]);
    assert.deepEqual(merge.state.streams, ["A"]);
    assertErrKind(observe(merge.state, "Z", "x"), "unknown-stream");
    assertErrKind(excludeFrom(merge.state, ["Z"], "x"), "unknown-stream");
    assert.deepEqual(merge.pending("Z"), []);
    assert.equal(merge.hasPending("Z"), false);
  });

  test("literal stream names make unknown-stream a compile-time error", () => {
    const state = createMerge<string, "query" | "session">([
      "query",
      "session",
    ])._unsafeUnwrap();
    // @ts-expect-error "qeury" is not a declared stream name
    assertErrKind(observe(state, "qeury", "x"), "unknown-stream");
  });

  test("idempotent and no-op exclusions", () => {
    const merge = new Runner(["A", "B"]);
    assert.deepEqual(merge.excludeFrom([], "x"), []);
    assert.deepEqual(merge.state.nodes, {});
    merge.excludeFrom(["B", "B"], "x");
    merge.excludeFrom(["B"], "x");
    assert.deepEqual(merge.state.nodes["x"]!.excludedFrom, ["B"]);
    assert.deepEqual(merge.state.tails, []);
  });
});

// Random instance: `n` ids in a hidden order, each carried by a non-empty
// subset of the streams and excluded from the rest either just before or
// just after its first observation; arrivals interleave the per-stream
// sequences arbitrarily.
interface Arrival {
  readonly stream: string;
  readonly id: string;
  readonly exclusions: readonly string[];
  readonly excludeBefore: boolean;
}

interface Instance {
  readonly streams: readonly string[];
  readonly arrivals: readonly Arrival[];
  readonly order: readonly string[];
}

const instanceArb = fc
  .record({
    streamCount: fc.integer({ min: 1, max: 4 }),
    n: fc.integer({ min: 0, max: 12 }),
  })
  .chain(({ streamCount, n }) => {
    const streams = Array.from({ length: streamCount }, (_, i) => `S${i}`);
    const order = Array.from({ length: n }, (_, i) => `n${i}`);
    return fc
      .record({
        carriers: fc.array(fc.subarray(streams, { minLength: 1 }), {
          minLength: n,
          maxLength: n,
        }),
        excludeBefore: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
        picks: fc.array(fc.integer({ min: 0, max: streamCount - 1 }), {
          maxLength: n * streamCount,
        }),
      })
      .map(({ carriers, excludeBefore, picks }): Instance => {
        const queues = streams.map((stream) =>
          order.filter((_, i) => carriers[i]!.includes(stream)),
        );
        const seen = new Set<string>();
        const arrivals: Arrival[] = [];
        const emit = (streamIndex: number): void => {
          const id = queues[streamIndex]!.shift()!;
          const i = Number(id.slice(1));
          const first = !seen.has(id);
          seen.add(id);
          arrivals.push({
            stream: streams[streamIndex]!,
            id,
            exclusions: first
              ? streams.filter((stream) => !carriers[i]!.includes(stream))
              : [],
            excludeBefore: excludeBefore[i]!,
          });
        };
        for (const pick of picks) {
          if (queues[pick]!.length > 0) emit(pick);
        }
        for (let s = 0; s < streams.length; s++) {
          while (queues[s]!.length > 0) emit(s);
        }
        return { streams, arrivals, order };
      });
  });

interface Trace {
  readonly resolvedPerArrival: readonly (readonly string[])[];
  readonly pendingPerArrival: readonly (readonly (readonly string[])[])[];
}

function run(
  instance: Instance,
  hooks: {
    onObserved?: (arrival: Arrival) => void;
    onResolved?: (id: string) => void;
    roundTripAt?: number;
  } = {},
): Trace {
  const merge = new Runner(instance.streams);
  const resolvedPerArrival: string[][] = [];
  const pendingPerArrival: string[][][] = [];
  instance.arrivals.forEach((arrival, index) => {
    if (index === hooks.roundTripAt) {
      merge.state = JSON.parse(JSON.stringify(merge.state)) as State;
    }
    const resolved: string[] = [];
    const exclude = (): void => {
      resolved.push(...merge.excludeFrom(arrival.exclusions, arrival.id));
    };
    if (arrival.excludeBefore) exclude();
    hooks.onObserved?.(arrival);
    resolved.push(...merge.observe(arrival.stream, arrival.id));
    if (!arrival.excludeBefore) exclude();
    for (const id of resolved) hooks.onResolved?.(id);
    resolvedPerArrival.push(resolved);
    pendingPerArrival.push(instance.streams.map((s) => [...merge.pending(s)]));
  });
  return { resolvedPerArrival, pendingPerArrival };
}

// Edge list of the DAG the arrivals build: consecutive observations per stream.
function edges(instance: Instance): [string, string][] {
  const tails = new Map<string, string>();
  const result: [string, string][] = [];
  for (const arrival of instance.arrivals) {
    const previous = tails.get(arrival.stream);
    if (previous !== undefined) result.push([previous, arrival.id]);
    tails.set(arrival.stream, arrival.id);
  }
  return result;
}

function ancestors(
  edgeList: readonly (readonly [string, string])[],
  id: string,
): Set<string> {
  const predecessors = new Map<string, string[]>();
  for (const [from, to] of edgeList) {
    predecessors.set(to, [...(predecessors.get(to) ?? []), from]);
  }
  const result = new Set<string>();
  const stack = [id];
  for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
    for (const pred of predecessors.get(cur) ?? []) {
      if (!result.has(pred)) {
        result.add(pred);
        stack.push(pred);
      }
    }
  }
  return result;
}

describe("properties", () => {
  test("(a) resolution order is a topological sort of the DAG", () => {
    fc.assert(
      fc.property(instanceArb, (instance) => {
        const order = run(instance).resolvedPerArrival.flat();
        const position = new Map(order.map((id, i) => [id, i]));
        assert.equal(new Set(order).size, order.length);
        for (const [from, to] of edges(instance)) {
          assert.ok(position.get(from)! < position.get(to)!, `${from} → ${to}`);
        }
      }),
    );
  });

  test("(b) finality: a resolved node's ancestor set never grows", () => {
    fc.assert(
      fc.property(instanceArb, (instance) => {
        const seenEdges: [string, string][] = [];
        const tails = new Map<string, string>();
        const ancestorsAtResolution = new Map<string, Set<string>>();
        run(instance, {
          onObserved: (arrival) => {
            const previous = tails.get(arrival.stream);
            if (previous !== undefined) seenEdges.push([previous, arrival.id]);
            tails.set(arrival.stream, arrival.id);
          },
          onResolved: (id) => {
            ancestorsAtResolution.set(id, ancestors(seenEdges, id));
          },
        });
        const finalEdges = edges(instance);
        for (const [id, early] of ancestorsAtResolution) {
          assert.deepEqual(ancestors(finalEdges, id), early, id);
        }
      }),
    );
  });

  test("(c) completeness: everything resolves once the streams are exhausted", () => {
    fc.assert(
      fc.property(instanceArb, (instance) => {
        const trace = run(instance);
        assert.deepEqual(
          new Set(trace.resolvedPerArrival.flat()),
          new Set(instance.order),
        );
        const last = trace.pendingPerArrival.at(-1);
        if (last !== undefined) {
          assert.deepEqual(
            last,
            instance.streams.map(() => []),
          );
        }
      }),
    );
  });

  test("(d) fully covered ids resolve in the hidden order", () => {
    const fullyCovered = instanceArb.filter((instance) =>
      instance.arrivals.every((arrival) => arrival.exclusions.length === 0),
    );
    fc.assert(
      fc.property(fullyCovered, (instance) => {
        assert.deepEqual(
          run(instance).resolvedPerArrival.flat(),
          instance.order,
        );
      }),
    );
  });

  test("(e) JSON round trip mid-run matches the uninterrupted run; inputs never mutated", () => {
    fc.assert(
      fc.property(
        instanceArb.chain((instance) =>
          fc.record({
            instance: fc.constant(instance),
            roundTripAt: fc.integer({ min: 0, max: instance.arrivals.length }),
          }),
        ),
        ({ instance, roundTripAt }) => {
          assert.deepEqual(run(instance, { roundTripAt }), run(instance));
        },
      ),
    );
  });
});
