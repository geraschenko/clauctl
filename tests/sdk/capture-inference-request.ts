/**
 * Capturing the /v1/messages request the CLI builds for a resumable
 * session (docs/derisk/api-context-view/README.md): start the answering
 * shim, resume the session against it via the SDK, and pick out the
 * request carrying the prompt nonce; `splitPromptTurn` cuts its body at
 * the prompt (docs/specs/api-messages.md, the capture utility). Used by
 * scripts/capture-api-request.ts and the api-context sdk tests.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { isRecord } from "../../src/core/generated/util.ts";
import type { CapturedApiMessages } from "../../src/format/api-messages/compare-api-messages.ts";
import type {
  ApiContentBlock,
  ApiMessage,
} from "../../src/format/api-messages/to-api-messages.ts";
import { startAnsweringShim, type CapturedRequest } from "./answering-shim.ts";
import type { ResumableSession } from "./resumable-session.ts";

/** One SDK turn against the answering shim; the /v1/messages request whose
 *  messages contain `nonce`, plus everything the shim saw. */
export async function captureInferenceRequest(
  resumableSession: ResumableSession,
  prompt: string,
  nonce: string,
): Promise<{ request: CapturedRequest | undefined; all: CapturedRequest[] }> {
  const shim = await startAnsweringShim();
  try {
    const turn = query({
      prompt,
      options: {
        cwd: resumableSession.cwd,
        resume: resumableSession.sessionId,
        env: {
          ...resumableSession.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}`,
        },
        permissionMode: "dontAsk",
      },
    });
    for await (const message of turn) {
      if (message.type === "result") {
        break;
      }
    }
    turn.close();
  } finally {
    shim.close();
  }
  const request = shim.requests.find(
    (candidate) =>
      candidate.path.startsWith("/v1/messages") &&
      JSON.stringify(
        (candidate.body as { messages?: unknown } | null)?.messages ?? null,
      ).includes(nonce),
  );
  return { request, all: shim.requests };
}

/** The CLI's user-into-user merge appends one newline to the seam text
 *  (binary anchor `uuid:e.isMeta?n.uuid:e.uuid`, the merge that calls
 *  the seam join; observed by every api-context fixture whose attachment
 *  precedes the prompt). */
const SEAM_NEWLINE = "\n";

function wireMessages(body: unknown): ApiMessage[] {
  const messages = isRecord(body) ? body.messages : undefined;
  if (!Array.isArray(messages)) {
    throw new Error("captured body has no messages array");
  }
  return messages.map((message, index): ApiMessage => {
    const role = isRecord(message) ? message.role : undefined;
    const content = isRecord(message) ? message.content : undefined;
    if (
      (role !== "user" && role !== "assistant" && role !== "system") ||
      (typeof content !== "string" && !Array.isArray(content))
    ) {
      throw new Error(`messages[${index}]: not a role/content message`);
    }
    return {
      role,
      content:
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : (content as ApiContentBlock[]),
    };
  });
}

/** Cuts the captured body at the block carrying `nonce`; string content
 *  is one text block. Throws unless the body ends with a user message
 *  holding the nonce exactly once, optionally followed by one system
 *  message with one text block. */
export function splitPromptTurn(
  body: unknown,
  nonce: string,
): CapturedApiMessages {
  const messages = wireMessages(body);
  let promptTurnIndex = messages.length - 1;
  let systemTail: string | undefined;
  const last = messages.at(-1);
  if (last?.role === "system") {
    const text = last.content[0]?.text;
    if (last.content.length !== 1 || typeof text !== "string") {
      throw new Error("trailing system message is not one text block");
    }
    systemTail = text;
    promptTurnIndex -= 1;
  }
  const promptTurn = messages[promptTurnIndex];
  if (promptTurn?.role !== "user") {
    throw new Error("no user message before the end of the body");
  }
  const nonceIndices = promptTurn.content.flatMap((block, index) =>
    typeof block.text === "string" && block.text.includes(nonce) ? [index] : [],
  );
  if (nonceIndices.length !== 1) {
    throw new Error(
      `prompt turn holds the nonce ${nonceIndices.length} times, expected once`,
    );
  }
  const leading = promptTurn.content.slice(0, nonceIndices[0]);
  const seam = leading.at(-1);
  if (
    seam?.type === "text" &&
    typeof seam.text === "string" &&
    seam.text.endsWith(SEAM_NEWLINE)
  ) {
    leading[leading.length - 1] = {
      ...seam,
      text: seam.text.slice(0, -SEAM_NEWLINE.length),
    };
  }
  return {
    apiMessages: messages.slice(0, promptTurnIndex),
    promptTurnLeadingBlocks: leading,
    systemTail,
  };
}
