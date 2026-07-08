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
}
