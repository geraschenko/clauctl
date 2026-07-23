/**
 * ALL claude-specificity of the TUI: pure conversions from SDK messages and
 * raw API stream events to the pi-ai-shaped render model (render-types.ts).
 * Also the conversion layer for `clauctl format` (src/format/) — format and
 * the TUI present differently, but both read SDK payloads through exactly
 * these conversions.
 *
 * pi's renderers receive a fully-reconstructed partial AssistantMessage on
 * every delta; our stream carries raw API deltas (`stream_event`,
 * includePartialMessages is an invariant). The fold below reconstructs the
 * same "full partial" shape so the ported components see what they expect.
 * The streaming unit is one assistant API message (a turn contains several);
 * a StreamingMessage is created at each `message_start`.
 */

import type {
  BetaRawMessageStreamEvent,
  BetaStopReason,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  treeNodeRefsEqual,
  type PathNode,
  type TreeNodeRef,
} from "../core/tree/nodes.ts";
import type {
  RenderAssistant,
  RenderBlock,
  RenderToolResult,
  StopReason,
} from "./render-types.ts";

export interface StreamingMessage {
  partial: RenderAssistant;
  /**
   * Accumulation state, indexed by the API's content-block index. Slots stay
   * undefined for block types the render model drops (redacted thinking,
   * server tool use, …); `partial.content` is this array with the holes
   * filtered out.
   */
  blocks: (RenderBlock | undefined)[];
}

export function beginMessage(): StreamingMessage {
  return { partial: { content: [] }, blocks: [] };
}

function withBlock(
  streaming: StreamingMessage,
  index: number,
  block: RenderBlock,
): StreamingMessage {
  const blocks = [...streaming.blocks];
  blocks[index] = block;
  return {
    blocks,
    partial: { content: blocks.filter((b) => b !== undefined) },
  };
}

/**
 * Fold one raw stream event into the partial message. Tool-input JSON deltas
 * are deliberately not accumulated: arguments render from the authoritative
 * `assistant` message that finalizes the streaming component.
 */
export function foldStreamEvent(
  streaming: StreamingMessage,
  event: BetaRawMessageStreamEvent,
): StreamingMessage {
  switch (event.type) {
    case "content_block_start": {
      const block = event.content_block;
      switch (block.type) {
        case "text":
          return withBlock(streaming, event.index, {
            type: "text",
            text: block.text,
          });
        case "thinking":
          return withBlock(streaming, event.index, {
            type: "thinking",
            thinking: block.thinking,
          });
        case "tool_use":
          return withBlock(streaming, event.index, {
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: block.input,
          });
        default:
          return streaming;
      }
    }
    case "content_block_delta": {
      const existing = streaming.blocks[event.index];
      if (existing === undefined) {
        return streaming;
      }
      const delta = event.delta;
      if (delta.type === "text_delta" && existing.type === "text") {
        return withBlock(streaming, event.index, {
          type: "text",
          text: existing.text + delta.text,
        });
      }
      if (delta.type === "thinking_delta" && existing.type === "thinking") {
        return withBlock(streaming, event.index, {
          type: "thinking",
          thinking: existing.thinking + delta.thinking,
        });
      }
      return streaming;
    }
    case "message_start":
    case "message_delta":
    case "message_stop":
    case "content_block_stop":
      return streaming;
  }
}

/**
 * Map the API stop reason onto pi-ai's StopReason so the ported components'
 * stopReason handling applies unchanged. `refusal` is the only value that maps
 * to a rendered variant ("error"); the API never reports aborted/errored turns
 * per-message (those arrive as `result` / `interruptSent` events).
 */
function toStopReason(
  stopReason: BetaStopReason | null,
): { stopReason: StopReason; errorMessage?: string } | undefined {
  switch (stopReason) {
    case null:
      return undefined;
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    case "compaction":
      return { stopReason: "stop" };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return {
        stopReason: "error",
        errorMessage: "the model refused to continue (stop_reason: refusal)",
      };
  }
}

