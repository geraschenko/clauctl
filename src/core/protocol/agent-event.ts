import type { UUID } from "node:crypto";
import type {
  NonNullableUsage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { queuedCommandSourceUuid, type SessionEntry } from "../session/file.ts";
import type { TreeNodeRef } from "../tree/nodes.ts";
import type { SdkControlApplied } from "./messages.ts";
import type { MergeStream } from "./session-state.ts";
import type { TrackerAnomaly } from "./tracker-anomaly.ts";

export type MessageDelivery = "turn" | "steer" | "append";

/**
 * The augmented event stream (DECISION-6): every SDK message, plus the events
 * only the daemon can know about, serialized so an observer can follow what is
 * happening. This is protocol: the daemon's event hub writes exactly this
 * stream to every subscriber and folds its own state over the same stream
 * (next-agent-state.ts) — so daemon state is always reconstructible by an observer.
 *
 * The CLI's queue operations are invisible on the live stream, so the daemon
 * models the queue (queue-model.ts) and synthesizes the queued/dequeued pair:
 * `userMessageQueued` at acceptance, `userMessageDequeued` next to the SDK
 * message that triggered the dequeue: a steer's dequeue immediately before
 * the assistant frame that absorbed it (the file's order), a turn's or
 * append's immediately after the `result` that dequeued it. A message's
 * uuid is stamped by the daemon before delivery — the uuid its
 * session-file entry carries — so out-of-order dequeuing (a `next` cutting
 * ahead of a `later`) is unambiguous and a dequeue names the entry it
 * predicts. A run — the querying prefix of the top-priority bucket, or a
 * lone append (docs/claude-agent-sdk.md, "Queued prompts coalesce by run")
 * — dequeues as one event carrying all its uuids: it runs as a single turn
 * with a single `result`, filed under the last uuid. A steer and an append
 * are always a run of one (queue-model.ts); consumers need not special-case
 * them.
 *
 * Every event is a node of its session's stream merge (`eventUuid`), on
 * exactly one stream (`eventStream`): one whose payload carries no uuid is
 * stamped by the hub at emission — `uuid` beside an unmutated payload —
 * and observed on its stream, excluded from the other, so it resolves
 * right behind its stream predecessors and a subscriber can place it in
 * file order. `shutdown` is such a node on every live session.
 */
export type AgentEvent =
  // `uuid` is the event's own; `message.uuid` is the prompt's stamped uuid.
  | { kind: "userMessageQueued"; uuid: UUID; message: SDKUserMessage }
  | {
      kind: "userMessageDequeued";
      delivery: MessageDelivery;
      uuids: readonly [UUID, ...UUID[]];
    }
  | { kind: "compactSent"; uuid: UUID; message: SDKUserMessage } // /compact issued while Idle
  | { kind: "interruptSent"; uuid: UUID }
  | { kind: "controlApplied"; uuid: UUID; request: SdkControlApplied }
  // Emitted after the sessionEntry that completes a compact_boundary — the
  // boundary's own, or its anchor's when the block was deferred — whatever
  // wrote it (native compaction or set-context). `leaf` is the final
  // post-boundary context tip (null after a wipe).
  | {
      kind: "contextChanged";
      uuid: UUID;
      boundary: UUID;
      leaf: TreeNodeRef | null;
    }
  // `uuid` only when the message carries none (stream events, results,
  // system frames).
  | { kind: "sdkMessage"; message: SDKMessage; uuid?: UUID }
  // One per canonical log entry of the tracked file, in file order, emitted
  // as soon as the follower reads the line (never held for resolution:
  // subscribers run the same merge). `entry` is the complete entry for every
  // class; `uuid` only when the entry carries none. `expectsSdkMessage` is
  // the tracker's class decision (false = session-only; a prediction from
  // the table, not an observation): the fold reads it rather than
  // re-classifying, so daemon and subscribers cannot disagree. `leaf` is
  // the context tree's leaf after this entry and `lastAssistant` the
  // usage/model of the last non-excluded, non-sidechain assistant on
  // contextAt(leaf) (absent when none; each field independently optional)
  // — daemon-computed, so clients fold them without owning a tree.
  // `awaitingAnchors` lists the boundaries whose blocks are still deferred
  // (session tracker incomplete).
  | {
      kind: "sessionEntry";
      entry: SessionEntry;
      uuid?: UUID;
      expectsSdkMessage: boolean;
      leaf: TreeNodeRef | null;
      lastAssistant?: { usage?: NonNullableUsage; model?: string };
      awaitingAnchors: readonly UUID[];
    }
  // The head of a session's query chain, node `sessionId`: emitted before
  // the first query message carrying it (for the daemon's seeded id, at hub
  // construction). It resolves with the `sessionFileChanged` that starts
  // the same session on the file side, so the session's query messages
  // stay pending until its file is followed.
  | { kind: "querySessionChanged"; sessionId: UUID }
  // The follower moved to `sessionId`: the old file's SessionState is dropped
  // and the new file is about to be scanned.
  | {
      kind: "sessionFileChanged";
      sessionId: UUID;
      /** Absent for a session start: its node is `sessionId`, the same
       *  node `querySessionChanged` observes on `query`, so the session's
       *  two chains meet at their heads. A same-file rescan re-announces a
       *  session whose id already heads its `session` chain, and an id may
       *  appear only once per stream, so it carries a fresh node of its own,
       *  excluded from `query`. */
      uuid?: UUID;
    }
  // The follower's start() has returned for the tracked file: every entry
  // the file held when it was opened has been folded.
  | { kind: "scanComplete"; uuid: UUID }
  // The daemon appended an entry to the query file itself (set-context):
  // its query-stream form, one event per entry in file order, emitted
  // before the drain that delivers the entries — the echo the CLI would
  // have produced had it written them.
  | { kind: "sessionAppended"; message: SDKMessage }
  // An anomaly the daemon detected — by its fold (merge errors,
  // head-mismatch: reported right after the event whose fold raised it)
  // or by its tracker (follower failure, malformed line, classification at
  // the dedup site, awaiting-anchor) — with the diagnostic bundle it wrote.
  // Clients react to this event; the fold only observes its node.
  | {
      kind: "trackerAnomaly";
      uuid: UUID;
      stream: MergeStream;
      anomaly: TrackerAnomaly;
      bundlePath: string;
    }
  // Emitted by the daemon before any teardown, so subscribers can distinguish
  // a deliberate shutdown (archive → SIGTERM, stream end) from a crash (socket
  // close with no announcement). Delivery is best-effort: process exit races
  // kernel buffers, so a lost line degrades to an unannounced close.
  | { kind: "shutdown"; uuid: UUID; reason: string };

/** An event as its emitter hands it to the hub: without the uuid the hub
 *  stamps (optional payload-side uuids are the emitter's to set). */
export type Unstamped<E> = E extends { uuid: UUID }
  ? Omit<E, "uuid" | "bundlePath">
  : E;

/** The event's merge nodes in stream order, its identity last — the
 *  payload's uuid when it carries one (an SDK message's, an entry's, a
 *  dequeue's run key, a session start's session id), else the stamped
 *  `uuid`. A `queued_command` attachment entry first observes the steered
 *  prompt's `source_uuid` (the dequeue's `query` node it meets), so the
 *  attachment's own node, a `session`-only one, resolves only behind the
 *  steer it records: never before its dequeue. */
export function eventNodes(event: AgentEvent): readonly [UUID, ...UUID[]] {
  switch (event.kind) {
    case "userMessageDequeued":
      return [event.uuids[event.uuids.length - 1]!];
    case "sdkMessage":
      return [(event.message.uuid as UUID | undefined) ?? event.uuid!];
    case "sessionEntry": {
      const sourceUuid = queuedCommandSourceUuid(event.entry);
      return sourceUuid === undefined
        ? [event.entry.uuid ?? event.uuid!]
        : [sourceUuid, event.entry.uuid!];
    }
    case "sessionAppended":
      return [event.message.uuid as UUID];
    case "querySessionChanged":
      return [event.sessionId];
    case "sessionFileChanged":
      return [event.uuid ?? event.sessionId];
    case "userMessageQueued":
    case "compactSent":
    case "interruptSent":
    case "controlApplied":
    case "contextChanged":
    case "scanComplete":
    case "trackerAnomaly":
    case "shutdown":
      return [event.uuid];
  }
}

/** The event's identity: the last of `eventNodes(event)`. */
export function eventUuid(event: AgentEvent): UUID {
  return eventNodes(event).at(-1)!;
}

/** The SDKMessage an event carries: the CLI's own frame, or the daemon's
 *  echo of an entry it appended. Both are what the fold observes on
 *  `query`, so a client's pending list and its transcript treat them
 *  alike. */
export function sdkMessageOf(event: AgentEvent): SDKMessage | undefined {
  switch (event.kind) {
    case "sdkMessage":
    case "sessionAppended":
      return event.message;
    default:
      return undefined;
  }
}

/** A pushed stream event on a subscribed connection; no `id`, unlike responses. */
export interface AgentEventRecord {
  event: AgentEvent;
}
