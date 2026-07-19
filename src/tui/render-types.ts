/**
 * The render model the TUI components consume: pi-ai-shaped blocks, defined
 * here (no dependency on @earendil-works/pi-ai). All claude-specificity lives
 * in the converter (sdk-render.ts); everything above it stays diffable
 * against pi's interactive-mode components, which consume the same shapes.
 */

export type RenderBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

/** pi-ai's StopReason; SDK stop reasons are mapped onto it in sdk-render.ts. */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface RenderAssistant {
  content: RenderBlock[];
  /** Absent while streaming (pi-ai's is required; partials have none here). */
  stopReason?: StopReason;
  errorMessage?: string;
}

export interface RenderToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
  /** The SDK's structured per-tool output (`tool_use_result`), attached when
   *  the carrying user message has exactly one tool_result block. */
  // TDC: why not call this "tool_use_result"?
  // TDC: How did you determing the tool-specific outuput types? In sdk.d.ts, it just says "see the *Output types in toolTypes", but I don't see those output types anywhere.
  structured?: unknown;
}
