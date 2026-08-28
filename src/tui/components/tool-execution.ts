// pi-inspired (formerly a verbatim port of pi coding-agent's
// tool-execution.ts; taken out of scripts/update-ports.sh when it stopped
// tracking pi's layout). Renders claude 2.1.211's transcript layout —
//
//   ● Name(headerArg)          header wrapped to ≤2 lines, "…)" truncated
//     ⎿  summary               per-tool view, or generic first 3 visual
//        … +N lines (ctrl+o…)  lines of the result
//
// with colors/formats captured by scripts/tui-parity/ (claude-derived:
// update against fresh captures on claude version bumps). A view's
// resultBody (the Edit diff) hangs beneath the ⎿ block in both toggle
// states, as claude renders it. Expanded shows pretty-printed args + full
// result, plus the nested subagent transcript, which stays hidden while
// collapsed behind the "(ctrl+o to expand)" hint line. pi lineage: the
// Component/Container shapes and truncateToVisualLines.

import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Component,
  Container,
  getCapabilities,
  hyperlink,
} from "@earendil-works/pi-tui";
import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { claudeStyle } from "../claude-style.ts";
import type { RenderToolResult } from "../render-types.ts";
import { CachedLinesComponent } from "./cached-lines.ts";
import { toolViewFor, type ToolView } from "../tool-views/tool-view.ts";

const COLLAPSED_RESULT_VISUAL_LINES = 3;
const HEADER_MAX_LINES = 2;
/** Continuation indent of a wrapped header ("● Bash(…" second line). */
const HEADER_CONTINUATION_INDENT = 6;
/** Result lines after the first hang under the summary text, past "  ⎿ ". */
const RESULT_CONTINUATION_INDENT = 5;
/** claude ends the ⎿-prefix with a non-breaking space. */
const RESULT_PREFIX = "  ⎿ \xa0";
const EXPAND_HINT = "(ctrl+o to expand)";

/**
 * Word-wrap `text` (claude's header wrap: break at embedded newlines and
 * whitespace, hard-break overlong words) into at most `maxLines` visual
 * lines; `truncated` reports whether content remains beyond them.
 */
export function wrapHeaderArg(
  text: string,
  firstCapacity: number,
  continuationCapacity: number,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let current = "";
  const push = (): boolean => {
    if (lines.length === maxLines) {
      return false;
    }
    lines.push(current);
    current = "";
    return true;
  };
  const capacity = (): number =>
    Math.max(1, lines.length === 0 ? firstCapacity : continuationCapacity);
  for (const [index, sourceLine] of text.split("\n").entries()) {
    if (index > 0 && !push()) {
      return { lines, truncated: true };
    }
    for (const word of sourceLine.split(" ")) {
      let rest = word;
      for (;;) {
        const cap = capacity();
        const candidate = current === "" ? rest : `${current} ${rest}`;
        if (candidate.length <= cap) {
          current = candidate;
          break;
        }
        if (current === "") {
          // A word longer than the whole line: hard-break it.
          current = rest.slice(0, cap);
          rest = rest.slice(cap);
        }
        // Flush the full line; the loop retries `rest` on the next one.
        if (!push()) {
          return { lines, truncated: true };
        }
      }
    }
  }
  if (current !== "" && !push()) {
    return { lines, truncated: true };
  }
  return { lines, truncated: false };
}

export class ToolExecutionComponent extends CachedLinesComponent {
  private readonly subagentContainer = new Container();
  private readonly toolName: string;
  private readonly args: unknown;
  private readonly cwd: string | undefined;
  private readonly view: ToolView<unknown> | undefined;
  private expanded = false;
  private result?: RenderToolResult;

