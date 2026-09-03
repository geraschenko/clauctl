/**
 * A parallel tool group as the rolling builders see it: the assistant
 * entries sharing one API message id and the results answering their tool
 * calls, in file order, each row the context parent of the next. The
 * loader recovers the same rows around an on-chain assistant
 * (expandParallelToolGroups) and judges dead calls within them
 * (sanitizeForResume); this class holds both judgements.
 */

import type { UUID } from "node:crypto";
import type { UuidEntry } from "../session/file.ts";
import {
  apiMessageIdOf,
  isThinkingOnlyEntry,
  isToolCallEntry,
  toolCallIdsOf,
  toolResultIdsOf,
} from "./loader.ts";

export class ToolGroup {
  private readonly apiMessageId: string | undefined;
  private lastRow: UUID;
  /** Tool call id → uuid of the entry that made the call, until answered. */
  private readonly awaitingResult = new Map<string, UUID>();
  /** Call entries with at least one answered call: the sanitizer keeps an
   *  entry unless every call in it is dead. */
  private readonly answeredCallEntries = new Set<UUID>();
  private readonly thinkingOnly: UUID[] = [];
  /** The group has presentable content: an assistant member that is
   *  neither thinking-only nor a dead call, or an answered call. */
  private hasSurvivor = false;

  /** Starts the group at its first row, an assistant entry. */
  constructor(entry: UuidEntry) {
    this.apiMessageId = apiMessageIdOf(entry);
    this.lastRow = entry.uuid;
    this.admit(entry);
  }

  /** Appends `entry` when it is the group's next row — a same-id
   *  assistant (id-less assistants are each their own group) or a result
   *  answering one of its calls — and returns the row it parents onto;
   *  undefined when the entry ends the group instead. */
  push(entry: UuidEntry): UUID | undefined {
    const continues =
      entry.type === "assistant"
        ? this.apiMessageId !== undefined &&
          apiMessageIdOf(entry) === this.apiMessageId
        : toolResultIdsOf(entry).some((callId) =>
            this.awaitingResult.has(callId),
          );
    if (!continues) {
      return undefined;
    }
    this.admit(entry);
    const predecessor = this.lastRow;
    this.lastRow = entry.uuid;
    return predecessor;
  }

  private admit(entry: UuidEntry): void {
    if (entry.type === "assistant") {
      if (isToolCallEntry(entry)) {
        for (const callId of toolCallIdsOf(entry)) {
          this.awaitingResult.set(callId, entry.uuid);
        }
      } else if (isThinkingOnlyEntry(entry)) {
        this.thinkingOnly.push(entry.uuid);
      } else {
        this.hasSurvivor = true;
      }
    } else {
      for (const callId of toolResultIdsOf(entry)) {
        const callEntry = this.awaitingResult.get(callId);
        if (callEntry !== undefined) {
          this.awaitingResult.delete(callId);
          this.answeredCallEntries.add(callEntry);
          this.hasSurvivor = true;
        }
      }
    }
  }

  /** Whether a call still awaits its result. */
  awaitingResults(): boolean {
    return this.awaitingResult.size > 0;
  }

  /** Uuids the resume sanitizer drops once the group has ended: call
   *  entries none of whose calls was answered, and thinking-only members
   *  when nothing survives. */
  excludedAtEnd(): UUID[] {
    return [
      ...[...this.awaitingResult.values()].filter(
        (callEntry) => !this.answeredCallEntries.has(callEntry),
      ),
      ...(this.hasSurvivor ? [] : this.thinkingOnly),
    ];
  }
}
