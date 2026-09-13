// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/*
 * One-producer/one-consumer bridge from pushed values to `for await`. This
 * file is repo-agnostic and consumed verbatim by the consuming repo's sync
 * script; it deliberately has no imports at all.
 */

/**
 * The event source every stream consumer pulls from; see driver.ts.
 *
 * The two end-states are distinct. `close()` is the producer saying "no more
 * values" — whatever is already queued is still delivered. `cancel()` is the
 * consumer saying "I'm done" — queued values are dropped.
 *
 * `pushedCount` is the read-only total of accepted pushes, including values
 * delivered directly to a waiting consumer. It starts at zero and never
 * resets when values are drained or cancelled; pushes after close/cancel
 * are ignored and do not count.
 *
 * The hard requirement is that the consumer can cancel *while parked on
 * `next()`*: runStream cancels from a quiet or deadline timer that fires
 * while its pump awaits the next event. That rules out the two obvious
 * off-the-shelf answers, both verified by experiment:
 *
 *   - An async generator. `return()` on a generator suspended at an `await`
 *     (rather than at a `yield`) is queued behind the pending `next()` and
 *     never settles, so cancellation hangs until an event happens to arrive.
 *   - A `node:stream` Readable in object mode. Same hang on `return()`, and
 *     `destroy()` makes subsequent iteration throw ERR_STREAM_PREMATURE_CLOSE
 *     instead of ending cleanly.
 *
 * `events.on()` and the `it-pushable` package do both satisfy the semantics;
 * they are not used because this is 40 lines with no dependency, and because
 * neither names the close/cancel distinction that matters here.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private readonly pushHandlers = new Set<() => void>();
  private closed = false;
  private acceptedPushes = 0;

  get pushedCount(): number {
    return this.acceptedPushes;
  }

  /** Ignored once closed or cancelled. */
  push(value: T): void {
    if (this.closed) {
      return;
    }
    this.acceptedPushes += 1;
    const waiter = this.waiter;
    if (waiter === undefined) {
      this.queue.push(value);
    } else {
      this.waiter = undefined;
      waiter({ done: false, value });
    }
    for (const handler of this.pushHandlers) {
      handler();
    }
  }

  /** Observe source activity. Returns a function that removes the handler. */
  onPush(handler: () => void): () => void {
    if (this.closed) {
      return () => undefined;
    }
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  /** Establish a source cutoff. Accepted values remain available to drain. */
  close(): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    this.pushHandlers.clear();
    this.end();
    return true;
  }

  cancel(): void {
    this.closed = true;
    this.pushHandlers.clear();
    this.queue.length = 0;
    this.end();
  }

  /** A waiter exists only while the queue is empty, so ending is unconditional:
   *  there is never a waiter left parked in front of undelivered values. */
  private end(): void {
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const queued = this.queue.shift();
        if (queued !== undefined) {
          return Promise.resolve({ done: false, value: queued });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.cancel();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}
