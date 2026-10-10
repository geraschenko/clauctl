/**
 * The permission dialog that replaces the editor while an ask is pending
 * (docs/specs/permission-prompt.md, "Dialog layout"). Rows mode: digits,
 * tui.select.up/down, confirm, cancel (`cancelDecision`), app.permission.amend.
 * Amend mode: a pi-tui Input whose Enter sends, on an allow row, that allow
 * with the text as feedback, and on any other row an amended deny; its Esc
 * returns to the rows, and app.editor.external edits its text (docs/specs/permission-amend-allow.md). Knows nothing about tools: it renders a
 * PermissionDialog and reports a PermissionResult.
 */

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import {
  Container,
  getKeybindings,
  Input,
  Markdown,
  type Focusable,
  type Keybinding,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  feedbackDenial,
  type PermissionDialog,
  type PermissionRow,
} from "../permission-dialog.ts";
import { keyHints } from "../keybindings.ts";
import { DASHED_RULE } from "../permission-views.ts";
import { getMarkdownTheme, theme } from "../theme.ts";

const BODY_INDENT = "   ";

/** What the permission prompt can do beyond rendering its dialog. */
export interface PermissionPromptActions {
  decide(decision: PermissionResult, feedback?: string): void;
  editText(text: string): Promise<string | undefined>;
  /** ctrl+g on the ExitPlanMode dialog: edit the plan file. */
  editPlan(planFilePath: string): void;
  interrupt(): void;
}

export class PermissionPromptComponent extends Container implements Focusable {
  focused = false;
  private readonly dialog: PermissionDialog;
  /** All pending asks including this one; the title shows `(+N more)`. */
  pendingCount: number;
  private readonly actions: PermissionPromptActions;
  private selected: number;
  private amendInput: Input | undefined;

  constructor(
    dialog: PermissionDialog,
    pendingCount: number,
    actions: PermissionPromptActions,
  ) {
    super();
    this.dialog = dialog;
    this.pendingCount = pendingCount;
    this.actions = actions;
    this.selected = dialog.defaultToNo ? dialog.rows.length - 1 : 0;
  }

  /** `row` is the focused row (Tab) or the plan dialog's amend row. */
  private openAmend(row: PermissionRow): void {
    const input = new Input();
    input.onSubmit = (text) => {
      if (
        row.action.kind === "decide" &&
        row.action.decision.behavior === "allow"
      ) {
        if (text.length === 0) {
          this.actions.decide(row.action.decision);
        } else {
          this.actions.decide(row.action.decision, text);
        }
      } else {
        this.actions.decide(feedbackDenial(text));
      }
    };
    input.onEscape = () => {
      this.amendInput = undefined;
    };
    this.amendInput = input;
  }

  private confirm(): void {
    const row = this.dialog.rows[this.selected];
    if (row === undefined) return;
    if (row.action.kind === "amend") {
      this.openAmend(row);
    } else {
      this.actions.decide(row.action.decision);
    }
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    const amendInput = this.amendInput;
    if (amendInput !== undefined) {
      if (keybindings.matches(data, "app.editor.external")) {
        void this.actions.editText(amendInput.getValue()).then((edited) => {
          if (edited !== undefined) amendInput.setValue(edited);
        });
      } else {
        amendInput.handleInput(data);
      }
      return;
    }
    if (keybindings.matches(data, "app.interrupt")) {
      this.actions.interrupt();
      return;
    }
    if (
      keybindings.matches(data, "app.editor.external") &&
      this.dialog.planFilePath !== undefined
    ) {
      this.actions.editPlan(this.dialog.planFilePath);
      return;
    }
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
      this.actions.decide(this.dialog.cancelDecision);
    } else if (
      keybindings.matches(data, "app.permission.amend") &&
      this.dialog.tabAmends
    ) {
      const row = this.dialog.rows[this.selected];
      if (row !== undefined) this.openAmend(row);
    }
  }

  override render(width: number): string[] {
    const { dialog } = this;
    const keybindings = getKeybindings();
    const hint = (
      segments: ReadonlyArray<readonly [Keybinding, string]>,
    ): string => keyHints(keybindings, segments).join(" · ");
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
        theme.fg(
          "dim",
          ` ${hint([
            ["tui.input.submit", "to send"],
            ["tui.select.cancel", "back to the options"],
            ["app.editor.external", "to edit in your editor"],
          ])}`,
        ),
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
    const rowsHint = dialog.tabAmends
      ? hint([
          ["tui.select.cancel", "to cancel"],
          ["app.permission.amend", "to amend"],
        ])
      : dialog.planFilePath === undefined
        ? undefined
        : hint([
            ["tui.select.cancel", "to cancel"],
            ["app.editor.external", "to edit the plan"],
          ]);
    if (rowsHint !== undefined) {
      lines.push("", theme.fg("dim", ` ${rowsHint}`));
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
