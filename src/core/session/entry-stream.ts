/**
 * The canonical session-entry subscription (docs/specs/
 * canonical-session-entry-stream.md): a StreamClient over one existing
 * session file, driven by the generated runStream exactly like the sdk.sock
 * client, plus the pure canonical-filtering core shared by finite reads.
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
  runStream,
  type StreamClient,
  type StreamEvent,
  type StreamSubscription,
} from "../generated/streaming/driver.ts";
import {
  readSessionEntries,
  SessionEntryParser,
  type SessionEntry,
} from "./file.ts";

/** Fold state derivable from entries alone. */
export interface EntryStreamState {
  /** The resumable cursor: uuid of the newest first-occurrence uuid-bearing
   *  entry at or before this state's position in the stream — undefined at file
   *  start. */
  readonly leaf?: UUID;
  /** Every uuid observed in the file, including uuids before `since`. Monotone;
   * a live view of the client's dedup set shared by reference, not a per-event
   * snapshot: a retained state object sees later additions. Membership tests
   * can at worst fire a condition slightly early; acceptable because copying
   * per event would be O(uuids) per entry. */
  readonly seenUuids: ReadonlySet<UUID>;
}

export type EntryClientOptions =
  | { readonly history: "emit"; readonly since?: UUID }
  | { readonly history: "skip" };

/** The stateful first-wins/`since` filter shared by canonicalizeEntries, the
 *  client's scan-and-follow loop, and the `format` input pipeline, so
 *  canonical semantics cannot diverge.
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

/** StreamClient over one existing session file. Installs fs.watch before the
 *  initial stat/read so no append can fall between snapshot and follow;
 *  scans [0, historyEnd) before subscribe() resolves — also under "skip", to
 *  seed first-wins dedup and retain a torn suffix — queueing the extent's
 *  canonical entries as events under "emit"; then follows appends
 *  incrementally from the retained byte offset. One event per canonical
 *  entry, paired with its post-fold state; the seed is the emission-start
 *  state. One subscribe() per client. */
export class SessionEntryClient implements StreamClient<
  SessionEntry,
  EntryStreamState
