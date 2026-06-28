/**
 * A readers-writer lock: any number of shared holders, or one exclusive
 * holder. Writer-preferring: a pending exclusive acquisition blocks new
 * shared acquisitions (tryShared throws, awaitShared waits), so the shared
 * drain it is waiting on terminates. The `try` methods are synchronous and
 * never wait — they throw when the lock cannot be granted immediately; the
 * `await` methods queue. Every acquisition returns its release function
 * (idempotent).
 */
export class RwGate {
  private sharedCount = 0;
  private exclusiveHeld = false;
  private pendingWriters = 0;
  private readonly waiters: Array<() => void> = [];

  private get writerActive(): boolean {
    return this.exclusiveHeld || this.pendingWriters > 0;
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
  }

  private waitForWake(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private acquireShared(): () => void {
    this.sharedCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.sharedCount -= 1;
      if (this.sharedCount === 0) {
        this.wake();
      }
    };
  }

  private acquireExclusive(): () => void {
    this.exclusiveHeld = true;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.exclusiveHeld = false;
      this.wake();
    };
  }

  /** Sync; throws if a writer holds the lock or is waiting for it. */
  tryShared(): () => void {
    if (this.writerActive) {
      throw new Error("RwGate: exclusive acquisition in progress");
    }
    return this.acquireShared();
  }

  /** Waits out writers (holding and pending), then acquires shared. */
  async awaitShared(): Promise<() => void> {
    while (this.writerActive) {
      await this.waitForWake();
    }
    return this.acquireShared();
  }

  /** Sync; throws if anyone holds the lock or a writer is waiting for it. */
  tryExclusive(): () => void {
    if (this.writerActive || this.sharedCount > 0) {
      throw new Error("RwGate: lock is held");
    }
    return this.acquireExclusive();
  }

  /** Queues behind current holders and previously pending writers, then
   *  acquires exclusive. */
  async awaitExclusive(): Promise<() => void> {
    this.pendingWriters += 1;
    try {
      while (this.exclusiveHeld || this.sharedCount > 0) {
        await this.waitForWake();
      }
    } finally {
      this.pendingWriters -= 1;
    }
    return this.acquireExclusive();
  }
}
