/**
 * Per-tool transcript rendering: how each tool's header, collapsed summary,
 * and fold-line contribution look. claude-derived code — the views replicate
 * claude 2.1.211's rendering (formats captured by scripts/tui-parity/) and
 * are keyed by the generated input types (generated.ts), so they are updated
 * against fresh captures when the bundled claude version changes. Tools
 * without a view (including MCP and legacy tools of older claude versions)
 * render through defaultToolView, as claude itself does for unknown tools.
 * The session tree shares the views: an entry view's tool-call summary is
 * the view's header (src/tui/entry-views/entry-view.ts).
 */

import type { RenderToolResult } from "../render-types.ts";
import type { ToolInputMap, ToolName } from "./generated.ts";
import { agentView } from "./agent.ts";
import { bashView } from "./bash.ts";
import { defaultToolView } from "./default-tool-view.ts";
import { editView } from "./edit.ts";
import { readView } from "./read.ts";
import { webSearchView } from "./websearch.ts";
import { writeView } from "./write.ts";

export {
  collapsedOutputSummary,
  defaultToolView,
} from "./default-tool-view.ts";

export interface ToolHeader {
  /** The call's purpose in words (Bash `description`); absent for tools
   *  without one. */
  readonly description?: string;
  /** The one argument that identifies the call (Bash command, Read path);
   *  absent when the tool has none. */
  readonly arg?: string;
}

export interface ToolView<A> {
  /** Rendered header name where it differs from the tool name:
   *  Edit → "Update". Undefined → the tool name. */
  displayName?: string;
  header(args: A, cwd: string | undefined): ToolHeader;
  /** Absolute path the header arg refers to; rendered as an OSC 8 file
   *  link when pi-tui's capability detection positively identifies a
   *  hyperlink-capable terminal (and the arg fits on a single header
   *  line). Undefined/absent → plain text. */
  headerLink?(args: A): string | undefined;
  /** Collapsed ⤷ text. Views wanting the generic rule delegate to
   *  `defaultToolView.resultSummary`; never undefined. */
  resultSummary(
    args: A,
    result: RenderToolResult,
    cwd: string | undefined,
  ): string;
  /** Fold-line contribution, e.g. (2) => "read 2 files"; absent → the
   *  generic "used Name N times" clause. */
  foldLabel?(count: number): string;
  /** Extra block rendered beneath the ⤷ summary in BOTH toggle states
   *  (claude renders it identically collapsed and expanded). Exists
   *  specifically for the Edit view, whose result rendering is the
   *  line-numbered diff — no other view implements it. */
  resultBody?(args: A, result: RenderToolResult): string | undefined;
}

/** Claude Code's built-in tools without side effects: the single
 *  classification behind both presentations of read-only activity — the
 *  TUI's thinking+read-only fold (transcript.ts) and the text formatter's
 *  coalesced runs (src/format/messages.ts). Skill/Agent and MCP tools
 *  (`mcp__*`) stay visible: their activity is meaningful (or their effects
 *  unknowable). WebSearch is excluded despite being conceptually read-only:
 *  a network operation heavy enough that its activity stays visible in both
 *  presentations (claude keeps it visible too). ToolSearch stays despite
 *  claude hiding its calls entirely — the fold clause is informative. Bash
 *  is handled separately by each consumer (the formatter coalesces it with
 *  visible commands; the TUI never folds it — decided divergence from
 *  claude, which folds read-only-looking commands). Update on drift of the
 *  CLI's tool set. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "NotebookRead",
  "WebFetch",
  "ToolSearch",
  "TaskGet",
  "TaskList",
  "ListMcpResources",
  "ReadMcpResource",
  // Removed from the CLI in 2.1.280; kept so older transcripts still fold.
  // Remove after 2026-12-22.
  "TaskOutput",
]);

export const toolViews: { [K in ToolName]?: ToolView<ToolInputMap[K]> } = {
  Agent: agentView,
  Bash: bashView,
  Edit: editView,
  Read: readView,
  WebSearch: webSearchView,
  Write: writeView,
};

/** The single type-erasure point: views are written against their generated
 *  input types, callers hold runtime args as unknown. Views treat args
 *  defensively (args.ts stringArg) — the wire payload is untrusted, so the
 *  lookup is by own property (a tool named `constructor` is unknown, not
 *  a function). */
export function toolViewFor(name: string): ToolView<unknown> {
  const view = Object.hasOwn(toolViews, name)
    ? (toolViews as Record<string, ToolView<unknown> | undefined>)[name]
    : undefined;
  return view ?? defaultToolView;
}
