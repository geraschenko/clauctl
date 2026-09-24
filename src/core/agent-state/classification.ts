import type { UUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  MergeStream,
  AgentState,
  SessionState,
} from "../protocol/index.ts";
import { queuedCommandSourceUuid, type SessionEntry } from "../session/file.ts";
import { isToolResultEntry } from "../tree/loader.ts";

/** `type/subtype` of a query message or log entry, for anomaly details
 *  and event annotations. */
export function classOf(item: { type?: string; subtype?: string }): string {
  return item.subtype === undefined
    ? (item.type ?? "?")
    : `${item.type}/${item.subtype}`;
}

/** The classification table, one function per side: whether the other
 *  stream never carries this occurrence. Uuid-less occurrences are not
 *  asked. `excludedFromQuery` needs the complete entry (it reads
 *  `message.content`), so the tracker calls it once per entry and
 *  publishes the answer as the event's `expectsSdkMessage`; the fold reads
 *  that. */
export function excludedFromSession(message: SDKMessage): boolean {
  switch (message.type) {
    case "assistant":
    case "user":
      return false;
    case "system":
      return message.subtype !== "compact_boundary";
    default:
      return true;
  }
}
export function excludedFromQuery(entry: SessionEntry): boolean {
  switch (entry.type) {
    case "assistant":
      return isResumeTurnCloser(entry);
    case "user":
      return !(
        isToolResultEntry(entry) ||
        entry.isCompactSummary === true ||
        isLocalCommandStdout(entry)
      );
    case "system":
      return (
        entry.subtype !== "compact_boundary" &&
        entry.subtype !== "local_command"
      );
    default:
      return true;
  }
}

/** Subagent traffic (user, assistant and their stream_events): its usage
 *  describes the subagent's own context, not this agent's, and its
 *  transcript lives in the subagent's own file, so none of its ids can
 *  meet an entry here — a subagent's merge is a separate session model
 *  over that file (docs/follow-ups/subagent-activity.md). */
export function isSubagentTraffic(message: SDKMessage): boolean {
  return (
    "parent_tool_use_id" in message &&
    typeof message.parent_tool_use_id === "string"
  );
}

/** The classification table's answer for a FIRST observation of `node`
 *  of `event` on `eventStream(event)`: does the other stream never carry
 *  it? (`observeEvent` asks only when the node does not exist yet.) A
 *  stamped event is its stream's alone; a prompt still in
 *  `queuedMessages` is never excluded — its `query` observation is its
 *  dequeue still to come. */
export function excludedFromOther(
  event: AgentEvent,
  node: UUID,
  state: AgentState,
  session: SessionState,
): boolean {
  switch (event.kind) {
    case "userMessageQueued":
    case "compactSent":
    case "interruptSent":
    case "controlApplied":
    case "scanComplete":
    case "contextChanged":
    case "trackerAnomaly":
    case "shutdown":
      return true;
    case "userMessageDequeued":
    case "querySessionChanged":
    case "sessionAppended":
      return false;
    case "sessionFileChanged":
      return event.uuid !== undefined;
    case "sdkMessage":
      return (
        event.message.uuid === undefined ||
        isSubagentTraffic(event.message) ||
        excludedFromSession(event.message)
      );
    case "sessionEntry": {
      const awaitsDequeue = state.queuedMessages.some(
        (queued) => queued.uuid === node,
      );
      if (node === queuedCommandSourceUuid(event.entry)) return !awaitsDequeue;
      if (event.entry.uuid === undefined) return true;
      return (
        !awaitsDequeue && (!event.expectsSdkMessage || session.scanExcluded)
      );
    }
  }
}

/** The `assistant` entry a resumed CLI writes to close a turn the
 *  transcript left open (an interrupt): model `<synthetic>`, text "No
 *  response requested.", persisted with the next prompt and never emitted
 *  to the SDK consumer. The other `<synthetic>` assistant class — API
 *  errors, flagged `isApiErrorMessage` — does travel the query stream, so
 *  the flag is what separates them (classification table). */
function isResumeTurnCloser(entry: SessionEntry): boolean {
  const model = (entry.message as { model?: unknown } | undefined)?.model;
  return model === "<synthetic>" && entry.isApiErrorMessage !== true;
}

/** A slash command's output logged as a `user` entry, which the query
 *  stream replays (`isReplay`) — the shared `user` class that has no
 *  `tool_result` block (classification table). */
function isLocalCommandStdout(entry: SessionEntry): boolean {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return (
    typeof content === "string" && content.startsWith("<local-command-stdout>")
  );
}

/** For anomaly details: `classOf` of the SDK message or entry the event
 *  carries, `"prompt"` for a dequeue, the kind otherwise. */
export function eventClass(event: AgentEvent): string {
  switch (event.kind) {
    case "userMessageDequeued":
      return "prompt";
    case "sdkMessage":
    case "sessionAppended":
      return classOf(event.message);
    case "sessionEntry":
      return classOf(event.entry);
    case "userMessageQueued":
    case "compactSent":
    case "interruptSent":
    case "controlApplied":
    case "contextChanged":
    case "querySessionChanged":
    case "sessionFileChanged":
    case "scanComplete":
    case "trackerAnomaly":
    case "shutdown":
      return event.kind;
  }
}

/** The one stream the event is a node of — what its position is
 *  synchronized with, not where it originated: `session` when the
 *  event's place is fixed relative to the file's append order, `query`
 *  when it is fixed relative to the SDK message sequence
 *  (docs/protocol.md, "The event stream"). */
export function eventStream(event: AgentEvent): MergeStream {
  switch (event.kind) {
    case "sessionEntry":
    case "sessionFileChanged":
    case "scanComplete":
    case "contextChanged":
      return "session";
    case "trackerAnomaly":
      return event.stream;
    case "userMessageQueued":
    case "userMessageDequeued":
    case "compactSent":
    case "interruptSent":
    case "controlApplied":
    case "sdkMessage":
    case "querySessionChanged":
    case "sessionAppended":
    case "shutdown":
      return "query";
  }
}
