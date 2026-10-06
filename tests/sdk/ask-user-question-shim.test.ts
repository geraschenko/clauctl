// SDK expectations around a scripted AskUserQuestion call. Free: the
// answering shim stands in for the API and makes the model's first reply
// the call.
//
// Input validation: the CLI checks the call's input against the tool's
// schema before asking for permission, so canUseTool only ever sees
// well-formed input — askUserQuestionInput in src/tui/question-dialog.ts
// relies on this, and the AskUserQuestion tool view recognises the
// rejection by its InputValidationError prefix.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type PermissionResult, query } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { EMPTY_ANSWER, submitDecision } from "../../src/tui/question-dialog.ts";
import { startAnsweringShim, toolUseStream } from "./answering-shim.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const TOOL_USE_ID = "toolu_scripted_ask";

const DENY: PermissionResult = { behavior: "deny", message: "test deny" };

interface Observed {
  /** Tool names canUseTool was asked about. */
  asked: string[];
  /** The tool_result content as text (JSON when it is not a string). */
  toolResult: { content: string; isError: boolean } | undefined;
}

/** One turn whose first model reply calls AskUserQuestion with `input`;
 *  `decide` answers the permission ask. */
async function callAskUserQuestion(
  caseName: string,
  input: unknown,
  decide: (input: AskUserQuestionInput) => PermissionResult = () => DENY,
): Promise<Observed> {
  assertVersions();
  let sentToolUse = false;
  const shim = await startAnsweringShim((body) => {
    const request = body as { model?: string; tools?: { name: string }[] };
    const offersTool =
      request.tools?.some(({ name }) => name === "AskUserQuestion") ?? false;
    if (!offersTool || sentToolUse) return undefined;
    sentToolUse = true;
    return toolUseStream(
      request.model ?? "unknown",
      TOOL_USE_ID,
      "AskUserQuestion",
      input,
    );
  });
  const observed: Observed = { asked: [], toolResult: undefined };
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  try {
    const turn = query({
      prompt: "ask me something",
      options: {
        cwd,
        env: baseEnv(
          makeConfigDir(
            `ask-user-question-shim-${caseName}`,
            undefined,
            "never-expiring",
          ),
          { ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}` },
        ),
        canUseTool: (toolName, toolInput) => {
          observed.asked.push(toolName);
          return Promise.resolve(
            decide(toolInput as unknown as AskUserQuestionInput),
          );
        },
      },
    });
    for await (const message of turn) {
      if (message.type === "user" && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (
            block.type === "tool_result" &&
            block.tool_use_id === TOOL_USE_ID
          ) {
            observed.toolResult = {
              content:
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content),
              isError: block.is_error === true,
            };
          }
        }
      }
      if (message.type === "result") break;
    }
    turn.close();
  } finally {
    shim.close();
    rmSync(cwd, { recursive: true, force: true });
  }
  assert.ok(sentToolUse, `${caseName}: AskUserQuestion was never offered`);
  return observed;
}

test("well-formed input reaches canUseTool", async () => {
  const observed = await callAskUserQuestion("control", {
    questions: [
      {
        question: "Cats or dogs?",
        header: "Pet",
        multiSelect: false,
        options: [
          { label: "Cats", description: "c" },
          { label: "Dogs", description: "d" },
        ],
      },
    ],
  });
  assert.deepEqual(observed.asked, ["AskUserQuestion"]);
});

for (const [caseName, input] of [
  ["questions-not-array", { questions: "nope" }],
  [
    "option-without-label",
    {
      questions: [
        {
          question: "Q?",
          header: "H",
          multiSelect: false,
          options: [{ description: "x" }, { description: "y" }],
        },
      ],
    },
  ],
] as const) {
  test(`malformed input (${caseName}) gets an InputValidationError and never reaches canUseTool`, async () => {
    const observed = await callAskUserQuestion(caseName, input);
    assert.deepEqual(observed.asked, []);
    assert.equal(observed.toolResult?.isError, true);
    assert.match(
      observed.toolResult.content,
      /^<tool_use_error>InputValidationError/,
    );
  });
}

test("notes without a chosen option: the CLI reads native's (notes only) answer as no option selected", async () => {
  const observed = await callAskUserQuestion(
    "notes-only",
    {
      questions: [
        {
          question: "Which layout?",
          header: "Layout",
          multiSelect: false,
          options: [
            { label: "Grid", description: "g", preview: "Items in cells." },
            { label: "List", description: "l", preview: "One per row." },
          ],
        },
      ],
    },
    (input) => submitDecision(input, [{ ...EMPTY_ANSWER, notes: "tighter" }]),
  );
  assert.equal(observed.toolResult?.isError, false);
  assert.match(
    observed.toolResult.content,
    /\(no option selected\) notes: tighter/,
  );
});
