// Ported from pi coding-agent src/modes/interactive/components/tool-execution.ts @ 0.80.2-fork.2
//
// pi's component dispatches to per-tool renderCall/renderResult definitions
// (extensions, built-in tool registry, image handling). None of that exists
// here; this port keeps only pi's generic fallback path — a Text block whose
// background tracks pending/success/error, showing tool name + args + output
// (formatToolExecution). Additions of ours:
// - collapsed rendering: args and output are truncated unless expanded
//   (claude-style summaries; pi's fallback shows everything);
// - a nested children container so a Task subagent's activity renders
//   indented under the owning tool (routed by parent_tool_use_id).

import {
  type Component,
  Container,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { theme } from "../theme.ts";
import type { RenderToolResult } from "../render-types.ts";

const COLLAPSED_ARG_LINES = 4;
const COLLAPSED_OUTPUT_LINES = 6;

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  const hidden = lines.length - maxLines;
  return [...lines.slice(0, maxLines), `… (+${hidden} more lines)`].join("\n");
}

/** Renders children shifted right, visually nesting them under the tool. */
class IndentedContainer extends Container {
  override render(width: number): string[] {
    return super.render(Math.max(1, width - 2)).map((line) => `  ${line}`);
  }
}

export class ToolExecutionComponent extends Container {
  private contentText: Text;
  private subagentContainer: IndentedContainer;
  private toolName: string;
  private args: unknown;
  private expanded = false;
  private isPartial = true;
  private result?: RenderToolResult;

  constructor(toolName: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.args = args;

    this.addChild(new Spacer(1));
    this.contentText = new Text("", 1, 1, (text: string) =>
      theme.bg("toolPendingBg", text),
    );
    this.addChild(this.contentText);
    this.subagentContainer = new IndentedContainer();
    this.addChild(this.subagentContainer);

    this.updateDisplay();
  }

  updateArgs(args: unknown): void {
    this.args = args;
    this.updateDisplay();
  }

  updateResult(result: RenderToolResult, isPartial = false): void {
    this.result = result;
    this.isPartial = isPartial;
    this.updateDisplay();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.updateDisplay();
  }

  /** Nest a subagent-produced component under this tool. */
  addSubagentChild(component: Component): void {
    this.subagentContainer.addChild(component);
  }

  override invalidate(): void {
    super.invalidate();
    this.updateDisplay();
  }

  private updateDisplay(): void {
    const bgFn = this.isPartial
      ? (text: string) => theme.bg("toolPendingBg", text)
      : this.result?.isError
        ? (text: string) => theme.bg("toolErrorBg", text)
        : (text: string) => theme.bg("toolSuccessBg", text);
    this.contentText.setCustomBgFn(bgFn);
    this.contentText.setText(this.formatToolExecution());
  }

  private getTextOutput(): string {
    const output = this.result?.content.trim() ?? "";
    return this.expanded
      ? output
      : truncateLines(output, COLLAPSED_OUTPUT_LINES);
  }

  private formatToolExecution(): string {
    let text = theme.fg("toolTitle", theme.bold(this.toolName));
    const argsJson = JSON.stringify(this.args, null, 2);
    const content =
      argsJson === undefined || this.expanded
        ? argsJson
        : truncateLines(argsJson, COLLAPSED_ARG_LINES);
    if (content) {
      text += `\n\n${content}`;
    }
    const output = this.getTextOutput();
    if (output) {
      text += `\n\n${theme.fg("toolOutput", output)}`;
    }
    return text;
  }
}
