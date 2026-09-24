// pi-inspired (formerly a verbatim port of pi coding-agent's
// tool-execution.ts; taken out of scripts/update-ports.sh when it stopped
// tracking pi's layout). Renders claude 2.1.211's transcript layout —
//
//   ▸ Name(arg)                header wrapped to ≤2 lines, "…)" truncated
//     ⤷  summary               the tool view's collapsed text
//
// or, for a call with a description (Bash), the description in the header
// and the arg as one truncated line beneath it —
//
//   ▸ Bash(description)
//         command
//     ⤷  N lines (ctrl+o to expand)
//
// with colors/formats captured by scripts/tui-parity/ (claude-derived:
// update against fresh captures on claude version bumps), except the
// glyphs (claude draws `●` and `⎿ `+nbsp; ours come from glyphs.ts so the
// transcript and the session tree agree), the two-line Bash header and
// the collapse rule — decided divergences, see docs/specs/
// tree-presentation.md and docs/specs/tui-rendering-parity.md. A view's
// resultBody (the Edit diff) hangs beneath the ⤷ block in both toggle
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
import { oneLinePrefix, truncateText } from "../../core/generated/text.ts";
import { ANSI_STYLE, PLAIN_STYLE, type Style } from "../../format/style.ts";
import type { RenderToolResult } from "../../format/render-types.ts";
import {
  TOOL_CALL_GLYPH,
  TOOL_RESULT_ERROR_GLYPH,
  TOOL_RESULT_GLYPH,
} from "../../format/glyphs.ts";
import { CachedLinesComponent } from "./cached-lines.ts";
import {
  toolViewFor,
  type ToolView,
  type ToolViewContext,
} from "../../format/entry-view/index.ts";

const HEADER_MAX_LINES = 2;
/** Continuation indent of a wrapped header ("▸ Bash(…" second line) and
 *  of the arg line under a description header. */
const HEADER_CONTINUATION_INDENT = 6;
/** Result lines after the first hang under the summary text, past the
 *  RESULT_PREFIX columns. */
