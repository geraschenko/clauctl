/**
 * The AskUserQuestion decisions (docs/specs/ask-user-question.md,
 * Behaviour 6). Expected wordings are native claude's tool_results
 * captured 2026-10-06 (the spec's IMPLEMENTATION IDEAS).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { PermissionRequest } from "../core/protocol/index.ts";
import { feedbackDenial } from "./permission-dialog.ts";
import {
  answerText,
  submitDecision,
  askUserQuestionInput,
  chatDecision,
  EMPTY_ANSWER,
  usesPreviewLayout,
} from "./question-dialog.ts";

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
  question: "Which color?",
  header: "Colors",
  multiSelect: true,
  options: [
    { label: "Red", description: "warm" },
    { label: "Blue", description: "cool" },
    { label: "Green", description: "calm" },
  ],
};

const LAYOUT: Question = {
  question: "Which layout?",
  header: "Layout",
  multiSelect: false,
  options: [
    { label: "Grid", description: "cells", preview: "# Grid" },
    { label: "List", description: "rows" },
  ],
};

const input = (...questions: Question[]): AskUserQuestionInput =>
  ({ questions }) as unknown as AskUserQuestionInput;

const request = (
  toolName: string,
  requestInput: Record<string, unknown>,
): PermissionRequest => ({
  toolUseId: "toolu_q",
  toolName,
  input: requestInput,
  suggestions: [],
  arrivedAt: 0,
});

test("askUserQuestionInput identifies AskUserQuestion asks by tool name", () => {
  const input = { questions: [PET, COLORS] };
  assert.equal(
    askUserQuestionInput(request("AskUserQuestion", input)),
    input as unknown,
  );
  assert.equal(askUserQuestionInput(request("Bash", input)), undefined);
});

test("answerText: a label, multi-select labels in option order with typed text last, or undefined", () => {
  assert.equal(answerText(PET, EMPTY_ANSWER), undefined);
  assert.equal(answerText(PET, { ...EMPTY_ANSWER, selected: [1] }), "Dogs");
  assert.equal(
    answerText(COLORS, {
      ...EMPTY_ANSWER,
      selected: [2, 0],
      otherText: "Purple",
      otherSelected: true,
    }),
    "Red, Green, Purple",
  );
  assert.equal(
    answerText(PET, { ...EMPTY_ANSWER, otherText: "", otherSelected: true }),
    undefined,
  );
  assert.equal(
    answerText(PET, {
      ...EMPTY_ANSWER,
      otherText: "Ferrets",
      otherSelected: false,
    }),
    undefined,
  );
});

test("usesPreviewLayout: single-select with some preview", () => {
  assert.equal(usesPreviewLayout(LAYOUT), true);
  assert.equal(usesPreviewLayout(PET), false);
  assert.equal(usesPreviewLayout({ ...LAYOUT, multiSelect: true }), false);
});

test("submitDecision: answers keyed by question text, unanswered omitted, annotations {} without preview questions", () => {
  const asked = input(PET, COLORS);
  assert.deepEqual(
    submitDecision(asked, [{ ...EMPTY_ANSWER, selected: [0] }, EMPTY_ANSWER]),
    {
      behavior: "allow",
      updatedInput: {
        questions: [PET, COLORS],
        answers: { "Do you prefer cats or dogs?": "Cats" },
        annotations: {},
      },
    },
  );
});

test("submitDecision: a preview question's annotation carries the chosen preview and notes, absent fields omitted", () => {
  const asked = input(LAYOUT);
  const annotationsOf = (
    selected: number,
    notes: string,
  ): Record<string, unknown> => {
    const decision = submitDecision(asked, [
      { ...EMPTY_ANSWER, selected: [selected], notes },
    ]);
    assert.equal(decision.behavior, "allow");
    return (decision.updatedInput as { annotations: Record<string, unknown> })
      .annotations;
  };
  assert.deepEqual(annotationsOf(0, "tighter"), {
    "Which layout?": { preview: "# Grid", notes: "tighter" },
  });
  assert.deepEqual(annotationsOf(0, ""), {
    "Which layout?": { preview: "# Grid" },
  });
  assert.deepEqual(annotationsOf(1, "tighter"), {
    "Which layout?": { notes: "tighter" },
  });
  assert.deepEqual(annotationsOf(1, ""), {});
});

test("submitDecision: notes without a chosen option answer as native claude's (notes only)", () => {
  assert.deepEqual(
    submitDecision(input(LAYOUT), [{ ...EMPTY_ANSWER, notes: "tighter" }]),
    {
      behavior: "allow",
      updatedInput: {
        questions: [LAYOUT],
        answers: { "Which layout?": "(notes only)" },
        annotations: { "Which layout?": { notes: "tighter" } },
      },
    },
  );
  // Without notes the question stays unanswered.
  assert.deepEqual(submitDecision(input(LAYOUT), [EMPTY_ANSWER]), {
    behavior: "allow",
    updatedInput: { questions: [LAYOUT], answers: {}, annotations: {} },
  });
});

test("chatDecision: native claude's Chat about this tool_result", () => {
  assert.deepEqual(
    chatDecision(input(PET, COLORS), [
      { ...EMPTY_ANSWER, selected: [0] },
      EMPTY_ANSWER,
    ]),
    {
      behavior: "deny",
      message:
        'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nThe user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n- "Do you prefer cats or dogs?"\n  Answer: Cats\n- "Which color?"\n  (No answer provided)',
    },
  );
});

test("feedbackDenial: the rejection prefix, then the user's words", () => {
  assert.deepEqual(feedbackDenial("use rg"), {
    behavior: "deny",
    message:
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nuse rg",
  });
});
