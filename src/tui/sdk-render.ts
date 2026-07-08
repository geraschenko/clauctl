/**
 * ALL claude-specificity of the TUI: pure conversions from SDK messages and
 * raw API stream events to the pi-ai-shaped render model (render-types.ts).
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
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
  return results;
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
