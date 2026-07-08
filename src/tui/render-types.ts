/**
 * The render model the TUI components consume: pi-ai-shaped blocks, defined
 * here (no dependency on @earendil-works/pi-ai). All claude-specificity lives
 * in the converter (sdk-render.ts); everything above it stays diffable
 * against pi's interactive-mode components, which consume the same shapes.
 */

export type RenderBlock =
// TDC: should user and assistant text be different variants?
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

export interface RenderAssistant {
  content: RenderBlock[];
}

export interface RenderToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}
