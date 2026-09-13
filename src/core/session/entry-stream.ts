/**
 * The session log follower (docs/specs/session-tracker.md, "Log follower")
 * and the canonical-filtering core shared by the daemon's tracker and the
 * finite reads (dormant tail, `format`).
 *
 * Canonical entries are the file's raw append sequence after FIRST-WINS uuid
 * deduplication: the first occurrence of a uuid supplies both position and
 * content (the CLI legitimately re-persists prior entries under the same
 * uuid, sometimes mutated — docs/derisk/cli-history-repersistence/
 * FINDINGS.md); uuid-less occurrences are always retained in position.
 */

import type { UUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { AsyncQueue } from "../generated/streaming/async-queue.ts";
import {
  SessionEntryParser,
  type MalformedLine,
  type ParsedEntry,
  type SessionEntry,
} from "./file.ts";

/** The stateful first-wins/`since` filter shared by canonicalizeEntries, the
 *  daemon's session tracker, and the `format` input pipeline, so canonical
 *  semantics cannot diverge.
 *  `leaf` advances on every first-occurrence uuid-bearing entry — including
 *  ones suppressed as pre-cursor — so once the cursor is consumed it equals
 *  the cursor itself, and thereafter tracks emitted entries. An entry whose
 *  `uuid` field is not a string has no stable cursor identity and is treated
 *  like a uuid-less occurrence. */
export class CanonicalEntryFilter {
  readonly seenUuids = new Set<UUID>();
  private currentLeaf: UUID | undefined;
  /** The `since` cursor, until its first occurrence is consumed. */
  private pendingCursor: UUID | undefined;

  constructor(since?: UUID) {
    this.pendingCursor = since;
  }

  get leaf(): UUID | undefined {
    return this.currentLeaf;
  }

  get cursorPending(): boolean {
    return this.pendingCursor !== undefined;
  }

  /** The canonical entry to output, or undefined when suppressed (a
   *  duplicated uuid, or at/before the `since` cursor). */
  accept(entry: SessionEntry): SessionEntry | undefined {
    const uuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
    if (uuid === undefined) {
      return this.pendingCursor === undefined ? entry : undefined;
    }
    if (this.seenUuids.has(uuid)) {
      return undefined;
    }
    this.seenUuids.add(uuid);
    this.currentLeaf = uuid;
    if (this.pendingCursor !== undefined) {
      if (uuid === this.pendingCursor) {
        this.pendingCursor = undefined;
      }
      return undefined;
    }
    return entry;
  }
}

/** A pending whenQuiet(): its window restarts on every read that yields
 *  bytes and settles when the window elapses or the follower closes. */
interface QuietWaiter {
  rearm: () => void;
  settle: () => void;
}

/** fs.watch + byte offset + torn-suffix parser over one existing session
 *  file, delivering every parsed line synchronously inside the read (no
 *  first-wins filtering; that is the consumer's). Installs fs.watch before
 *  the initial stat/read so no append can fall between snapshot and follow.
 *  A malformed terminated line is reported through `onMalformedLine` and
 *  skipped; a failing stat/read leaves the offset where it was and the next
 *  wake retries; truncation, inode replacement and watcher errors are
 *  failures (recorded byte ranges would be stale; the CLI never does this). */
export class SessionLogFollower {
  private readonly filePath: string;
  private readonly onEntry: (parsed: ParsedEntry) => void;
  private readonly onMalformedLine: (line: MalformedLine) => void;
  private readonly onFailure: (error: Error) => void;
  private readonly parser = new SessionEntryParser();
  /** Wake tokens from the fs.watch callback. The queue (not a bare flag) is
   *  what the follow loop parks on — a boolean cannot wake an awaiting
   *  consumer. wakePending caps it at one queued token, coalescing callback
   *  bursts into one drain. `true` because AsyncQueue cannot carry
   *  undefined. */
  private readonly wakes = new AsyncQueue<true>();
  private wakePending = false;
  private renameSeen = false;
  private watcher: FSWatcher | undefined;
  private fd: number | undefined;
  /** dev/ino of the opened file, for replacement detection on rename. */
  private identity: { dev: number; ino: number } | undefined;
  /** File bytes consumed so far (the parser holds any torn suffix). */
  private offset = 0;
  private readonly quietWaiters = new Set<QuietWaiter>();
  private readonly failureWaiters: ((error: Error) => void)[] = [];
  private followerFailure: Error | undefined;
  private closed = false;

  constructor(
    filePath: string,
    onEntry: (parsed: ParsedEntry) => void,
    onMalformedLine: (line: MalformedLine) => void,
    onFailure: (error: Error) => void,
  ) {
    this.filePath = filePath;
    this.onEntry = onEntry;
    this.onMalformedLine = onMalformedLine;
    this.onFailure = onFailure;
  }

  /** Why following stopped, when not a clean close(). */
  get failure(): Error | undefined {
    return this.followerFailure;
  }

  /** Read the initial extent (onEntry per line, synchronously) and start
   *  following. Throws on a missing/unreadable file, after closing. */
  start(): void {
    try {
      this.watcher = watch(this.filePath, (eventType) => {
        if (eventType === "rename") {
          this.renameSeen = true;
        }
        this.wake();
      });
      this.watcher.on("error", (error) => this.fail(error));
      this.fd = openSync(this.filePath, "r");
      const stat = fstatSync(this.fd);
      this.identity = { dev: stat.dev, ino: stat.ino };
      this.consumeBytes(stat.size);
      // Catches bytes that became visible during setup even if their
      // notification coalesced with an event before the initial read.
      this.wake();
      void this.follow();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Consume everything visible right now, synchronously. Throws the
   *  follower failure (also reported via onFailure) on truncation. No-op
   *  after close. */
  drainVisibleBytes(): void {
    if (this.closed) {
      return;
    }
    try {
      this.consumeToCurrentSize();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /** Resolves once `quietMs` have passed with no new bytes (the first quiet
   *  window; a read that yields bytes restarts the window), or on close. */
  whenQuiet(quietMs: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: QuietWaiter = {
        rearm: () => {
          clearTimeout(timer);
          timer = setTimeout(waiter.settle, quietMs);
        },
        settle: () => {
          clearTimeout(timer);
          this.quietWaiters.delete(waiter);
          resolve();
        },
      };
      if (this.closed) {
        resolve();
        return;
      }
      this.quietWaiters.add(waiter);
      waiter.rearm();
    });
  }

  /** Resolves on failure (immediately if already failed); never on a clean
   *  close. */
  whenFailed(): Promise<Error> {
    if (this.followerFailure !== undefined) {
      return Promise.resolve(this.followerFailure);
    }
    return new Promise((resolve) => this.failureWaiters.push(resolve));
  }

  /** Release the watcher and file handle. Idempotent. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.watcher?.close();
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
    this.wakes.close();
    for (const waiter of this.quietWaiters) {
      waiter.settle();
    }
  }

  private wake(): void {
    if (!this.wakePending) {
      this.wakePending = true;
      this.wakes.push(true);
    }
  }

  private fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.followerFailure =
      error instanceof Error ? error : new Error(String(error));
    this.close();
    for (const resolve of this.failureWaiters) {
      resolve(this.followerFailure);
    }
    this.failureWaiters.length = 0;
    this.onFailure(this.followerFailure);
  }

  /** One wake per park: capture/reset flags before draining, so a watcher
   *  callback during the drain queues the next token. Notifications are
   *  wakeups only — each drain reads all bytes currently available. */
  private async follow(): Promise<void> {
    try {
      for await (const _token of this.wakes) {
        this.wakePending = false;
        const sawRename = this.renameSeen;
        this.renameSeen = false;
        if (sawRename) {
          this.verifyIdentity();
        }
        this.consumeToCurrentSize();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private consumeToCurrentSize(): void {
    let size: number;
    try {
      size = fstatSync(this.fd!).size;
    } catch {
      return; // retried on the next wake
    }
    if (size < this.offset) {
      throw new Error(
        `${this.filePath} truncated below the consumed byte extent ` +
          `(${size} < ${this.offset}); a Claude session file only grows`,
      );
    }
    this.consumeBytes(size);
  }

  /** The path must still name the file we opened; a replaced or removed file
   *  is unrecoverable (restarting from byte zero would duplicate uuid-less
   *  entries and conceal data loss). */
  private verifyIdentity(): void {
    const stat = statSync(this.filePath, { throwIfNoEntry: false });
    if (
      stat === undefined ||
      stat.dev !== this.identity!.dev ||
      stat.ino !== this.identity!.ino
    ) {
      throw new Error(`${this.filePath} was replaced or removed`);
    }
  }

  /** Read [#offset, end), parse, and deliver each entry. A read error ends
   *  the read early; what was read is consumed and the rest retried on the
   *  next wake. */
  private consumeBytes(end: number): void {
    if (end <= this.offset) {
      return;
    }
    const length = end - this.offset;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    try {
      while (bytesRead < length) {
        const n = readSync(
          this.fd!,
          buffer,
          bytesRead,
          length - bytesRead,
          this.offset + bytesRead,
        );
        if (n === 0) {
          break;
        }
        bytesRead += n;
      }
    } catch {
      // retried on the next wake
    }
    if (bytesRead === 0) {
      return;
    }
    this.offset += bytesRead;
    for (const waiter of this.quietWaiters) {
      waiter.rearm();
    }
    const chunk = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    for (const line of this.parser.push(chunk)) {
      if (this.closed) {
        return;
      }
      line.match(this.onEntry, this.onMalformedLine);
    }
  }
}

/** First-wins + `since` slicing over already-read raw entries; throws when
 *  `since` is absent (never "from the beginning"). The finite path for
 *  dormant agents: canonicalizeEntries(readSessionEntries(path), since). */
export function canonicalizeEntries(
  entries: readonly SessionEntry[],
  since?: UUID,
): SessionEntry[] {
  const filter = new CanonicalEntryFilter(since);
  const canonical: SessionEntry[] = [];
  for (const entry of entries) {
    const accepted = filter.accept(entry);
    if (accepted !== undefined) {
      canonical.push(accepted);
    }
  }
  if (filter.cursorPending) {
    throw new Error(`since cursor ${since} does not match any entry`);
  }
  return canonical;
}