const RESULT_CONTINUATION_INDENT = 5;
// TODO: whoa, the expand hint is not tied to the keyboard shortcut. We'll have to fix that.
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
  private readonly context: ToolViewContext;
  private readonly view: ToolView<unknown>;
  private expanded = false;
  private result?: RenderToolResult;

  constructor(toolName: string, args: unknown, cwd: string | undefined) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.context = { cwd, style: ANSI_STYLE };
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

  /** Nest `component` ahead of `sibling` (a finalized block ahead of the
   *  stream still rendering the rest of its message); appended when
   *  `sibling` is not nested here. */
  addSubagentChildBefore(component: Component, sibling: Component): void {
    const index = this.subagentContainer.children.indexOf(sibling);
    if (index === -1) {
      this.subagentContainer.addChild(component);
    } else {
      this.subagentContainer.children.splice(index, 0, component);
    }
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
      return [...ownLines, ANSI_STYLE.grey(`  ${EXPAND_HINT}`)];
    }
    return [
      ...ownLines,
      ...this.subagentContainer
        .render(Math.max(1, width - 2))
        .map((line) => `  ${line}`),
    ];
  }

  private headerLines(width: number): string[] {
    const header = this.view.header(this.args, this.context);
    if (header.description !== undefined) {
      const lines = this.wrappedHeaderLines(header.description, width).lines;
      if (header.arg !== undefined) {
        const argCapacity = Math.max(0, width - HEADER_CONTINUATION_INDENT);
        lines.push(
          " ".repeat(HEADER_CONTINUATION_INDENT) +
            truncateText(oneLinePrefix(header.arg, argCapacity), argCapacity),
        );
      }
      return lines;
    }
    const arg = header.arg;
    if (arg === undefined) {
      return [this.headerPrefix(ANSI_STYLE)];
    }
    const wrapped = this.wrappedHeaderLines(arg, width);
    // OSC 8 file link around the arg, like claude — only when the arg fits
    // untouched on a single line (wrapHeaderArg's width math and the "…)"
    // truncation slice both assume no escape bytes in the line). The wire
    // payload is untrusted: a non-absolute target or control bytes in the
    // displayed arg (which would land inside the link text) fall back to
    // plain rendering.
    const linkPath = this.view.headerLink?.(this.args);
    // eslint-disable-next-line no-control-regex
    const argHasControlChars = /[\u0000-\u001f\u007f-\u009f]/u.test(arg);
    if (
      linkPath !== undefined &&
      isAbsolute(linkPath) &&
      getCapabilities().hyperlinks &&
      wrapped.fitsOnOneLine &&
      !argHasControlChars
    ) {
      return [
        `${this.headerPrefix(ANSI_STYLE)}(${hyperlink(arg, pathToFileURL(linkPath).href)})`,
      ];
    }
    return wrapped.lines;
  }

  /** `▸ Name`: the glyph in the result state's color (pending grey), the
   *  name bold; `PLAIN_STYLE` gives the width the styled prefix occupies. */
  private headerPrefix(style: Style): string {
    const glyphColor =
      this.result === undefined
        ? style.grey
        : this.result.isError
          ? style.error
          : style.success;
    return `${glyphColor(TOOL_CALL_GLYPH)} ${style.bold(this.view.displayName ?? this.toolName)}`;
  }

  /** `▸ Name(text)` wrapped to HEADER_MAX_LINES, "…)"-truncated past
   *  them; `fitsOnOneLine` when `(text)` came through untouched. */
  private wrappedHeaderLines(
    text: string,
    width: number,
  ): { lines: string[]; fitsOnOneLine: boolean } {
    const prefixWidth = this.headerPrefix(PLAIN_STYLE).length;
    const wrapped = wrapHeaderArg(
      `(${text})`,
      width - prefixWidth,
      width - HEADER_CONTINUATION_INDENT,
      HEADER_MAX_LINES,
    );
    // A single untruncated line is the input unchanged: the leading "("
    // keeps the first word non-empty, so wrapHeaderArg rejoins every
    // following word (empty ones included) with the space it split on.
    const fitsOnOneLine = !wrapped.truncated && wrapped.lines.length === 1;
    const lines = wrapped.lines.map((line, index) =>
      index === 0
        ? `${this.headerPrefix(ANSI_STYLE)}${line}`
        : `${" ".repeat(HEADER_CONTINUATION_INDENT)}${line}`,
    );
    if (wrapped.truncated) {
      // Truncation implies the max-line count was reached, so the last line
      // is always an unstyled continuation line — safe to slice by chars.
      const last = lines.length - 1;
      lines[last] = `${lines[last]!.slice(0, Math.max(0, width - 2))}…)`;
    }
    return { lines, fitsOnOneLine };
  }

  private bodyLines(width: number): string[] {
    if (this.result === undefined) {
      return this.expanded
        ? resultBlockLines(this.argsJson(), width, RESULT_BLOCK_STYLE)
        : [];
    }
    const resultBody = this.view.resultBody?.(
      this.args,
      this.result,
      this.context,
    );
    const bodyLines =
      resultBody === undefined
        ? []
        : resultBlockLines(resultBody, width, undefined);
    if (this.expanded) {
      return [
        ...resultBlockLines(
          `${this.argsJson()}\n\n${this.result.content.trim()}`,
          width,
          RESULT_BLOCK_STYLE,
        ),
        ...bodyLines,
      ];
    }
    const summary = this.view.resultSummary(
      this.args,
      this.result,
      this.context,
    );
    const style = this.result.isError
      ? ERROR_RESULT_BLOCK_STYLE
      : RESULT_BLOCK_STYLE;
    return [...resultBlockLines(summary, width, style), ...bodyLines];
  }

  private argsJson(): string {
    return JSON.stringify(this.args, null, 2) ?? "";
  }
}

type TextStyle = (text: string) => string;

/** How a ⤷-block is drawn: its glyph, the glyph's color, the text's. */
export interface ResultBlockStyle {
  readonly glyph: string;
  readonly glyphColor: TextStyle;
  readonly textColor: TextStyle;
}

/** Claude's result block: grey `⤷`, the text in the terminal's default. */
export const RESULT_BLOCK_STYLE: ResultBlockStyle = {
  glyph: TOOL_RESULT_GLYPH,
  glyphColor: ANSI_STYLE.grey,
  textColor: (text) => text,
};

/** Claude's failed-result block: `✗` and the summary both in error red. */
export const ERROR_RESULT_BLOCK_STYLE: ResultBlockStyle = {
  glyph: TOOL_RESULT_ERROR_GLYPH,
  glyphColor: ANSI_STYLE.error,
  textColor: ANSI_STYLE.error,
};

/** A ⤷-block: `text` wrapped to the result capacity, the first line after
 *  the `  ⤷  ` prefix (an empty text still shows it), the rest hanging at
 *  RESULT_CONTINUATION_INDENT. An undefined style draws no glyph — every
 *  line hangs, claude's placement of a resultBody diff. Shared with the
 *  local-command blocks. */
export function resultBlockLines(
  text: string,
  width: number,
  style: ResultBlockStyle | undefined,
): string[] {
  const capacity = Math.max(1, width - RESULT_CONTINUATION_INDENT);
  const { visualLines } = truncateToVisualLines(
    text,
    Number.MAX_SAFE_INTEGER,
    capacity,
    0,
  );
  const indent = " ".repeat(RESULT_CONTINUATION_INDENT);
  if (style === undefined) {
    return visualLines.map((line) => indent + line);
  }
  const lines = visualLines.length === 0 ? [""] : visualLines;
  return lines.map((line, index) =>
    index === 0
      ? style.glyphColor(`  ${style.glyph}  `) + style.textColor(line)
      : indent + style.textColor(line),
  );
}
