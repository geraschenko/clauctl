import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import type { PendingAsk } from "../../core/agent-state/index.ts";
import { stripAnsi } from "../../core/generated/text.ts";
import type { TaskState } from "../../core/protocol/index.ts";
import { permissionRequestOf } from "../../core/protocol-server/index.ts";
import { KEY } from "../../test-support/keys.ts";
import { CLAUCTL_KEYBINDINGS } from "../keybindings.ts";
import { askPromptOccupant, type AskPromptHandlers } from "./ask-prompt.ts";

setKeybindings(new KeybindingsManager(CLAUCTL_KEYBINDINGS, {}));

function askFor(
  toolName: string,
  input: Record<string, unknown>,
  task?: TaskState,
): PendingAsk {
  const request = permissionRequestOf(
    toolName,
    input,
    {
      signal: new AbortController().signal,
      toolUseID: `toolu_${toolName}`,
      requestId: `req_${toolName}`,
    },
    0,
  );
  return task === undefined ? { request } : { request, task };
}

const TASK: TaskState = {
  taskId: "task_1",
  description: "lint the repo",
  background: true,
  status: "running",
  pendingPermissions: [],
  unresolvedToolUses: [],
};

/** Handlers recording what the prompt asked for. */
function recordingHandlers(): {
  handlers: AskPromptHandlers;
  responses: Array<[string, PermissionResult, string?]>;
  plansEdited: Array<[string, string]>;
} {
  const responses: Array<[string, PermissionResult, string?]> = [];
  const plansEdited: Array<[string, string]> = [];
  return {
    handlers: {
      respond: (...args) => responses.push(args),
      editText: async () => undefined,
      editPlan: (...args) => plansEdited.push(args),
      interrupt: () => {},
    },
    responses,
    plansEdited,
  };
}

test("an AskUserQuestion ask gets the question prompt", () => {
  const ask = askFor("AskUserQuestion", {
    questions: [
      {
        question: "Which?",
        header: "Pick",
        multiSelect: false,
        options: [
          { label: "A", description: "" },
          { label: "B", description: "" },
        ],
      },
    ],
  });
  const occupant = askPromptOccupant(
    ask,
    1,
    undefined,
    undefined,
    recordingHandlers().handlers,
  );
  assert.equal(occupant.kind, "questionPrompt");
  assert.equal(occupant.toolUseId, "toolu_AskUserQuestion");
});

test("another ask gets the permission prompt, titled with its task; a decision carries the ask's toolUseId", () => {
  const { handlers, responses } = recordingHandlers();
  const occupant = askPromptOccupant(
    askFor("Bash", { command: "ls" }, TASK),
    1,
    "/tmp",
    undefined,
    handlers,
  );
  assert.equal(occupant.kind, "permissionPrompt");
  const title = stripAnsi(occupant.prompt.render(80)[1] ?? "");
  assert.ok(title.endsWith(" — task: lint the repo"), title);
  occupant.prompt.handleInput("1");
  assert.deepEqual(responses, [
    ["toolu_Bash", { behavior: "allow" }, undefined],
  ]);
});

test("a plan prompt shows the edited plan; ctrl+g edits the plan for that ask", () => {
  const { handlers, plansEdited } = recordingHandlers();
  const occupant = askPromptOccupant(
    askFor("ExitPlanMode", { plan: "p", planFilePath: "/tmp/plan.md" }),
    1,
    "/tmp",
    "edited plan",
    handlers,
  );
  assert.ok(
    occupant.prompt
      .render(80)
      .map(stripAnsi)
      .join("\n")
      .includes("edited plan"),
  );
  occupant.prompt.handleInput(KEY.ctrlG);
  assert.deepEqual(plansEdited, [["toolu_ExitPlanMode", "/tmp/plan.md"]]);
});
