/**
 * QuestionPromptComponent rendering and keys
 * (docs/specs/ask-user-question.md, Behaviours 1–5). Decisions are checked
 * through question-dialog.ts's functions, whose wordings its own tests pin.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../core/generated/text.ts";
import { KEY } from "../../test-support/keys.ts";
import { CLAUCTL_KEYBINDINGS } from "../keybindings.ts";
import { CANCEL_DENY } from "../permission-dialog.ts";
import {
  submitDecision,
  chatDecision,
  EMPTY_ANSWER,
} from "../question-dialog.ts";
import { QuestionPromptComponent } from "./question-prompt.ts";

setKeybindings(new KeybindingsManager(CLAUCTL_KEYBINDINGS, {}));

type Question = AskUserQuestionInput["questions"][number];

const PET: Question = {
  question: "Do you prefer cats or dogs?",
  header: "Pet",
  multiSelect: false,
  options: [
    { label: "Cats", description: "Independent" },
    { label: "Dogs", description: "Loyal" },
  ],
};

const COLORS: Question = {
  question: "Which colors?",
  header: "Colors",
  multiSelect: true,
  options: [
    { label: "Red", description: "warm" },
    { label: "Blue", description: "cool" },
  ],
};

const LAYOUT: Question = {
  question: "Which layout?",
  header: "Layout",
  multiSelect: false,
  options: [
    { label: "Grid", description: "cells", preview: "Grid preview" },
    { label: "List", description: "rows" },
  ],
};

const asInput = (...questions: Question[]): AskUserQuestionInput =>
  ({ questions }) as unknown as AskUserQuestionInput;

function mount(
  input: AskUserQuestionInput,
  editText: (text: string) => Promise<string | undefined> = () =>
    Promise.resolve(undefined),
): {
  prompt: QuestionPromptComponent;
  decisions: PermissionResult[];
  interrupts: () => number;
} {
  const decisions: PermissionResult[] = [];
  let interruptCount = 0;
  const prompt = new QuestionPromptComponent(input, undefined, 1, {
    decide: (decision) => decisions.push(decision),
    editText: editText,
    interrupt: () => {
      interruptCount += 1;
    },
  });
  return { prompt, decisions, interrupts: () => interruptCount };
}

const screen = (prompt: QuestionPromptComponent, width = 80): string =>
  prompt.render(width).map(stripAnsi).join("\n");

const press = (prompt: QuestionPromptComponent, ...keys: string[]): void => {
  for (const key of keys) prompt.handleInput(key);
};

test("one question: header, numbered options with descriptions, Type something, Chat about this", () => {
  const { prompt } = mount(asInput(PET));
  const text = screen(prompt);
  assert.match(text, / ☐ Pet/);
  assert.match(text, /❯ 1\. Cats\n {5}Independent\n {2}2\. Dogs/);
  assert.match(text, / {2}3\. Type something\./);
  assert.match(text, / {2}4\. Chat about this/);
  assert.match(text, /Enter to select · ↑\/↓ to navigate · Esc to cancel/);
});

test("one single-select question: choosing an option submits", () => {
  const input = asInput(PET);
  const { prompt, decisions } = mount(input);
  press(prompt, KEY.down, KEY.enter);
  assert.deepEqual(decisions, [
    submitDecision(input, [{ ...EMPTY_ANSWER, selected: [1] }]),
  ]);
});

test("digits choose; ctrl+c cancels (deny and interrupt); Chat about this sends the clarify deny", () => {
  const input = asInput(PET);
  const digit = mount(input);
  press(digit.prompt, "1");
  assert.deepEqual(digit.decisions, [
    submitDecision(input, [{ ...EMPTY_ANSWER, selected: [0] }]),
  ]);
  const cancel = mount(input);
  press(cancel.prompt, KEY.ctrlC);
  assert.deepEqual(cancel.decisions, [CANCEL_DENY]);
  assert.equal(cancel.interrupts(), 0, "the deny itself ends the turn");
  const chat = mount(input);
  press(chat.prompt, "4");
  assert.deepEqual(chat.decisions, [chatDecision(input, [EMPTY_ANSWER])]);
});

test("Esc interrupts from the option rows and from the Type something row, without deciding", () => {
  const { prompt, decisions, interrupts } = mount(asInput(PET));
  press(prompt, KEY.escape);
  press(prompt, KEY.down, KEY.down, "F", KEY.escape);
  assert.equal(interrupts(), 2);
  assert.deepEqual(decisions, []);
  assert.match(screen(prompt), /❯ 3\. F/, "the typed text survives");
});

test("free text on the Type something row is chosen with Enter", () => {
  const input = asInput(PET);
  const { prompt, decisions } = mount(input);
  press(prompt, KEY.down, KEY.down, "F", "e", "r", "r", "e", "t");
  assert.match(screen(prompt), /❯ 3\. Ferret/);
  press(prompt, KEY.enter);
  assert.deepEqual(decisions, [
    submitDecision(input, [
      { ...EMPTY_ANSWER, otherText: "Ferret", otherSelected: true },
    ]),
  ]);
});

test("several questions: tab bar, answering advances, multi-select toggles, Submit tab reviews and submits", () => {
  const input = asInput(PET, COLORS);
  const { prompt, decisions } = mount(input);
  assert.match(screen(prompt), /← {2}☐ Pet {2}☐ Colors {2}✔ Submit {2}→/);
  press(prompt, KEY.enter);
  const colors = screen(prompt);
  assert.match(colors, /☒ Pet/);
  assert.match(colors, /❯ 1\. \[ \] Red/);
  assert.match(colors, /\[ \] Type something\.$/m);
  press(prompt, " ", KEY.down, KEY.enter);
  assert.match(screen(prompt), /\[✔\] Red[\s\S]*\[✔\] Blue/);
  press(prompt, KEY.down, "P", "u", "r", "p", "l", "e");
  assert.match(screen(prompt), /\[✔\] Purple/);
  press(prompt, KEY.down, KEY.enter);
  const review = screen(prompt);
  assert.match(review, /Review your answers/);
  assert.doesNotMatch(review, /not answered/);
  assert.match(review, /● Do you prefer cats or dogs\?\n {3}→ Cats/);
  assert.match(review, /→ Red, Blue, Purple/);
  press(prompt, KEY.enter);
  assert.deepEqual(decisions, [
    submitDecision(input, [
      { ...EMPTY_ANSWER, selected: [0] },
      {
        ...EMPTY_ANSWER,
        selected: [0, 1],
        otherText: "Purple",
        otherSelected: true,
      },
    ]),
  ]);
});

test("Tab switches tabs without answering; Cancel on the Submit tab denies and interrupts, like native", () => {
  const { prompt, decisions } = mount(asInput(PET, COLORS));
  press(prompt, KEY.tab);
  assert.match(screen(prompt), /Which colors\?/);
  press(prompt, KEY.tab);
  assert.match(screen(prompt), /⚠ You have not answered all questions/);
  press(prompt, KEY.down, KEY.enter);
  assert.deepEqual(decisions, [CANCEL_DENY]);
});

test("revisiting a tab keeps the Type something text cursor at its end", () => {
  const { prompt } = mount(asInput(PET, COLORS));
  press(
    prompt,
    KEY.down,
    KEY.down,
    "a",
    "b",
    "c",
    KEY.up,
    KEY.tab,
    KEY.shiftTab,
    KEY.down,
    KEY.down,
    "d",
  );
  assert.match(screen(prompt), /❯ 3\. abcd/);
});

test("preview layout: side pane for the focused option, no descriptions or Type something", () => {
  const { prompt } = mount(asInput(LAYOUT));
  const first = screen(prompt);
  assert.match(first, /❯ 1\. Grid[\s\S]*│ Grid preview/);
  assert.doesNotMatch(first, /cells|Type something/);
  assert.match(first, /Notes: press n to add notes/);
  assert.match(first, /n to add notes · Esc to cancel/);
  press(prompt, KEY.down);
  assert.match(screen(prompt), /No preview available/);
});

test("preview layout: options take a third of the width; the pane fits the widest preview whatever is focused", () => {
  const { prompt } = mount(asInput(LAYOUT));
  const paneTop = (): string => {
    const line = screen(prompt, 100)
      .split("\n")
      .find((candidate) => candidate.includes("┌"))!;
    return `${line.indexOf("┌")}:${line.slice(line.indexOf("┌"))}`;
  };
  // "No preview available" (List) is wider than "Grid preview".
  const expected = `34:┌${"─".repeat(22)}┐`;
  assert.equal(paneTop(), expected);
  press(prompt, KEY.down);
  assert.equal(paneTop(), expected);
});

test("notes: n edits, Esc keeps them, ctrl+g fills them from the editor without submitting", async () => {
  const input = asInput(LAYOUT);
  const edits: string[] = [];
  const { prompt, decisions } = mount(input, (text) => {
    edits.push(text);
    return Promise.resolve(`${text} and more`);
  });
  press(prompt, "n", "t", "i", "g", "h", "t", KEY.escape);
  assert.match(screen(prompt), /Notes: tight/);
  press(prompt, KEY.down);
  assert.match(screen(prompt), /Notes: tight/);
  press(prompt, "n", KEY.ctrlG);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(edits, ["tight"]);
  assert.deepEqual(decisions, []);
  press(prompt, KEY.escape, "1");
  assert.deepEqual(decisions, [
    submitDecision(input, [
      { ...EMPTY_ANSWER, selected: [0], notes: "tight and more" },
    ]),
  ]);
});

test("notes: Enter answers with the focused option, like Enter in selection mode", () => {
  const input = asInput(LAYOUT);
  const { prompt, decisions } = mount(input);
  press(prompt, KEY.down, "n", "o", "k", KEY.enter);
  assert.deepEqual(decisions, [
    submitDecision(input, [{ ...EMPTY_ANSWER, selected: [1], notes: "ok" }]),
  ]);
});

test("a task's ask and further pending asks extend the title line", () => {
  const prompt = new QuestionPromptComponent(
    asInput(PET),
    " — task: explore",
    3,
    {
      decide: () => {},
      editText: () => Promise.resolve(undefined),
      interrupt: () => {},
    },
  );
  assert.match(screen(prompt), / ☐ Pet — task: explore \(\+2 more\)/);
});

test("several questions: the navigation hint drops the tab key on the Type something row, which offers ctrl+g", () => {
  const { prompt } = mount(asInput(PET, COLORS));
  assert.match(
    screen(prompt),
    /Enter to select · Tab\/↑\/↓ to navigate · Esc to cancel/,
  );
  press(prompt, KEY.down, KEY.down);
  assert.match(
    screen(prompt),
    /Enter to select · ↑\/↓ to navigate · ctrl\+g to edit in your editor · Esc to cancel/,
  );
});

test("Type something row: left/right edit the text and Tab/Shift+Tab stay on the question", () => {
  const { prompt } = mount(asInput(PET, COLORS));
  press(prompt, KEY.down, KEY.down, "a", "c", KEY.left, "b", KEY.tab);
  press(prompt, KEY.shiftTab, KEY.right, "d");
  const text = screen(prompt);
  assert.match(text, /Do you prefer cats or dogs\?/);
  assert.match(text, /❯ 3\. abcd/);
});

test("Type something row: Enter commits the typed answer", () => {
  const input = asInput(PET);
  const { prompt, decisions } = mount(input);
  press(prompt, KEY.down, KEY.down, "x", KEY.enter);
  assert.deepEqual(decisions, [
    submitDecision(input, [
      { ...EMPTY_ANSWER, otherText: "x", otherSelected: true },
    ]),
  ]);
});

test("multi-select Type something: Enter deselects the typed answer and it stays deselected", () => {
  const { prompt } = mount(asInput(COLORS));
  press(prompt, KEY.down, KEY.down, "x");
  assert.match(screen(prompt), /❯ 3\. \[✔\] x/);
  press(prompt, KEY.enter);
  assert.match(screen(prompt), /❯ 3\. \[ \] x/);
});

test("Type something row: ctrl+g fills the text from the editor", async () => {
  let editing: Promise<string> | undefined;
  const { prompt } = mount(asInput(PET), () => {
    editing = Promise.resolve("from editor");
    return editing;
  });
  press(prompt, KEY.down, KEY.down, "x", KEY.ctrlG);
  // The prompt's own continuation was registered first, so it has run.
  await editing;
  assert.match(screen(prompt), /❯ 3\. from editor/);
});

test("notes: Enter on the last question's notes advances to the Submit tab", () => {
  const { prompt } = mount(asInput(PET, LAYOUT));
  press(prompt, KEY.tab, "n", "o", "k", KEY.enter);
  assert.match(screen(prompt), /Review your answers/);
});

test("app.question.nextTab follows a remap, in dispatch and in the hint", () => {
  setKeybindings(
    new KeybindingsManager(CLAUCTL_KEYBINDINGS, {
      "app.question.nextTab": "]",
    }),
  );
  try {
    const { prompt } = mount(asInput(PET, COLORS));
    assert.match(screen(prompt), /Enter to select · \]\/↑\/↓ to navigate/);
    press(prompt, KEY.tab);
    assert.match(screen(prompt), /Do you prefer cats or dogs\?/);
    press(prompt, "]");
    assert.match(screen(prompt), /Which colors\?/);
  } finally {
    setKeybindings(new KeybindingsManager(CLAUCTL_KEYBINDINGS, {}));
  }
});
