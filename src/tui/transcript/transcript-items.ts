import type { UUID } from "node:crypto";
import { isOpenStream, type TranscriptItem } from "./transcript-item.ts";

export type ItemPart = "resolved" | "pending";

/**
 * The transcript's items in order: the resolved part, then the pending part
 * (docs/specs/query-pending-list/phase-1.5-render-at-resolution.md). A
 * query message renders into the pending part; an entry, which the caller
 * delivers only once the merge resolved its uuid, into the resolved part.
 * `resolveThrough(uuid)` moves the pending prefix through the items keyed
 * `uuid` — items of one `append` call share its uuid and are contiguous —
 * and the unkeyed items after them (banners: query-side notices that
 * resolve as soon as nothing unresolved precedes them; they join the
 * resolved part directly when the pending part is empty), stopping at the
 * next keyed item or open stream. A stream's item is never keyed (the
 * `message_start` names only the API `message.id`, shared by every block of
 * the response) and stays pending, blocking the move, until `message_stop`
 * drops it; a file-only entry resolving while it streams lands above it, in
 * file order. The pending part is therefore empty or starts with a keyed
 * item or an open stream's item.
 */
export class TranscriptItems {
  private readonly resolvedItems: TranscriptItem[] = [];
  private readonly pendingItems: TranscriptItem[] = [];

  get resolved(): readonly TranscriptItem[] {
    return this.resolvedItems;
  }

  get pending(): readonly TranscriptItem[] {
    return this.pendingItems;
  }

  /** The last item overall: pending's last, else resolved's. */
  last(): TranscriptItem | undefined {
    return this.pendingItems.at(-1) ?? this.resolvedItems.at(-1);
  }

  /** A keyed item into `part`; an open stream's item into pending; any
   *  other unkeyed item behind the pending items if there are any, else
   *  into resolved. Ahead of `before` when `before` is in the target list,
   *  else at its end. */
  insert(item: TranscriptItem, part: ItemPart, before?: TranscriptItem): void {
    const target =
      item.uuid !== undefined
        ? part === "resolved"
          ? this.resolvedItems
          : this.pendingItems
        : this.pendingItems.length > 0 || isOpenStream(item)
          ? this.pendingItems
          : this.resolvedItems;
    const index = before === undefined ? -1 : target.indexOf(before);
    if (index === -1) {
      target.push(item);
    } else {
      target.splice(index, 0, item);
    }
  }

  /** The pending prefix through the last item keyed `uuid`, plus the
   *  unkeyed items after it up to the next keyed item or open stream,
   *  joins resolved. No-op when no pending item is keyed `uuid`. */
  resolveThrough(uuid: UUID): void {
    const last = this.pendingItems.findLastIndex((item) => item.uuid === uuid);
    if (last !== -1) {
      this.resolvePrefix(last + 1);
    }
  }

  /** Removes `item` from pending (no-op if absent); when it was the
   *  pending head, the unkeyed items now at the head join resolved. */
  removePending(item: TranscriptItem): void {
    const index = this.pendingItems.indexOf(item);
    if (index === -1) {
      return;
    }
    this.pendingItems.splice(index, 1);
    if (index === 0) {
      this.resolvePrefix(0);
    }
  }

  clear(): void {
    this.resolvedItems.length = 0;
    this.pendingItems.length = 0;
  }

  /** The pending items before `end`, plus the unkeyed ones after them up
   *  to the next keyed item or open stream, join the resolved part. */
  private resolvePrefix(end: number): void {
    while (
      end < this.pendingItems.length &&
      this.pendingItems[end]!.uuid === undefined &&
      !isOpenStream(this.pendingItems[end]!)
    ) {
      end += 1;
    }
    this.resolvedItems.push(...this.pendingItems.splice(0, end));
  }
}
