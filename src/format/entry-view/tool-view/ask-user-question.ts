// claude's AskUserQuestion rendering
// (docs/specs/ask-user-question.md, Behaviour 8): no header while pending
// (the dialog presents the call), an outcome as the header name once
// resolved, and one `· ` block per question as the summary — the answer
// from the structured result followed by the user's notes in full once
// answered (claude omits the notes), the option labels once declined.

import type { AskUserQuestionOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { isRecord } from "../../../core/generated/util.ts";
import type { RenderToolResult } from "../../render-types.ts";
import { defaultToolView } from "./default-tool-view.ts";
import type { AskUserQuestionInput } from "./generated.ts";
import type { ToolHeader, ToolView } from "./tool-view.ts";

/** The CLI's answer to input that fails the tool's schema; the rejected
 *  call stays in the transcript (pinned by
 *  tests/sdk/ask-user-question-shim.test.ts). */
const INPUT_VALIDATION_ERROR_PREFIX = "<tool_use_error>InputValidationError";

/** Shown in place of the outcome for a call the CLI rejected or whose args
 *  this view cannot read, so a malformed call stands out. */
const INVALID_INPUT_HEADER: ToolHeader = {
  name: "AskUserQuestion (invalid input)",
};

function isRejectedInput(result: RenderToolResult): boolean {
  return (
    result.isError && result.content.startsWith(INPUT_VALIDATION_ERROR_PREFIX)
  );
}

/** Whether the fields this view reads have their schema types. */
function isWellFormed(args: unknown): args is AskUserQuestionInput {
  return (
    isRecord(args) &&
    Array.isArray(args.questions) &&
    args.questions.every(
      (question: unknown) =>
        isRecord(question) &&
        typeof question.question === "string" &&
        Array.isArray(question.options) &&
        question.options.every(
          (option: unknown) =>
            isRecord(option) && typeof option.label === "string",
        ),
    )
  );
}

export const askUserQuestionView: ToolView<AskUserQuestionInput> = {
  header(args, _context, result) {
    if (result === undefined) {
      // No transcript display while pending. The dialog presents the call.
      return undefined;
    }
    if (!isWellFormed(args) || isRejectedInput(result)) {
      return INVALID_INPUT_HEADER;
    }
    return {
      name: result.isError
        ? "AskUserQuestion, user declined"
        : "AskUserQuestion, user answered",
    };
  },
  resultSummary(args, result, context) {
    if (!isWellFormed(args) || isRejectedInput(result)) {
      return defaultToolView.resultSummary(args, result, context);
    }
    if (result.isError) {
      return args.questions
        .map(
          ({ question, options }) =>
            `· ${question} (${options.map(({ label }) => label).join(" / ")})`,
        )
        .join("\n");
    }
    const output = result.toolUseResult as
      Partial<AskUserQuestionOutput> | null | undefined;
    const answers = output?.answers;
    if (!isRecord(answers)) {
      return defaultToolView.resultSummary(args, result, context);
    }
    return args.questions
      .flatMap(({ question }) => {
        const answer = answers[question];
        if (typeof answer !== "string") return [];
        const notes = output?.annotations?.[question]?.notes;
        return [
          `· ${question}\n → ${answer}`,
          ...(typeof notes === "string" && notes !== ""
            ? notes.split("\n").map((line) => `   ${line}`)
            : []),
        ];
      })
      .join("\n");
  },
};
