import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { PendingAsk } from "../../core/agent-state/index.ts";
import { ANSI_STYLE } from "../../format/style.ts";
import { PermissionPromptComponent } from "../components/permission-prompt.ts";
import { QuestionPromptComponent } from "../components/question-prompt.ts";
import { permissionDialog } from "../permission-dialog.ts";
import { askUserQuestionInput } from "../question-dialog.ts";
import type { AskPromptOccupant } from "./input-slot-occupant.ts";

/** What an ask prompt can have InteractiveMode do, for the ask it shows. */
export interface AskPromptHandlers {
  respond(
    toolUseId: string,
    decision: PermissionResult,
    feedback?: string,
  ): void;
  editText(text: string): Promise<string | undefined>;
  editPlan(toolUseId: string, planFilePath: string): void;
  interrupt(): void;
}

/** The prompt for `ask`: the question prompt when
 *  `askUserQuestionInput(ask.request)` is defined, the permission prompt
 *  otherwise. */
export function askPromptOccupant(
  ask: PendingAsk,
  pendingCount: number,
  cwd: string | undefined,
  editedPlan: string | undefined,
  handlers: AskPromptHandlers,
): AskPromptOccupant {
  const { toolUseId } = ask.request;
  const titleSuffix =
    ask.task === undefined ? undefined : ` — task: ${ask.task.description}`;
  const questions = askUserQuestionInput(ask.request);
  if (questions !== undefined) {
    return {
      kind: "questionPrompt",
      toolUseId,
      prompt: new QuestionPromptComponent(
        questions,
        titleSuffix,
        pendingCount,
        {
          decide: (decision) => handlers.respond(toolUseId, decision),
          editText: (text) => handlers.editText(text),
          interrupt: () => handlers.interrupt(),
        },
      ),
    };
  }
  const dialog = permissionDialog(
    ask.request,
    { cwd, style: ANSI_STYLE },
    editedPlan,
  );
  return {
    kind: "permissionPrompt",
    toolUseId,
    prompt: new PermissionPromptComponent(
      { ...dialog, title: `${dialog.title}${titleSuffix ?? ""}` },
      pendingCount,
      {
        decide: (decision, feedback) =>
          handlers.respond(toolUseId, decision, feedback),
        editText: (text) => handlers.editText(text),
        editPlan: (planFilePath) => handlers.editPlan(toolUseId, planFilePath),
        interrupt: () => handlers.interrupt(),
      },
    ),
  };
}
