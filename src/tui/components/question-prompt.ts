/**
 * The AskUserQuestion dialog that replaces the editor while such an ask is
 * pending (docs/specs/ask-user-question.md, Behaviours 1–6). Holds the
 * answers in progress and reports a PermissionResult; the decisions
 * themselves are question-dialog.ts's pure functions.
 */

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import {
  Container,
  getKeybindings,
  Input,
  Markdown,
  type Focusable,
  type Keybinding,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { CANCEL_DENY } from "../permission-dialog.ts";
import {
  answerText,
  chatDecision,
  EMPTY_ANSWER,
  type QuestionAnswer,
  submitDecision,
  usesPreviewLayout,
} from "../question-dialog.ts";
import { keyHints, keyLabel } from "../keybindings.ts";
import { getMarkdownTheme, theme } from "../theme.ts";

type Question = AskUserQuestionInput["questions"][number];

/** A selectable row: the rows native claude's dialog shows, as captured
 *  by the `askuser*` scenarios in scripts/tui-parity/dialog-scenarios.ts;
 *  a new row there means a new kind here. `next` is multi-select's
 *  unnumbered Submit row. */
type Row =
  | { kind: "option"; index: number }
  | { kind: "other" }
  | { kind: "next" }
  | { kind: "chat" }
  | { kind: "submit" }
  | { kind: "cancel" };

type Mode = "select" | "notes";

/** Blank columns between the preview pane's border and its text, per side. */
const PREVIEW_PANE_PADDING = 1;
/** The pane's columns besides its text: the box-drawing border characters
 *  are one column each. */
const PREVIEW_PANE_FRAME_WIDTH = 2 * (1 + PREVIEW_PANE_PADDING);

/** The free-text row's text before anything is typed. Native drops the
 *  period on multi-select questions; we use one wording throughout. */
const FREE_TEXT_PLACEHOLDER = "Type something.";

function noPreviewBody(): string[] {
  return [theme.fg("dim", "No preview available")];
}

export class QuestionPromptComponent extends Container implements Focusable {
  focused = false;
  /** All pending asks including this one; the title shows `(+N more)`. */
  pendingCount: number;
  private readonly askInput: AskUserQuestionInput;
  private readonly titleSuffix: string | undefined;
  private readonly onDecide: (decision: PermissionResult) => void;
  private readonly editText: (text: string) => Promise<string | undefined>;
  private readonly answers: QuestionAnswer[];
  /** The tab shown: a question index, or `questions.length` for the
   *  Submit tab. */
  private activeQuestionIndex = 0;
  /** Index into `rows()`. */
  private focusedRowIndex = 0;
  private mode: Mode = "select";
  /** Per question, so each keeps its own text cursor across tab switches. */
  private readonly otherInputs: Input[];
  private readonly notesInputs: Input[];
  /** `previewBodies` per `${activeQuestionIndex}:${maxBodyWidth}`. */
  private readonly previewCache = new Map<string, string[][]>();

  constructor(
    input: AskUserQuestionInput,
    titleSuffix: string | undefined,
    pendingCount: number,
    onDecide: (decision: PermissionResult) => void,
    editText: (text: string) => Promise<string | undefined>,
  ) {
    super();
    this.askInput = input;
    this.titleSuffix = titleSuffix;
    this.pendingCount = pendingCount;
    this.onDecide = onDecide;
    this.editText = editText;
    this.answers = input.questions.map(() => EMPTY_ANSWER);
    this.otherInputs = input.questions.map(() => {
      const otherInput = new Input({
        prompt: "",
        placeholder: FREE_TEXT_PLACEHOLDER,
      });
      otherInput.onSubmit = () => this.act({ kind: "other" });
      return otherInput;
    });
    this.notesInputs = input.questions.map(() => {
      const notesInput = new Input({ prompt: "" });
      notesInput.onSubmit = () => this.submitNotes();
      notesInput.onEscape = () => {
        this.mode = "select";
      };
      return notesInput;
    });
  }

  /** The current question's inputs; read on question tabs only. */
  private get otherInput(): Input {
    return this.otherInputs[this.activeQuestionIndex]!;
  }

  private get notesInput(): Input {
    return this.notesInputs[this.activeQuestionIndex]!;
  }

  /** Esc belongs to the dialog (it leaves the notes input), not to the
   *  global interrupt. */
  get capturesEscape(): boolean {
    return this.mode === "notes";
  }

  /** The active tab's question; undefined on the Submit tab. */
  private get question(): Question | undefined {
    return this.askInput.questions[this.activeQuestionIndex];
  }

  private get hasTabs(): boolean {
    return this.askInput.questions.length > 1;
  }

  private rows(): Row[] {
    const question = this.question;
    if (question === undefined) {
      return [{ kind: "submit" }, { kind: "cancel" }];
    }
    const options: Row[] = question.options.map((_, index) => ({
      kind: "option",
      index,
    }));
    if (usesPreviewLayout(question)) {
      return [...options, { kind: "chat" }];
    }
    return [
      ...options,
      { kind: "other" },
      ...(question.multiSelect ? [{ kind: "next" } as const] : []),
      { kind: "chat" },
    ];
  }

  /** The digit shortcut for a row; `next`, and the preview layout's
   *  chat row, have none. */
  private rowNumber(rows: readonly Row[], row: Row): number | undefined {
    const question = this.question;
    const unnumbered = (candidate: Row): boolean =>
      candidate.kind === "next" ||
      (candidate.kind === "chat" &&
        question !== undefined &&
        usesPreviewLayout(question));
    if (unnumbered(row)) return undefined;
    return rows.filter((candidate) => !unnumbered(candidate)).indexOf(row) + 1;
  }

  private setAnswer(
    questionIndex: number,
    update: Partial<QuestionAnswer>,
  ): void {
    this.answers[questionIndex] = {
      ...this.answers[questionIndex]!,
      ...update,
    };
  }

  /** The free-text answer follows its input's text; on multi-select,
   *  nonempty text selects it. */
  private syncOtherAnswer(questionIndex: number): void {
    const otherText = this.otherInputs[questionIndex]!.getValue();
    this.setAnswer(questionIndex, {
      otherText,
      ...(this.askInput.questions[questionIndex]?.multiSelect
        ? { otherSelected: otherText !== "" }
        : {}),
    });
  }

  private syncNotesAnswer(questionIndex: number): void {
    this.setAnswer(questionIndex, {
      notes: this.notesInputs[questionIndex]!.getValue(),
    });
  }

  private switchTab(tab: number): void {
    const last = this.askInput.questions.length;
    this.activeQuestionIndex = Math.max(0, Math.min(last, tab));
    this.focusedRowIndex = 0;
  }

  /** After a question is answered: the next tab, or the decision itself
   *  when there is only one question. */
  private advance(): void {
    if (this.hasTabs) {
      this.switchTab(this.activeQuestionIndex + 1);
    } else {
      this.onDecide(submitDecision(this.askInput, this.answers));
    }
  }

  private act(row: Row): void {
    const question = this.question;
    const answer = this.answers[this.activeQuestionIndex];
    switch (row.kind) {
      case "option":
        if (question?.multiSelect && answer !== undefined) {
          const selected = answer.selected.includes(row.index)
            ? answer.selected.filter((index) => index !== row.index)
            : [...answer.selected, row.index];
          this.setAnswer(this.activeQuestionIndex, { selected });
        } else {
          this.setAnswer(this.activeQuestionIndex, {
            selected: [row.index],
            otherSelected: false,
          });
          this.advance();
        }
        return;
      case "other":
        if (answer === undefined || answer.otherText === "") return;
        if (question?.multiSelect) {
          this.setAnswer(this.activeQuestionIndex, {
            otherSelected: !answer.otherSelected,
          });
        } else {
          this.setAnswer(this.activeQuestionIndex, {
            selected: [],
            otherSelected: true,
          });
          this.advance();
        }
        return;
      case "next":
        this.advance();
        return;
      case "chat":
        this.onDecide(chatDecision(this.askInput, this.answers));
        return;
      case "submit":
        this.onDecide(submitDecision(this.askInput, this.answers));
        return;
      case "cancel":
        this.onDecide(CANCEL_DENY);
        return;
    }
  }

  /** Replace `input`'s text with the external editor's result, then
   *  `sync` the answer from it. */
  private async editExternally(input: Input, sync: () => void): Promise<void> {
    const edited = await this.editText(input.getValue());
    if (edited !== undefined) {
      input.setValue(edited);
      sync();
    }
  }

  /** Forward a key to a text input; `sync` the answer only when the text
   *  changed, so a submit fired by the key keeps what it decided. */
  private forwardToInput(input: Input, data: string, sync: () => void): void {
    const before = input.getValue();
    input.handleInput(data);
    if (input.getValue() !== before) sync();
  }

  /** Enter in notes mode: native answers with the focused option, as Enter
   *  in selection mode does (session d69ee703…'s "Beta" retry). */
  private submitNotes(): void {
    this.mode = "select";
    const row = this.rows()[this.focusedRowIndex];
    if (row?.kind === "option") {
      this.act(row);
    } else {
      this.advance();
    }
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    const questionIndex = this.activeQuestionIndex;
    if (this.mode === "notes") {
      const notesInput = this.notesInput;
      const sync = (): void => this.syncNotesAnswer(questionIndex);
      if (keybindings.matches(data, "app.editor.external")) {
        void this.editExternally(notesInput, sync);
      } else {
        this.forwardToInput(notesInput, data, sync);
      }
      return;
    }
    const question = this.question;
    const rows = this.rows();
    const row = rows[this.focusedRowIndex];
    if (keybindings.matches(data, "tui.select.cancel")) {
      this.onDecide(CANCEL_DENY);
    } else if (keybindings.matches(data, "tui.select.up")) {
      this.focusedRowIndex = Math.max(0, this.focusedRowIndex - 1);
    } else if (keybindings.matches(data, "tui.select.down")) {
      this.focusedRowIndex = Math.min(
        rows.length - 1,
        this.focusedRowIndex + 1,
      );
    } else if (row?.kind === "other") {
      const otherInput = this.otherInput;
      const sync = (): void => this.syncOtherAnswer(questionIndex);
      if (keybindings.matches(data, "app.editor.external")) {
        void this.editExternally(otherInput, sync);
      } else {
        this.forwardToInput(otherInput, data, sync);
      }
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      if (row !== undefined) this.act(row);
    } else if (
      this.hasTabs &&
      keybindings.matches(data, "app.question.nextTab")
    ) {
      this.switchTab(this.activeQuestionIndex + 1);
    } else if (
      this.hasTabs &&
      keybindings.matches(data, "app.question.previousTab")
    ) {
      this.switchTab(this.activeQuestionIndex - 1);
    } else if (/^[1-9]$/.test(data)) {
      const target = rows.find(
        (candidate) => this.rowNumber(rows, candidate) === Number(data),
      );
      if (target !== undefined) {
        this.focusedRowIndex = rows.indexOf(target);
        this.act(target);
      }
    } else if (
      keybindings.matches(data, "app.question.toggle") &&
      row?.kind === "option" &&
      question?.multiSelect
    ) {
      this.act(row);
    } else if (
      keybindings.matches(data, "app.question.notes") &&
      question !== undefined &&
      usesPreviewLayout(question)
    ) {
      this.mode = "notes";
    }
  }

  override render(width: number): string[] {
    const more =
      this.pendingCount > 1 ? ` (+${this.pendingCount - 1} more)` : "";
    const suffix = theme.fg("dim", `${this.titleSuffix ?? ""}${more}`);
    const question = this.question;
    const lines = [
      theme.fg("dim", "─".repeat(width)),
      truncateToWidth(
        `${this.hasTabs ? this.tabBar() : ` ☐ ${question?.header ?? ""}`}${suffix}`,
        width,
      ),
      "",
    ];
    if (question === undefined) {
      lines.push(...this.reviewLines(width));
    } else {
      lines.push(...wrapTextWithAnsi(theme.bold(question.question), width), "");
      lines.push(
        ...(usesPreviewLayout(question)
          ? this.previewLayoutLines(question, width)
          : this.rowLines(width)),
      );
    }
    lines.push("", theme.fg("dim", this.hint(question)));
    return lines;
  }

  private tabBar(): string {
    const tabs = this.askInput.questions.map((question, index) => {
      const box =
        answerText(question, this.answers[index]!) === undefined ? "☐" : "☒";
      const label = `${box} ${question.header}`;
      return index === this.activeQuestionIndex ? theme.inverse(label) : label;
    });
    const submit = "✔ Submit";
    return `←  ${[
      ...tabs,
      this.activeQuestionIndex === this.askInput.questions.length
        ? theme.inverse(submit)
        : submit,
    ].join("  ")}  →`;
  }

  private reviewLines(width: number): string[] {
    let isAllAnswered = true;
    const answered = this.askInput.questions.flatMap((question, index) => {
      const text = answerText(question, this.answers[index]!);
      if (text === undefined) {
        isAllAnswered = false;
        return [];
      }
      return [
        ...wrapTextWithAnsi(` ● ${question.question}`, width),
        ...wrapTextWithAnsi(`   → ${text}`, width),
      ];
    });
    return [
      theme.bold("Review your answers"),
      "",
      // Native's wording (tui-parity scenario `askuser-submit-tab`).
      ...(isAllAnswered
        ? []
        : [theme.fg("warning", "⚠ You have not answered all questions"), ""]),
      ...answered,
      "",
      "Ready to submit your answers?",
      "",
      ...this.rowLines(width),
    ];
  }

  private rowLabel(row: Row): string {
    const question = this.question;
    const answer = this.answers[this.activeQuestionIndex] ?? EMPTY_ANSWER;
    const multi = question?.multiSelect === true;
    switch (row.kind) {
      case "option": {
        const label = question?.options[row.index]?.label ?? "";
        const chosen = answer.selected.includes(row.index);
        return multi
          ? `[${chosen ? "✔" : " "}] ${label}`
          : `${label}${chosen ? theme.fg("accent", " ✔") : ""}`;
      }
      case "other": {
        const text =
          answer.otherText === "" && question !== undefined
            ? FREE_TEXT_PLACEHOLDER
            : answer.otherText;
        return multi
          ? `[${answer.otherSelected ? "✔" : " "}] ${text}`
          : `${text}${answer.otherSelected ? theme.fg("accent", " ✔") : ""}`;
      }
      case "next":
        return "Submit";
      case "chat":
        return "Chat about this";
      case "submit":
        return "Submit answers";
      case "cancel":
        return "Cancel";
    }
  }

  /** The rows `include` admits, in order; the cursor indexes all rows. */
  private rowLines(
    width: number,
    include: (row: Row) => boolean = () => true,
  ): string[] {
    const rows = this.rows();
    const question = this.question;
    const showDescriptions =
      question !== undefined && !usesPreviewLayout(question);
    const description = (row: Row): string | undefined =>
      row.kind === "option" && showDescriptions
        ? question.options[row.index]?.description
        : undefined;
    return rows.flatMap((row, index) => {
      if (!include(row)) return [];
      const selected = index === this.focusedRowIndex;
      const number = this.rowNumber(rows, row);
      const head = `${selected ? "❯ " : "  "}${number === undefined ? "" : `${number}. `}`;
      let label = this.rowLabel(row);
      if (row.kind === "other" && selected) {
        const box = question?.multiSelect
          ? `[${this.answers[this.activeQuestionIndex]?.otherSelected ? "✔" : " "}] `
          : "";
        this.otherInput.focused = this.focused;
        const rendered = this.otherInput.render(
          Math.max(1, width - head.length - box.length),
        );
        label = `${box}${(rendered[0] ?? "").trimEnd()}`;
      }
      const line = truncateToWidth(`${head}${label}`, width);
      const detail = description(row);
      return [
        ...(row.kind === "chat" ? [theme.fg("dim", "─".repeat(width))] : []),
        selected ? theme.fg("accent", line) : line,
        ...(detail === undefined
          ? []
          : wrapTextWithAnsi(detail, width - 5).map((text) =>
              theme.fg("dim", `     ${text}`),
            )),
      ];
    });
  }

  private previewLayoutLines(question: Question, width: number): string[] {
    // Native claude's options column is a third of the width (34 at 100).
    const optionsColumnWidth = Math.ceil(width / 3);
    const optionsColumn = this.rowLines(
      optionsColumnWidth,
      (row) => row.kind !== "chat",
    );
    const previews = this.previewBodies(
      question,
      width - optionsColumnWidth - PREVIEW_PANE_FRAME_WIDTH,
    );
    // Sized to the widest preview, so the pane keeps its width as focus moves.
    const previewPaneWidth = Math.min(
      width - optionsColumnWidth,
      Math.max(...previews.flat().map(visibleWidth)) + PREVIEW_PANE_FRAME_WIDTH,
    );
    const row = this.rows()[this.focusedRowIndex];
    const preview =
      row?.kind === "option" ? previews[row.index] : noPreviewBody();
    const previewPane =
      previewPaneWidth < 8 || preview === undefined
        ? []
        : this.previewPane(preview, previewPaneWidth);
    const height = Math.max(optionsColumn.length, previewPane.length);
    const columns = Array.from({ length: height }, (_, index) => {
      const optionsColumnLine = optionsColumn[index] ?? "";
      const pad = " ".repeat(
        Math.max(0, optionsColumnWidth - visibleWidth(optionsColumnLine)),
      );
      return truncateToWidth(
        `${optionsColumnLine}${pad}${previewPane[index] ?? ""}`,
        width,
      );
    });
    const notes = this.answers[this.activeQuestionIndex]?.notes ?? "";
    let notesLine: string;
    if (this.mode === "notes") {
      this.notesInput.focused = this.focused;
      notesLine = `Notes: ${(this.notesInput.render(Math.max(1, previewPaneWidth - 7))[0] ?? "").trimEnd()}`;
    } else {
      const notesKey = keyLabel(getKeybindings(), "app.question.notes");
      const placeholder =
        notesKey === undefined
          ? "Notes:"
          : `Notes: press ${notesKey} to add notes`;
      notesLine = theme.fg(
        "dim",
        notes === "" ? placeholder : `Notes: ${notes}`,
      );
    }
    return [
      ...columns,
      "",
      truncateToWidth(`${" ".repeat(optionsColumnWidth)}${notesLine}`, width),
      "",
      ...this.rowLines(width, (row) => row.kind === "chat"),
    ];
  }

  /** Each option's preview body, wrapped to `maxBodyWidth`, without the
   *  trailing padding Markdown adds. */
  private previewBodies(question: Question, maxWidth: number): string[][] {
    const key = `${this.activeQuestionIndex}:${maxWidth}`;
    let previews = this.previewCache.get(key);
    if (previews === undefined) {
      previews = question.options.map(({ preview }) =>
        preview === undefined
          ? noPreviewBody()
          : new Markdown(preview, 0, 0, getMarkdownTheme())
              .render(Math.max(1, maxWidth))
              .map((line) => line.trimEnd()),
      );
      this.previewCache.set(key, previews);
    }
    return previews;
  }

  /** The bordered pane showing one option's preview body. */
  private previewPane(body: string[], paneWidth: number): string[] {
    const innerWidth = paneWidth - PREVIEW_PANE_FRAME_WIDTH;
    const border = (text: string): string => theme.fg("dim", text);
    const rule = "─".repeat(paneWidth - 2);
    const padding = " ".repeat(PREVIEW_PANE_PADDING);
    return [
      border(`┌${rule}┐`),
      ...body.map((line) => {
        const fill = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
        return `${border("│")}${padding}${truncateToWidth(line, innerWidth)}${fill}${padding}${border("│")}`;
      }),
      border(`└${rule}┘`),
    ];
  }

  /** The footer hint, naming the keys bound to the actions that handle
   *  them in the current state. */
  private hint(question: Question | undefined): string {
    const keybindings = getKeybindings();
    if (this.mode === "notes") {
      return keyHints(keybindings, [
        ["tui.input.submit", "to select"],
        ["tui.select.cancel", "to go back"],
        ["app.editor.external", "to edit in your editor"],
      ]).join(" · ");
    }
    const onOther = this.rows()[this.focusedRowIndex]?.kind === "other";
    const navigationActions: Keybinding[] = [
      ...(this.hasTabs && !onOther ? ["app.question.nextTab" as const] : []),
      "tui.select.up",
      "tui.select.down",
    ];
    const navigationKeys = navigationActions.flatMap(
      (keybinding) => keyLabel(keybindings, keybinding) ?? [],
    );
    return [
      ...keyHints(keybindings, [
        [onOther ? "tui.input.submit" : "tui.select.confirm", "to select"],
      ]),
      ...(navigationKeys.length === 0
        ? []
        : [`${navigationKeys.join("/")} to navigate`]),
      ...keyHints(keybindings, [
        ...(onOther
          ? [["app.editor.external", "to edit in your editor"] as const]
          : []),
        ...(question !== undefined && usesPreviewLayout(question)
          ? [["app.question.notes", "to add notes"] as const]
          : []),
        ["tui.select.cancel", "to cancel"],
      ]),
    ].join(" · ");
  }
}
