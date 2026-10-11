import type { RenderAssistant } from "../../format/render-types.ts";

export function hasThinking(rendered: RenderAssistant): boolean {
  return rendered.content.some(
    (block) => block.type === "thinking" && block.thinking.trim() !== "",
  );
}

/** Whole seconds for a "Thought for Ns" label, as claude 2.1.258 shows
 *  them: floored, with a 1s minimum for sub-second durations (observed in
 *  parity captures; all multi-second durations matched the floor). */
export function displayThinkingSeconds(seconds: number): number {
  return Math.max(1, Math.floor(seconds));
}

/** The collapsed-thinking label of an unfolded assistant item. `ctrl+t`
 *  where claude says `ctrl+o`: decided divergence (we split the two
 *  toggles). */
export function hiddenThinkingLabel(seconds: number | undefined): string {
  return seconds === undefined
    ? "Thinking… (ctrl+t to show)"
    : `Thought for ${displayThinkingSeconds(seconds)}s (ctrl+t to show)`;
}