/** The authoritative render of a complete assistant API message. */
export function renderAssistant(message: SDKAssistantMessage): RenderAssistant {
  const content: RenderBlock[] = [];
  for (const block of message.message.content) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "thinking":
        content.push({ type: "thinking", thinking: block.thinking });
        break;
      case "tool_use":
        content.push({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
        break;
      default:
        break;
    }
  }
  return { content, ...toStopReason(message.message.stop_reason) };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/** Tool results carried by a `user` SDK message (empty for plain user turns). */
export function toolResultsOf(message: SDKUserMessage): RenderToolResult[] {
  const content = message.message.content;
  if (typeof content === "string") {
    return [];
  }
  const results: RenderToolResult[] = [];
  for (const block of content) {
    if (block.type === "tool_result") {
      results.push({
        toolCallId: block.tool_use_id,
        content: toolResultText(block.content),
        isError: block.is_error === true,
      });
    }
  }
  // The message-level tool_use_result is attributable to a specific result
  // only when the message carries exactly one tool_result block.
  if (results.length === 1 && message.tool_use_result !== undefined) {
    results[0]!.toolUseResult = message.tool_use_result;
  }
  return results;
}

/**
 * The replayable portion of a root-to-leaf display path: everything
 * at/before the live leaf's visible row (the state fold's current leaf —
 * the last transcript entry reflected on the event stream before the
 * subscriber's snapshot — mapped by the caller to the display row that
 * carries it). An undefined row means nothing was emitted this daemon
 * lifetime → the whole path replays.
 *
 * After the match, only boundary banners and their summaries are kept —
 * ordinary rows are the entries whose live events render them, but keeping
 * these keeps a compaction segment structurally complete (banner before its
 * installed context), and a summary's live `user` event renders no text
 * (the sdkMessage user case only resolves tool results), so replay is the
 * only way its text appears. Their buffered events release-dedupe by uuid
 * like any other replayed entry.
 *
 * A row missing from the path means the read raced a writer: either a
 * context change moved the leaf between snapshot and read (resolved by the
 * buffered contextChanged's reload), or a genuine invariant violation. The
 * cut is impossible either way, so the whole path replays with
 * `boundaryMissing` set; the caller decides whether to warn.
 */
export function pathUpToBoundary(
  path: PathNode[],
  leafRow: TreeNodeRef | undefined,
): { nodes: PathNode[]; boundaryMissing: boolean } {
  if (leafRow === undefined) {
    return { nodes: path, boundaryMissing: false };
  }
  const matchIndex = path.findIndex((node) =>
    treeNodeRefsEqual(node.ref, leafRow),
  );
  if (matchIndex === -1) {
    return { nodes: path, boundaryMissing: true };
  }
  return {
    nodes: [
      ...path.slice(0, matchIndex + 1),
      ...path
        .slice(matchIndex + 1)
        .filter(
          (node) =>
            node.entry.subtype === "compact_boundary" ||
            node.entry.isCompactSummary === true,
        ),
    ],
    boundaryMissing: false,
  };
}

/**
 * The uuid on which a live message deduplicates against a replayed path, or
 * undefined when the message kind never renders replayed content: only
 * user/assistant messages, stream events (their partial-message wrapper
 * carries the transcript uuid), and compact_boundary banners can double-
 * render; other system subtypes render content no path replay produces, so
 * a uuid collision must not swallow them.
 */
export function releaseDedupeUuid(message: SDKMessage): string | undefined {
  return message.type === "user" ||
    message.type === "assistant" ||
    message.type === "stream_event" ||
    (message.type === "system" && message.subtype === "compact_boundary")
    ? message.uuid
    : undefined;
}

/** The displayable text of a user turn (image/document blocks are dropped). */
export function userText(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * The visible pieces of a user turn, claude-style: plain prompts, the CLI's
 * local-command tags (`<command-name>`, `<local-command-stdout>`,
 * `<bash-input>`/`<bash-stdout>`/`<bash-stderr>`), and context tags like
 * `<ide_selection>`. Tag shapes are empirical, from captured 2.1.211
 * sessions (see the tui-rendering-parity spec WORK LOG).
 */
export type UserTurnView =
  | { kind: "prompt"; text: string }
  | { kind: "slashCommand"; command: string; args: string }
  | { kind: "commandOutput"; text: string }
  | { kind: "bashInput"; command: string }
  | { kind: "bashOutput"; stdout: string; stderr: string }
  | { kind: "contextTag"; tag: string; text: string };

/** The CLI escapes exactly `<` and `>` inside its local-command tags
 *  (empirical: raw `&` appears unescaped in captured sessions), so one
 *  unescaping pass over extracted tag contents restores the text. */
function unescapeTagContent(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

const CONTEXT_TAGS = ["ide_selection"];

/** `<tag>inner</tag>` at the start of `source` (undefined when the opening
 *  tag is absent or unclosed — the caller treats that as malformed). */
function extractTag(
  source: string,
  tag: string,
): { inner: string; rest: string } | undefined {
  const open = `<${tag}>`;
  if (!source.startsWith(open)) {
    return undefined;
  }
  const close = `</${tag}>`;
  const end = source.indexOf(close, open.length);
  if (end === -1) {
    return undefined;
  }
  return {
    inner: source.slice(open.length, end),
    rest: source.slice(end + close.length),
  };
}

const COMMAND_TAGS = ["command-name", "command-message", "command-args"];

/**
 * Parse one user turn's text into views. Command tags appear in any order
 * (both name-first and message-first occur in real sessions), whitespace-
 * separated; `<local-command-caveat>` renders nothing (its entries are
 * normally isMeta-filtered anyway); text outside known tags is a prompt.
 * A malformed known tag (unclosed) falls back to one verbatim prompt view.
 */
export function userTurnViewsFromText(text: string): UserTurnView[] {
  const views: UserTurnView[] = [];
  let rest = text;
  let plain = "";
  const flushPlain = (): void => {
    if (plain.trim() !== "") {
      views.push({ kind: "prompt", text: plain.trim() });
    }
    plain = "";
  };
  while (rest !== "") {
    if (COMMAND_TAGS.some((tag) => rest.startsWith(`<${tag}>`))) {
      let command: string | undefined;
      let args = "";
      let matched = extractCommandTag(rest);
      while (matched !== undefined) {
        if (matched.tag === "command-name") {
          command = unescapeTagContent(matched.inner);
        } else if (matched.tag === "command-args") {
          args = unescapeTagContent(matched.inner);
        }
        rest = matched.rest.replace(/^\s+/, "");
        matched = extractCommandTag(rest);
      }
      if (command === undefined) {
        return [{ kind: "prompt", text }];
      }
      flushPlain();
      views.push({ kind: "slashCommand", command, args });
      continue;
    }
    const stdout = extractTag(rest, "local-command-stdout");
    if (stdout !== undefined) {
      flushPlain();
      views.push({
        kind: "commandOutput",
        text: unescapeTagContent(stdout.inner),
      });
      rest = stdout.rest.replace(/^\s+/, "");
      continue;
    }
    const caveat = extractTag(rest, "local-command-caveat");
    if (caveat !== undefined) {
      rest = caveat.rest.replace(/^\s+/, "");
      continue;
    }
    const bashInput = extractTag(rest, "bash-input");
    if (bashInput !== undefined) {
      flushPlain();
      views.push({
        kind: "bashInput",
        command: unescapeTagContent(bashInput.inner),
      });
      rest = bashInput.rest.replace(/^\s+/, "");
      continue;
    }
    if (rest.startsWith("<bash-stdout>") || rest.startsWith("<bash-stderr>")) {
      const bashStdout = extractTag(rest, "bash-stdout");
      const afterStdout = bashStdout?.rest.replace(/^\s+/, "") ?? rest;
      const bashStderr = extractTag(afterStdout, "bash-stderr");
      if (bashStdout === undefined && bashStderr === undefined) {
        return [{ kind: "prompt", text }];
      }
      flushPlain();
      views.push({
        kind: "bashOutput",
        stdout: unescapeTagContent(bashStdout?.inner ?? ""),
        stderr: unescapeTagContent(bashStderr?.inner ?? ""),
      });
      rest = (bashStderr?.rest ?? afterStdout).replace(/^\s+/, "");
      continue;
    }
    const contextTag = CONTEXT_TAGS.find((tag) => rest.startsWith(`<${tag}>`));
    if (contextTag !== undefined) {
      const extracted = extractTag(rest, contextTag);
      if (extracted === undefined) {
        return [{ kind: "prompt", text }];
      }
      flushPlain();
      views.push({
        kind: "contextTag",
        tag: contextTag,
        text: extracted.inner,
      });
      rest = extracted.rest.replace(/^\s+/, "");
      continue;
    }
    // An unclosed known tag start would loop forever; any known opener
    // reaching here is malformed → verbatim fallback.
    if (knownTagAt(rest)) {
      return [{ kind: "prompt", text }];
    }
    const next = nextKnownTagIndex(rest);
    plain += rest.slice(0, next);
    rest = rest.slice(next);
  }
  flushPlain();
  return views;
}

function extractCommandTag(
  source: string,
): { tag: string; inner: string; rest: string } | undefined {
  for (const tag of COMMAND_TAGS) {
    const extracted = extractTag(source, tag);
    if (extracted !== undefined) {
      return { tag, ...extracted };
    }
  }
  return undefined;
}

const KNOWN_TAGS = [
  ...COMMAND_TAGS,
  "local-command-stdout",
  "local-command-caveat",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  ...CONTEXT_TAGS,
];

function knownTagAt(source: string): boolean {
  return KNOWN_TAGS.some((tag) => source.startsWith(`<${tag}>`));
}

/** Offset of the next known tag opener (source length when none). */
function nextKnownTagIndex(source: string): number {
  let index = source.indexOf("<", 1);
  while (index !== -1) {
    if (knownTagAt(source.slice(index))) {
      return index;
    }
    index = source.indexOf("<", index + 1);
  }
  return source.length;
}

/** The claude-style views of a user turn (empty for tool-result carriers). */
export function userTurnViews(message: SDKUserMessage): UserTurnView[] {
  const text = userText(message);
  return text === "" ? [] : userTurnViewsFromText(text);
}
