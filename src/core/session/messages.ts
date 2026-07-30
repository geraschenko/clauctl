/**
 * The entry→message projection (docs/specs/
 * streaming-conversions-and-formatters.md): canonical message records are
 * bare SDK-shaped messages interleaved with explicitly typed control records,
 * produced from canonical session entries. One projection serves every
 * consumer — `format messages` over entries input and the later
 * `tail`/`prompt --type messages` — so formatted and `--json` output cannot
 * diverge.
 */

import type { UUID } from "node:crypto";
import { CanonicalEntryFilter } from "./entry-stream.ts";
import {
  entryToSessionMessage,
  type SessionEntry,
  type SessionMessageOnWire,
} from "./file.ts";

export type MessageControl =
  | Readonly<{ kind: "model_changed"; from: string; to: string }>
  | Readonly<{ kind: "permission_mode_changed"; from: string; to: string }>
  | Readonly<{ kind: "compaction"; trigger?: string; preTokens?: number }>
  | Readonly<{ kind: "queued_input"; text: string }>;

export type ControlRecord = Readonly<{
  type: "control";
  control: MessageControl;
  /** Source entry uuid when that entry carries one. A model_changed control
   *  shares its uuid with the assistant message record that follows — both
   *  derive from the same entry. */
  uuid?: UUID;
  /** Source entry timestamp when present. */
  timestamp?: string;
}>;

/** One line of canonical message JSONL: bare SDK-shaped messages (the type
 *  discriminant is already "user"|"assistant") interleaved with
 *  type:"control" records. */
export type MessageRecord = SessionMessageOnWire | ControlRecord;

function control(entry: SessionEntry, fields: MessageControl): ControlRecord {
  return {
    type: "control",
    control: fields,
    ...(entry.uuid !== undefined && { uuid: entry.uuid }),
    ...(typeof entry.timestamp === "string" && {
      timestamp: entry.timestamp,
    }),
  };
}

/** Stateful entry→message projection: tracks last-seen model and permission
 *  mode to emit change controls (nothing on first sighting). Input must
 *  already be canonical (first-wins deduplicated); the projector does not
 *  dedup. Entry kinds outside the projection rules return [] and stay
 *  visible only via `--type entries`. */
export class MessageProjector {
  private lastModel: string | undefined;
  private lastPermissionMode: string | undefined;

  /** Records projected from one entry: zero or more controls followed by at
   *  most one message. */
  push(entry: SessionEntry): MessageRecord[] {
    switch (entry.type) {
      case "user":
      case "assistant": {
        const message = entryToSessionMessage(entry);
        if (message === undefined) {
          return [];
        }
        const records: MessageRecord[] = [];
        const payload = entry.message as { model?: unknown } | undefined;
        const model =
          typeof payload?.model === "string" ? payload.model : undefined;
        if (entry.type === "assistant" && model !== undefined) {
          if (this.lastModel !== undefined && this.lastModel !== model) {
            records.push(
              control(entry, {
                kind: "model_changed",
                from: this.lastModel,
                to: model,
              }),
            );
          }
          this.lastModel = model;
        }
        records.push(message);
        return records;
      }
      case "permission-mode": {
        const mode = entry.permissionMode;
        if (typeof mode !== "string") {
          return [];
        }
        const previous = this.lastPermissionMode;
        this.lastPermissionMode = mode;
        if (previous === undefined || previous === mode) {
          return [];
        }
        return [
          control(entry, {
            kind: "permission_mode_changed",
            from: previous,
            to: mode,
          }),
        ];
      }
      case "system": {
        if (entry.subtype !== "compact_boundary") {
          return [];
        }
        // The boundary fact is never dropped: malformed compactMetadata just
        // omits the fields that fail to validate.
        const metadata = entry.compactMetadata as
          { trigger?: unknown; preTokens?: unknown } | undefined;
        return [
          control(entry, {
            kind: "compaction",
            ...(typeof metadata?.trigger === "string" && {
              trigger: metadata.trigger,
            }),
            ...(typeof metadata?.preTokens === "number" && {
              preTokens: metadata.preTokens,
            }),
          }),
        ];
      }
      case "queue-operation": {
        // Dequeue emits nothing — the delivered user message follows as its
        // own entry.
        if (
          entry.operation !== "enqueue" ||
          typeof entry.content !== "string"
        ) {
          return [];
        }
        return [control(entry, { kind: "queued_input", text: entry.content })];
      }
      default:
        return [];
    }
  }
}

/** The canonical entries→messages stream conversion: first-wins filter, then
 *  projection. */
export async function* projectEntries(
  entries: AsyncIterable<SessionEntry>,
): AsyncIterable<MessageRecord> {
  const filter = new CanonicalEntryFilter();
  const projector = new MessageProjector();
  for await (const entry of entries) {
    const accepted = filter.accept(entry);
    if (accepted !== undefined) {
      yield* projector.push(accepted);
    }
  }
}