  constructor(toolName: string, args: unknown, cwd: string | undefined) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.cwd = cwd;
    this.view = toolViewFor(toolName);
  }

  updateResult(result: RenderToolResult): void {
    this.result = result;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  /** Nest a subagent-produced component under this tool. */
  addSubagentChild(component: Component): void {
    this.subagentContainer.addChild(component);
  }

  override invalidate(): void {
    super.invalidate();
    this.subagentContainer.invalidate();
  }

  protected cacheKey(): readonly unknown[] {
    return [this.expanded, this.result];
  }

  protected computeLines(width: number): string[] {
    return ["", ...this.headerLines(width), ...this.bodyLines(width)];
  }

  /** Subagent lines are appended live, outside the cache: a streaming
   *  subagent mutates subagentContainer without notifying this component
   *  (its children are themselves caching components). */
  override render(width: number): string[] {
    const ownLines = super.render(width);
    if (this.subagentContainer.children.length === 0) {
      return ownLines;
    }
    if (!this.expanded) {
      return [...ownLines, claudeStyle.grey(`  ${EXPAND_HINT}`)];
    }
    return [
      ...ownLines,
      ...this.subagentContainer
        .render(Math.max(1, width - 2))
        .map((line) => `  ${line}`),
    ];
  }

  private headerLines(width: number): string[] {
    const name = this.view?.displayName ?? this.toolName;
    const bulletColor =
      this.result === undefined
        ? claudeStyle.grey
        : this.result.isError
          ? claudeStyle.error
          : claudeStyle.success;
    const prefix = `${bulletColor("●")} ${claudeStyle.bold(name)}`;
    const arg = this.view?.headerArg(this.args, this.cwd);
    if (arg === undefined) {
      return [prefix];
    }
    // "● " + name + "(" columns; the styled prefix hides its escape codes.
    const prefixWidth = 2 + name.length + 1;
    const wrapped = wrapHeaderArg(
      `${arg})`,
      width - prefixWidth,
      width - HEADER_CONTINUATION_INDENT,
      HEADER_MAX_LINES,
    );
    // OSC 8 file link around the arg, like claude — only when the arg fits
    // untouched on a single line (wrapHeaderArg's width math and the "…)"
    // truncation slice both assume no escape bytes in the line). The wire
    // payload is untrusted: a non-absolute target or control bytes in the
    // displayed arg (which would land inside the link text) fall back to
    // plain rendering.
    const linkPath = this.view?.headerLink?.(this.args);
    if (
      linkPath !== undefined &&
      isAbsolute(linkPath) &&
      getCapabilities().hyperlinks &&
      !wrapped.truncated &&
      wrapped.lines.length === 1 &&
      wrapped.lines[0] === `${arg})` &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f-\u009f]/u.test(arg)
    ) {
      return [`${prefix}(${hyperlink(arg, pathToFileURL(linkPath).href)})`];
    }
    const lines = wrapped.lines.map((line, index) =>
      index === 0
        ? `${prefix}(${line}`
        : `${" ".repeat(HEADER_CONTINUATION_INDENT)}${line}`,
    );
    if (wrapped.truncated) {
      // Truncation implies the max-line count was reached, so the last line
      // is always an unstyled continuation line — safe to slice by chars.
      const last = lines.length - 1;
      lines[last] = `${lines[last]!.slice(0, Math.max(0, width - 2))}…)`;
    }
    return lines;
  }

  private bodyLines(width: number): string[] {
    if (this.result === undefined) {
      return this.expanded ? resultBlockLines(this.argsJson(), width) : [];
    }
    const resultBody = this.view?.resultBody?.(this.args, this.result);
    const bodyLines =
      resultBody === undefined ? [] : hangingBlockLines(resultBody, width);
    if (this.expanded) {
      return [
        ...resultBlockLines(
          `${this.argsJson()}\n\n${this.result.content.trim()}`,
          width,
        ),
        ...bodyLines,
      ];
    }
    const color = this.result.isError ? claudeStyle.error : undefined;
    const summary = this.view?.resultSummary(this.args, this.result, this.cwd);
    if (summary !== undefined) {
      return [...resultBlockLines(summary, width, color), ...bodyLines];
    }
    return [
      ...collapsedOutputLines(this.result.content.trim(), width, color),
      ...bodyLines,
    ];
  }

  private argsJson(): string {
    return JSON.stringify(this.args, null, 2) ?? "";
  }
}

/** Collapsed ⎿-output: the first 3 visual lines of the content, then a dim
 *  "… +N lines (ctrl+o to expand)". Shared with the local-command blocks. */
export function collapsedOutputLines(
  content: string,
  width: number,
  color?: (text: string) => string,
): string[] {
  const capacity = Math.max(1, width - RESULT_CONTINUATION_INDENT);
  const { visualLines } = truncateToVisualLines(
    content,
    Number.MAX_SAFE_INTEGER,
    capacity,
    0,
  );
  const shown = visualLines.slice(0, COLLAPSED_RESULT_VISUAL_LINES);
  const hidden = visualLines.length - shown.length;
  const lines = prefixed(shown, color);
  if (hidden > 0) {
    lines.push(
      " ".repeat(RESULT_CONTINUATION_INDENT) +
        claudeStyle.dim(`… +${hidden} lines ${EXPAND_HINT}`),
    );
  }
  return lines;
}

/** A full ⎿-block: text wrapped to the result capacity, first line after
 *  the grey "  ⎿ " prefix, the rest hanging at the same indent. */
export function resultBlockLines(
  text: string,
  width: number,
  color?: (text: string) => string,
): string[] {
  const capacity = Math.max(1, width - RESULT_CONTINUATION_INDENT);
  const { visualLines } = truncateToVisualLines(
    text,
    Number.MAX_SAFE_INTEGER,
    capacity,
    0,
  );
  return prefixed(visualLines, color);
}

/** A resultBody block: wrapped like a ⎿-block but with no ⎿ prefix — every
 *  line hangs at the result indent (claude's diff placement). */
function hangingBlockLines(text: string, width: number): string[] {
  const capacity = Math.max(1, width - RESULT_CONTINUATION_INDENT);
  const { visualLines } = truncateToVisualLines(
    text,
    Number.MAX_SAFE_INTEGER,
    capacity,
    0,
  );
  return visualLines.map(
    (line) => " ".repeat(RESULT_CONTINUATION_INDENT) + line,
  );
}

function prefixed(
  lines: string[],
  color: ((text: string) => string) | undefined,
): string[] {
  if (lines.length === 0) {
    lines = [""];
  }
  return lines.map((line, index) => {
    const colored = color === undefined ? line : color(line);
    return index === 0
      ? claudeStyle.grey(RESULT_PREFIX) + colored
      : " ".repeat(RESULT_CONTINUATION_INDENT) + colored;
  });
}
