// The CLI's interrupted-request marker, as interruptMarkerText
// (src/core/session/entry-predicates.ts) recognises it: ending a pending
// permission ask by an interrupt, or by a deny with `interrupt: true`
// (CANCEL_DENY, src/tui/permission-dialog.ts), yields a
// `[Request interrupted…` user message both as a live SDK frame and as a
// session entry, neither carrying `origin`, and ends the turn. Free: the
// answering shim stands in for the API and makes the model's first reply a
// Bash call that needs permission.

import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type PermissionResult,
  type Query,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { interruptMarkerText } from "../../src/core/session/entry-predicates.ts";
import {
  readSessionEntries,
  type SessionEntry,
  sessionFilePath,
} from "../../src/core/session/file.ts";
import {
  CANCEL_DENY,
  PLAIN_DENY_MESSAGE,
} from "../../src/tui/permission-dialog.ts";
import { startAnsweringShim, toolUseStream } from "./answering-shim.ts";
import { assertVersions, baseEnv, makeConfigDir } from "./harness.ts";

interface EndedAsk {
  userFrames: SDKUserMessage[];
  entries: SessionEntry[];
  apiRequests: number;
  resultSubtype: string | undefined;
}

/** One turn whose first model reply asks for Bash; `endAsk` answers the
 *  permission ask (it may interrupt `turn` instead). */
async function endPendingAsk(
  caseName: string,
  endAsk: (turn: Query, signal: AbortSignal) => Promise<PermissionResult>,
): Promise<EndedAsk> {
  assertVersions();
  let apiRequests = 0;
  const shim = await startAnsweringShim((body) => {
    apiRequests += 1;
    if (apiRequests !== 1) return undefined;
    return toolUseStream(
      (body as { model?: string }).model ?? "unknown",
      "toolu_interrupted",
      "Bash",
      { command: "touch needs-permission", description: "touch" },
    );
  });
  const configDir = makeConfigDir(
    `interrupt-marker-${caseName}`,
    undefined,
    "never-expiring",
  );
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  let endInput!: () => void;
  const inputEnded = new Promise<void>((resolve) => (endInput = resolve));
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: "touch a file" },
      parent_tool_use_id: null,
    };
    await inputEnded;
  }
  const userFrames: SDKUserMessage[] = [];
  let sessionId: UUID | undefined;
  let resultSubtype: string | undefined;
  try {
    const turn = query({
      prompt: input(),
      options: {
        cwd,
        env: baseEnv(configDir, {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${shim.port}`,
        }),
        canUseTool: (_toolName, _toolInput, { signal }) => endAsk(turn, signal),
      },
    });
    for await (const message of turn) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id as UUID;
      }
      if (message.type === "user") userFrames.push(message);
      if (message.type === "result") {
        resultSubtype = message.subtype;
        break;
      }
    }
    endInput();
    turn.close();
  } finally {
    shim.close();
  }
  assert.ok(sessionId, "no system/init");
  const entries = readSessionEntries(
    sessionFilePath(configDir, cwd, sessionId),
  );
  rmSync(cwd, { recursive: true, force: true });
  return { userFrames, entries, apiRequests, resultSubtype };
}

function assertMarkerAndTurnEnd(ended: EndedAsk): void {
  const markerFrames = ended.userFrames.filter(
    (frame) => interruptMarkerText(frame) !== undefined,
  );
  assert.equal(markerFrames.length, 1, "one marker frame");
  const markerEntries = ended.entries.filter(
    (entry) =>
      entry.type === "user" && interruptMarkerText(entry) !== undefined,
  );
  assert.deepEqual(
    markerEntries.map(({ uuid }) => uuid),
    [markerFrames[0]!.uuid],
    "the marker's entry shares its frame's uuid",
  );
  assert.equal(ended.apiRequests, 1, "the model is not asked again");
  assert.equal(ended.resultSubtype, "error_during_execution");
}

test("an interrupt during a permission ask: the marker arrives as a frame and an entry, without origin", async () => {
  const ended = await endPendingAsk(
    "interrupt",
    (turn, signal) =>
      new Promise<PermissionResult>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new Error("interrupted")),
        );
        void turn.interrupt();
      }),
  );
  assertMarkerAndTurnEnd(ended);
});

test("CANCEL_DENY ends the turn like native's Cancel: the plain-deny tool_result, then the marker", async () => {
  const ended = await endPendingAsk("cancel-deny", () =>
    Promise.resolve(CANCEL_DENY),
  );
  assertMarkerAndTurnEnd(ended);
  const toolResults = ended.userFrames.flatMap((frame) =>
    Array.isArray(frame.message.content)
      ? frame.message.content.filter((block) => block.type === "tool_result")
      : [],
  );
  assert.deepEqual(
    toolResults.map((block) => block.content),
    [PLAIN_DENY_MESSAGE],
  );
});
