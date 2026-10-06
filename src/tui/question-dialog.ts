/**
 * AskUserQuestion's answer model (docs/specs/ask-user-question.md): pure
 * functions from the ask's input and the user's answers to the decision
 * sent back to `canUseTool`. QuestionPromptComponent holds the state.
 */

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { PermissionRequest } from "../core/protocol/index.ts";
import { feedbackDenial } from "./permission-dialog.ts";

type Question = AskUserQuestionInput["questions"][number];

/** One question's answer in progress: the dialog's own state, not an SDK
 *  type. submitDecision and chatDecision turn it into the SDK's `answers`
 *  and `annotations`. */
export interface QuestionAnswer {
  /** Chosen option indices; at most one unless multiSelect. */
  readonly selected: readonly number[];
  /** The "Type something" row's text; chosen when non-empty and selected. */
  readonly otherText: string;
  readonly otherSelected: boolean;
  /** Preview layout only; kept across focus changes. */
  readonly notes: string;
}

export const EMPTY_ANSWER: QuestionAnswer = {
  selected: [],
  otherText: "",
  otherSelected: false,
  notes: "",
};

/**
 * The ask's input when the ask is an AskUserQuestion call; undefined for
 * other tools. The tool name alone identifies it: the CLI checks a call's
 * input against the tool's schema before asking for permission, so the
 * input has the SDK's AskUserQuestionInput shape: malformed input is
 * answered with an InputValidationError tool_result and never reaches
 * canUseTool (pinned by tests/sdk/ask-user-question-shim.test.ts).
 */
export function askUserQuestionInput(
  request: PermissionRequest,
): AskUserQuestionInput | undefined {
  return request.toolName === "AskUserQuestion"
    ? (request.input as unknown as AskUserQuestionInput)
    : undefined;
}

/** "Dogs" | "Red, Blue, Purple"; undefined when nothing is chosen. */
export function answerText(
  question: Question,
  answer: QuestionAnswer,
): string | undefined {
  const parts = [
    ...question.options
      .filter((_, index) => answer.selected.includes(index))
      .map((option) => option.label),
    ...(answer.otherSelected && answer.otherText !== ""
      ? [answer.otherText]
      : []),
  ];
  return parts.length === 0 ? undefined : parts.join(", ");
}

/** Single-select and some option has a preview. */
export function usesPreviewLayout(question: Question): boolean {
  return (
    question.multiSelect !== true &&
    question.options.some((option) => option.preview !== undefined)
  );
}

type Annotation = NonNullable<AskUserQuestionInput["annotations"]>[string];

/** Native claude's answer for a question with notes but no chosen option;
 *  the CLI tells the model "(no option selected)" (pinned by
 *  tests/sdk/ask-user-question-shim.test.ts). */
const NOTES_ONLY_ANSWER = "(notes only)";

/** Submit: allow with updatedInput {...input, answers, annotations}. */
export function submitDecision(
  input: AskUserQuestionInput,
  answers: readonly QuestionAnswer[],
): PermissionResult {
  const answerTexts: Record<string, string> = {};
  const annotations: Record<string, Annotation> = {};
  input.questions.forEach((question, index) => {
    const answer = answers[index] ?? EMPTY_ANSWER;
    const isPreviewLayout = usesPreviewLayout(question);
    const text =
      answerText(question, answer) ??
      (isPreviewLayout && answer.notes !== "" ? NOTES_ONLY_ANSWER : undefined);
    if (text === undefined) return;
    answerTexts[question.question] = text;
    if (!isPreviewLayout) return;
    const preview =
      answer.selected[0] === undefined
        ? undefined
        : question.options[answer.selected[0]]?.preview;
    const annotation: Annotation = {
      ...(preview === undefined ? {} : { preview }),
      ...(answer.notes === "" ? {} : { notes: answer.notes }),
    };
    if (Object.keys(annotation).length > 0) {
      annotations[question.question] = annotation;
    }
  });
  return {
    behavior: "allow",
    updatedInput: { ...input, answers: answerTexts, annotations },
  };
}

/** "Chat about this": claude's clarify text as a feedback deny; the wording
 *  is pinned by tests/sdk/api-context.test.ts. */
export function chatDecision(
  input: AskUserQuestionInput,
  answers: readonly QuestionAnswer[],
): PermissionResult {
  const asked = input.questions.map((question, index) => {
    const text = answerText(question, answers[index] ?? EMPTY_ANSWER);
    return `- "${question.question}"\n  ${text === undefined ? "(No answer provided)" : `Answer: ${text}`}`;
  });
  return feedbackDenial(
    [
      "The user wants to clarify these questions.",
      "    This means they may have additional information, context or questions for you.",
      "    Take their response into account and then reformulate the questions if appropriate.",
      "    Start by asking them what they would like to clarify.",
      "",
      "    Questions asked:",
      ...asked,
    ].join("\n"),
  );
}