> {
  private readonly filePath: string;
  private readonly options: EntryClientOptions;
  private readonly events = new AsyncQueue<
    StreamEvent<SessionEntry, EntryStreamState>
  >();
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
  private parser: SessionEntryParser;
  /** Public so a cross-file follower (AgentObserver) can carry it into the
   *  next file's client for first-wins dedup across a session rollover. */
  readonly filter: CanonicalEntryFilter;
  private streamFailure: Error | undefined;
  private subscribed = false;
  private closed = false;

  /** `filter` is the rollover carry-over; defaults to the client's own. An
   *  external filter cannot be combined with a `since` cursor — the filter
   *  already consumed its cursor in the previous file. */
  constructor(
    filePath: string,
    options: EntryClientOptions,
    filter?: CanonicalEntryFilter,
  ) {
    if (
      filter !== undefined &&
      options.history === "emit" &&
      options.since !== undefined
    ) {
      throw new Error(
        "SessionEntryClient: an external filter cannot be combined with a since cursor",
      );
    }
    this.filePath = filePath;
    this.options = options;
    this.parser = new SessionEntryParser(filePath);
    this.filter =
      filter ??
      new CanonicalEntryFilter(
        options.history === "emit" ? options.since : undefined,
      );
  }

  /** Why the event queue closed, when not a clean close(): truncation,
   *  replacement, watcher/read/stat error, or a malformed terminated line
   *  during follow. undefined while healthy or after a clean close(). */
  get failure(): Error | undefined {
    return this.streamFailure;
  }

  /** Rejects on a missing/unreadable file, a malformed terminated line in
   *  the initial extent, or a `since` cursor absent from that extent (no
   *  partial output). */
  async subscribe(): Promise<
    StreamSubscription<SessionEntry, EntryStreamState>
  > {
    if (this.subscribed) {
      throw new Error("SessionEntryClient allows one subscribe() per client");
    }
    this.subscribed = true;
    try {
      this.watcher = watch(this.filePath, (eventType) => {
        if (eventType === "rename") {
          this.renameSeen = true;
        }
        if (!this.wakePending) {
          this.wakePending = true;
          this.wakes.push(true);
        }
      });
      this.watcher.on("error", (error) => this.fail(error));
      this.fd = openSync(this.filePath, "r");
      const stat = fstatSync(this.fd);
      this.identity = { dev: stat.dev, ino: stat.ino };
      const emit = this.options.history === "emit";
      const since =
        this.options.history === "emit" ? this.options.since : undefined;
      // A carried filter arrives with the previous file's leaf; under "emit"
      // this file's entries follow as events, so the seed precedes them.
      const leafBeforeScan = this.filter.leaf;
      this.consumeBytes(stat.size, emit);
      if (this.filter.cursorPending) {
        throw new Error(
          `since cursor ${since} does not match any entry in ${this.filePath}`,
        );
      }
      const seed: EntryStreamState = {
        leaf: emit ? (since ?? leafBeforeScan) : this.filter.leaf,
        seenUuids: this.filter.seenUuids,
      };
      // Catches bytes that became visible during setup even if their
      // notification coalesced with an event before the initial read.
      if (!this.wakePending) {
        this.wakePending = true;
        this.wakes.push(true);
      }
      void this.follow();
      return { seed, events: this.events };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Release the watcher and file handle; closes the event queue. Idempotent.
   *  Commands call it in `finally`, exactly as tail closes its sdk.sock
   *  client. */
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
    this.events.close();
  }

  private fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.streamFailure =
      error instanceof Error ? error : new Error(String(error));
    this.close();
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
    const size = fstatSync(this.fd!).size;
    if (size < this.offset) {
      throw new Error(
        `${this.filePath} truncated below the consumed byte extent ` +
          `(${size} < ${this.offset}); a Claude session file only grows`,
      );
    }
    this.consumeBytes(size, true);
  }

  /** Synchronously consume any bytes appended since the last read. The final
   *  drain when the daemon socket closes: entries flushed just before the
   *  close may not have woken the follower yet, and after close() no wake
   *  ever will. */
  drainVisibleBytes(): void {
    if (this.closed || this.fd === undefined) {
      return;
    }
    try {
      this.consumeToCurrentSize();
    } catch (error) {
      this.fail(error);
    }
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

  /** Read [#offset, end), parse, filter, and (when emitting) push canonical
   *  entries paired with their post-fold state. */
  private consumeBytes(end: number, emit: boolean): void {
    if (end <= this.offset) {
      return;
    }
    const length = end - this.offset;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
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
    this.offset += bytesRead;
    const chunk = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    for (const entry of this.parser.push(chunk)) {
      const accepted = this.filter.accept(entry);
      if (accepted !== undefined && emit) {
        this.events.push({
          event: accepted,
          state: {
            leaf: this.filter.leaf,
            seenUuids: this.filter.seenUuids,
          },
        });
      }
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

/** Resolves when an entry with this uuid is in the file (covers the
 *  ~100–180 ms flush lag after the SDK result message). A stream condition
 *  over a history:"skip" subscription: `seenUuids` membership, not canonical
 *  emission, so a duplicate or pre-cursor occurrence also satisfies it. */
export async function waitForEntry(
  filePath: string,
  uuid: UUID,
  timeoutMs = 10_000,
): Promise<void> {
  const client = new SessionEntryClient(filePath, { history: "skip" });
  try {
    const { outcome } = await runStream(
      client,
      {
        onSeed: (seed) => seed.seenUuids.has(uuid),
        onEvent: (_entry, state) => state.seenUuids.has(uuid),
      },
      timeoutMs,
    );
    if (outcome === "timeout") {
      throw new Error(
        `entry ${uuid} did not appear in ${filePath} within ${timeoutMs}ms`,
      );
    }
    if (outcome === "closed") {
      throw (
        client.failure ??
        new Error(`entry stream for ${filePath} closed unexpectedly`)
      );
    }
  } finally {
    client.close();
  }
}

/** The file's entries once `leafUuid` (the last transcript entry the caller
 *  has seen reported elsewhere, e.g. on the daemon's event stream) is on
 *  disk — read consistency across the CLI's flush lag. Pass undefined when
 *  there is nothing to wait for. Deliberately wait-then-read rather than a
 *  one-pass collect-until-leaf: the read returns the whole file at read
 *  time, including entries persisted after the leaf. */
export async function readEntriesAfterStreamFlush(
  filePath: string,
  leafUuid: UUID | undefined,
): Promise<SessionEntry[]> {
  if (leafUuid !== undefined) {
    await waitForEntry(filePath, leafUuid);
  }
  return readSessionEntries(filePath);
}
