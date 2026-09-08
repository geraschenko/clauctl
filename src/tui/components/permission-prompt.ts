/**
 * The permission dialog that replaces the editor while an ask is pending
 * (docs/specs/permission-prompt.md, "Dialog layout"). Rows mode: digits,
 * tui.select.up/down, confirm, cancel (`cancelDecision`), Tab (amend). Amend
 * mode: a pi-tui Input whose Enter sends an amended deny and whose Esc
 * returns to the rows. Knows nothing about tools: it renders a
 * PermissionDialog and reports a PermissionResult.
 */

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import {
  Container,
  getKeybindings,
  Input,
  Markdown,
  matchesKey,
  type Focusable,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { PermissionDialog } from "../permission-dialog.ts";
import { DASHED_RULE } from "../permission-views.ts";
import { getMarkdownTheme, theme } from "../theme.ts";

const BODY_INDENT = "   ";

export class PermissionPromptComponent extends Container implements Focusable {
  focused = false;
  readonly dialog: PermissionDialog;
  /** All pending asks including this one; the title shows `(+N more)`. */
  pendingCount: number;
  private readonly onDecide: (decision: PermissionResult) => void;
  private selected: number;
  private amendInput: Input | undefined;

  constructor(
    dialog: PermissionDialog,
    pendingCount: number,
    onDecide: (decision: PermissionResult) => void,
  ) {
    super();
    this.dialog = dialog;
    this.pendingCount = pendingCount;
    this.onDecide = onDecide;
    this.selected = dialog.defaultToNo ? dialog.rows.length - 1 : 0;
  }

  private openAmend(): void {
    const input = new Input();
    input.onSubmit = (message) => this.onDecide({ behavior: "deny", message });
    input.onEscape = () => {
      this.amendInput = undefined;
    };
    this.amendInput = input;
  }

  private confirm(): void {
    const row = this.dialog.rows[this.selected];
    if (row === undefined) return;
    if (row.action.kind === "amend") {
      this.openAmend();
    } else {
      this.onDecide(row.action.decision);
    }
  }

  handleInput(data: string): void {
    if (this.amendInput !== undefined) {
      this.amendInput.handleInput(data);
      return;
    }
    const keybindings = getKeybindings();
    const digit =
      /^[1-9]$/.test(data) && !this.dialog.defaultToNo
        ? Number(data) - 1
        : undefined;
    if (digit !== undefined && digit < this.dialog.rows.length) {
      this.selected = digit;
      this.confirm();
    } else if (keybindings.matches(data, "tui.select.up")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (keybindings.matches(data, "tui.select.down")) {
      this.selected = Math.min(this.dialog.rows.length - 1, this.selected + 1);
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      this.confirm();
    } else if (keybindings.matches(data, "tui.select.cancel")) {
      this.onDecide(this.dialog.cancelDecision);
    } else if (matchesKey(data, "tab") && this.dialog.tabAmends) {
      this.openAmend();
    }
  }

  override render(width: number): string[] {
    const { dialog } = this;
    const more =
      this.pendingCount > 1 ? ` (+${this.pendingCount - 1} more)` : "";
    const lines = [
      theme.fg("dim", "─".repeat(width)),
      ...wrapIndented(
        `${theme.bold(dialog.title)}${theme.fg("dim", more)}`,
        width,
        " ",
        " ",
      ),
      "",
      ...dialog.body.flatMap((line) =>
        typeof line !== "string"
          ? new Markdown(line.markdown, 0, 0, getMarkdownTheme())
              .render(width - BODY_INDENT.length)
              .map((rendered) => `${BODY_INDENT}${rendered}`)
          : line === DASHED_RULE
            ? [theme.fg("dim", DASHED_RULE.repeat(width))]
            : wrapIndented(line, width, BODY_INDENT, BODY_INDENT),
      ),
      "",
      ...wrapIndented(dialog.question, width, " ", " "),
    ];
    if (this.amendInput !== undefined) {
      this.amendInput.focused = this.focused;
      lines.push(
        ...this.amendInput.render(width),
        theme.fg("dim", " Enter to send · Esc back to the options"),
      );
      return lines;
    }
    dialog.rows.forEach((row, index) => {
      const selected = index === this.selected;
      const wrapped = wrapIndented(
        `${index + 1}. ${row.label}`,
        width,
        selected ? " ❯ " : "   ",
        "      ",
      );
      lines.push(
        ...(selected
          ? wrapped.map((line) => theme.fg("accent", line))
          : wrapped),
      );
    });
    const hint = dialog.tabAmends
      ? "Esc to cancel · Tab to amend"
      : dialog.planFilePath === undefined
        ? undefined
        : "Esc to cancel · ctrl+g to edit the plan";
    if (hint !== undefined) {
      lines.push("", theme.fg("dim", ` ${hint}`));
    }
    return lines;
  }
}

/** Wrap `text` so the first line fits after `firstPrefix` and later lines
 *  (wrapped overflow and `text`'s own newlines) after `restPrefix`. */
function wrapIndented(
  text: string,
  width: number,
  firstPrefix: string,
  restPrefix: string,
): string[] {
  const [firstParagraph = "", ...paragraphs] = text.split("\n");
  const [first = "", ...overflow] = wrapTextWithAnsi(
    firstParagraph,
    width - firstPrefix.length,
  );
  const restWidth = width - restPrefix.length;
  const rest = [
    ...(overflow.length === 0
      ? []
      : wrapTextWithAnsi(overflow.join(" "), restWidth)),
    ...paragraphs.flatMap((paragraph) =>
      wrapTextWithAnsi(paragraph, restWidth),
    ),
  ];
  return [
    `${firstPrefix}${first}`,
    ...rest.map((line) => `${restPrefix}${line}`),
  ];
}
