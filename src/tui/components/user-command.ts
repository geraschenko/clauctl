// Custom, claude-2.1.211-style local-command block (parity spec, phase 5):
//
//   ❯ /login                       (or `❯ ! cmd` for bash passthrough)
//     ⎿  Login successful          captured output, collapsed like a tool
//        … +N lines (ctrl+o to expand)
//
// The command line reuses the user prompt's ❯ band; the output block reuses
// the tool components' ⎿ formatting and the same ctrl+o expansion. A
// standalone output (no preceding command in the transcript) renders as a
// bare ⎿ block.

import { CachedLinesComponent } from "./cached-lines.ts";
import { collapsedOutputLines, resultBlockLines } from "./tool-execution.ts";
import { userPromptLines } from "./user-message.ts";

export class UserCommandComponent extends CachedLinesComponent {
  private readonly commandLine: string | undefined;
  private output: string | undefined;
  private expanded = false;

  /** `commandLine` is the full display line after the gutter (`/name args`
   *  or `! cmd`); undefined renders a standalone output block. */
  constructor(commandLine: string | undefined) {
    super();
    this.commandLine = commandLine;
  }

  setOutput(text: string): void {
    this.output = text;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  protected cacheKey(): readonly unknown[] {
    return [this.output, this.expanded];
  }

  protected computeLines(width: number): string[] {
    const lines = [""];
    if (this.commandLine !== undefined) {
      lines.push(...userPromptLines(this.commandLine, width));
    }
    if (this.output !== undefined) {
      const content = this.output.trim();
      lines.push(
        ...(this.expanded
          ? resultBlockLines(content, width)
          : collapsedOutputLines(content, width)),
      );
    }
    return lines;
  }
}
