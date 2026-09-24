/**
 * The rendering of a tool without a specific view, and the collapse rule
 * the specific views delegate to. A separate module (not tool-view.ts) for
 * the same reason as args.ts: views import it at runtime, so it must not
 * be the registry that imports them.
 */

import { countLines } from "../../../core/generated/text.ts";
import type { RenderToolResult } from "../../render-types.ts";
import type { ToolView } from "./tool-view.ts";

// TODO: expand hint should actually be tied to the keyboard shortcut.
const EXPAND_HINT = "(ctrl+o to expand)";

/** The collapse rule: one source line → the content; else
 *  `N lines (ctrl+o to expand)`. Plain text — the hint is not dimmed (a
 *  view's summary is one string rendered uniformly). */
export function collapsedOutputSummary(content: string): string {
  const lineCount = countLines(content);
  return lineCount <= 1 ? content : `${lineCount} lines ${EXPAND_HINT}`;
}

export const defaultToolView: ToolView<unknown> = {
  header() {
    return {};
  },
  resultSummary(_args, result: RenderToolResult) {
    return collapsedOutputSummary(result.content.trim());
  },
};
