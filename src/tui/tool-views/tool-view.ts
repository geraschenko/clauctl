/**
 * Per-tool transcript rendering: how each tool's header, collapsed summary,
 * and fold-line contribution look. claude-derived code — the views replicate
 * claude 2.1.211's rendering (formats captured by scripts/tui-parity/) and
 * are keyed by the generated input types (generated.ts), so they are updated
 * against fresh captures when the bundled claude version changes. Tools
 * without a view (including MCP and legacy tools of older claude versions)
 * use ToolExecutionComponent's generic fallback, as claude itself does for
 * unknown tools.
 */

import type { RenderToolResult } from "../render-types.ts";
import type { ToolInputMap, ToolName } from "./generated.ts";
import { agentView } from "./agent.ts";
import { bashView } from "./bash.ts";
import { editView } from "./edit.ts";
import { readView } from "./read.ts";
import { writeView } from "./write.ts";

export interface ToolView<A> {
  /** Rendered header name where it differs from the tool name:
   *  Edit → "Update". Undefined → the tool name. */
  displayName?: string;
  /** Header arg, e.g. "~/notes.txt" for Write; undefined → bare name. */
  headerArg(args: A, cwd: string | undefined): string | undefined;
  /** Absolute path the header arg refers to; rendered as an OSC 8 file
   *  link when pi-tui's capability detection positively identifies a
   *  hyperlink-capable terminal (and the arg fits on a single header
   *  line). Undefined/absent → plain text. */
  headerLink?(args: A): string | undefined;
  /** Collapsed ⎿ summary; undefined → generic first-lines + "… +N lines". */
  resultSummary(args: A, result: RenderToolResult): string | undefined;
  /** Folds into the "Thought for Ns, read 1 file" line. */
  readOnly: boolean;
  /** Fold-line contribution, e.g. (2) => "read 2 files". */
  foldLabel(count: number): string;
  /** Extra block rendered beneath the ⎿ summary in BOTH toggle states
   *  (claude renders it identically collapsed and expanded). Exists
   *  specifically for the Edit view, whose result rendering is the
   *  line-numbered diff — no other view implements it. */
  resultBody?(args: A, result: RenderToolResult): string | undefined;
}

export const toolViews: { [K in ToolName]?: ToolView<ToolInputMap[K]> } = {
  Agent: agentView,
  Bash: bashView,
  Edit: editView,
  Read: readView,
  Write: writeView,
};

/** The single type-erasure point: views are written against their generated
 *  input types, callers hold runtime args as unknown. Views treat args
 *  defensively (args.ts stringArg) — the wire payload is untrusted. */
export function toolViewFor(name: string): ToolView<unknown> | undefined {
  return (toolViews as Record<string, ToolView<unknown> | undefined>)[name];
}
