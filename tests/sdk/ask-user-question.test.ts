// SDK expectation: how the CLI turns the question dialog's decisions into
// the AskUserQuestion tool_result (docs/specs/ask-user-question.md, success
// criterion 4). Each case makes haiku raise one AskUserQuestion ask, answers
// it with a question-dialog.ts decision, and reads back the tool_result.
// Native claude's Esc and "Chat about this" texts, captured 2026-10-06 with
// claude 2.1.280, are pinned in src/tui/question-dialog.test.ts; here they
// must arrive verbatim.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type PermissionResult, query } from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { PLAIN_DENY } from "../../src/tui/permission-dialog.ts";
import {
  submitDecision,
  askUserQuestionInput,
  chatDecision,
  EMPTY_ANSWER,
  type QuestionAnswer,
} from "../../src/tui/question-dialog.ts";
import { permissionRequestOf } from "../../src/core/protocol-server/index.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";

const PET_PROMPT =
  'Call the AskUserQuestion tool once with one single-select question "Do you prefer cats or dogs?" (header "Pet", options Cats and Dogs).';
const LAYOUT_PROMPT =
  'Call the AskUserQuestion tool once with one single-select question "Which layout?" (header "Layout") and two options: "Grid" with preview "Items in cells." and "List" with preview "One per row."';

interface ObservedResult {
  content: string;
  isError: boolean;
  toolUseResult: unknown;
}

/** The text of a tool_result block's content (a string or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) =>
      block.type === "text" ? (block.text ?? "") : "",
    )
    .join("");
}

/**
 * Run `prompt`, answer the first AskUserQuestion ask with `decide(input)`,
 * and return that call's tool_result. Any other ask is denied.
 */
async function answerAsk(
  caseName: string,
  prompt: string,
  decide: (input: AskUserQuestionInput) => PermissionResult,
): Promise<ObservedResult> {
  assertVersions();
  const configDir = makeConfigDir(`ask-user-question-${caseName}`);
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  let toolUseId: string | undefined;
  let observed: ObservedResult | undefined;
  const q = query({
    prompt,
    options: {
      env: baseEnv(configDir),
      cwd,
      model: HAIKU,
      maxTurns: 3,
      canUseTool: (toolName, input, options) => {
        const parsed = askUserQuestionInput(
          permissionRequestOf(toolName, input, options, 0),
        );
        if (parsed === undefined || toolUseId !== undefined) {
          return Promise.resolve({ behavior: "deny", message: "not asked" });
        }
        toolUseId = options.toolUseID;
        return Promise.resolve(decide(parsed));
      },
    },
  });
  try {
    for await (const msg of q) {
      if (msg.type === "user" && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
            observed = {
              content: resultText(block.content),
              isError: block.is_error === true,
              toolUseResult: msg.tool_use_result,
            };
          }
        }
      }
      if (observed !== undefined || msg.type === "result") break;
    }
  } finally {
    q.close();
    rmSync(cwd, { recursive: true, force: true });
  }
  if (observed === undefined) {
    throw new Error(`${caseName}: no AskUserQuestion tool_result`);
  }
  return observed;
}

const chosen = (index: number): QuestionAnswer => ({
  ...EMPTY_ANSWER,
  selected: [index],
});

test("4.1 answers: a non-error result naming question and answer; tool_use_result.answers as sent", async () => {
  const result = await answerAsk("answers", PET_PROMPT, (input) =>
    submitDecision(input, [chosen(1)]),
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /"Do you prefer cats or dogs\?"="Dogs"/);
  assert.deepEqual((result.toolUseResult as { answers?: unknown }).answers, {
    "Do you prefer cats or dogs?": "Dogs",
  });
});

test("4.2 annotations: preview and notes reach the result text and tool_use_result", async () => {
  const result = await answerAsk("annotations", LAYOUT_PROMPT, (input) =>
    submitDecision(input, [{ ...chosen(0), notes: "tight spacing" }]),
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /selected preview:\nItems in cells\./);
  assert.match(result.content, /notes: tight spacing/);
  assert.deepEqual(
    (result.toolUseResult as { annotations?: unknown }).annotations,
    {
      "Which layout?": { preview: "Items in cells.", notes: "tight spacing" },
    },
  );
});

test("4.3/4.4 plain deny (native Esc): the message verbatim, is_error", async () => {
  const result = await answerAsk("plain-deny", PET_PROMPT, () => PLAIN_DENY);
  assert.equal(result.isError, true);
  assert.equal(
    result.content,
    PLAIN_DENY.behavior === "deny" ? PLAIN_DENY.message : "",
  );
});

test("4.3/4.4 chat deny (native Chat about this): the message verbatim, is_error", async () => {
  let sent = "";
  const result = await answerAsk("clarify", PET_PROMPT, (input) => {
    const decision = chatDecision(input, [EMPTY_ANSWER]);
    sent = decision.behavior === "deny" ? decision.message : "";
    return decision;
  });
  assert.equal(result.isError, true);
  assert.equal(result.content, sent);
});
