/**
 * How the CLI turns one persisted attachment entry into wire text
 * (docs/specs/api-messages.md, "render-attachment"). Since CLI 2.1.280
 * every rendering attachment type persists a `rendered` snapshot, which the
 * CLI replays; this module holds no per-type renderers. Payload shapes are
 * the CLI's and untrusted.
 */

import { isRecord } from "../../core/generated/util.ts";
import type { SessionEntry } from "../../core/session/file.ts";

/** Where an attachment's wire text came from: the entry's persisted
 *  `rendered` snapshot (exact), the fallback for entries without a valid
 *  one — the payload's first string field — whose text is a guess, or
 *  `external-state`: the CLI re-renders the type from state outside the
 *  file even when a snapshot exists. */
export type RenderedBy = "snapshot" | "fallback" | "external-state";

export interface AttachmentRendering {
  /** Texts in wire order. Snapshot texts are as persisted (already
   *  wrapped); fallback texts are bare. */
  texts: string[];
  renderedBy: RenderedBy;
}

/** Attachment types the CLI renders to nothing, whatever the payload:
 *  its explicit empty cases and its known-but-unhandled list. Transcribed
 *  from docs/derisk/api-context-view/P0-binary-read.md §c; binary anchor
 *  `case"already_read_file"` (loader chunk; the switch that follows lists
 *  them all). Observed: `tests/sdk/api-context.test.ts` "todo_reminder". */
const RENDERS_NOTHING: ReadonlySet<string> = new Set([
  "already_read_file",
  "command_permissions",
  "batching_reminder_sent",
  "secondary_reminder_sent",
  "edited_image_file",
  "hook_cancelled",
  "hook_error_during_execution",
  "hook_non_blocking_error",
  "hook_system_message",
  "hook_permission_decision",
  "hook_deferred_tool",
  "goal_status",
  "structured_output",
  "max_turns_reached",
  "teammate_shutdown_batch",
  "async_hook_response_batch",
  "attention_budget",
  "context_efficiency",
  "tool_host_result_lines",
  "prompt_snapshot",
  "prompt_render_point",
  "thinking_stripped",
  "thinking_drop",
  "deferred_tools_record",
  "repl_mcp_needs_auth",
  "autocheckpointing",
  "background_task_status",
  "todo",
  "task_progress",
  "ultramemory",
  "compaction_reminder",
  "current_session_memory",
  "thinking_reminder",
  "companion_intro",
  "pen_mode_enter",
  "pen_mode_exit",
  "ultrawork_request",
  "echo_activities",
  "verify_plan_reminder",
  "fold_nudge",
  "context_tip",
  "todo_reminder",
  "task_reminder",
]);

/** Types the CLI renders from request-time state (the current tool set),
 *  ignoring the snapshot's text. Binary anchor: the `deferred_tools_delta`
 *  case near `case"already_read_file"`. */
const EXTERNAL_STATE_TYPES: ReadonlySet<string> = new Set([
  "deferred_tools_delta",
]);

function text(payload: unknown, field: string): string | undefined {
  const value = isRecord(payload) ? payload[field] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** The `rendered` snapshot's texts when it validates as the CLI requires
 *  (non-empty; every item's content a string or text blocks only). */
function snapshotTexts(rendered: unknown): string[] | undefined {
  if (!Array.isArray(rendered) || rendered.length === 0) {
    return undefined;
  }
  const texts: string[] = [];
  for (const item of rendered) {
    const content = isRecord(item) ? item.content : undefined;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) {
      return undefined;
    }
    for (const block of content) {
      if (
        !isRecord(block) ||
        block.type !== "text" ||
        typeof block.text !== "string"
      ) {
        return undefined;
      }
      texts.push(block.text);
    }
  }
  return texts;
}

/** A valid snapshot is replayed; a `queued_command` already rendered by
 *  its batch head (binary anchor `renderedByBatchHead`) and the
 *  RENDERS_NOTHING types render nothing (undefined); anything else is the
 *  fallback guess. */
export function renderAttachmentEntry(
  entry: SessionEntry,
): AttachmentRendering | undefined {
  const payload = isRecord(entry.attachment) ? entry.attachment : {};
  const type = text(payload, "type") ?? "";
  const snapshot = snapshotTexts(entry.rendered);
  if (snapshot !== undefined) {
    return {
      texts: snapshot,
      renderedBy: EXTERNAL_STATE_TYPES.has(type)
        ? "external-state"
        : "snapshot",
    };
  }
  if (
    RENDERS_NOTHING.has(type) ||
    (type === "queued_command" && payload.renderedByBatchHead === true)
  ) {
    return undefined;
  }
  const guess =
    text(payload, "text") ??
    text(payload, "content") ??
    text(payload, "prompt") ??
    text(payload, "message") ??
    JSON.stringify(payload);
  return {
    texts: [guess],
    renderedBy: EXTERNAL_STATE_TYPES.has(type) ? "external-state" : "fallback",
  };
}
