// P3 of docs/derisk/api-context-view/README.md and the Verification table
// of docs/specs/api-messages.md: how the CLI renders persisted entries into
// the /v1/messages body. Each test writes a synthetic session (a prompt, an
// assistant reply, then the fixture's entries; text fields carry a nonce),
// resumes it against the answering shim, and inspects the one request
// carrying the probe prompt. Every capture is also compared against the
// conversion (criterion 2). Nothing is forwarded. LIVE: one CLI process
// per capture, ~13 captures.
//
// Role convention in test names: "SR user block" = a
// `<system-reminder>`-wrapped text block inside the user message that
// carries the new prompt; "system" = a `role: "system"` message
// (mid-conversation system).

import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { leafContext } from "../../src/commands/format.ts";
import type { SessionEntry } from "../../src/core/session/file.ts";
import {
  compareApiMessages,
  type ApiComparison,
} from "../../src/format/api-messages/compare-api-messages.ts";
import { toApiMessages } from "../../src/format/api-messages/to-api-messages.ts";
import {
  captureInferenceRequest,
  splitPromptTurn,
} from "./capture-inference-request.ts";
import { assertVersions } from "./harness.ts";
import { scratchResumableSession } from "./resumable-session.ts";

const HAIKU = "claude-haiku-4-5-20251001";
/** A model the CLI turns mid-conversation system on for (docs/specs/api-messages.md, vocabulary). */
const GATED_MODEL = "claude-fable-5-1";
const FIXTURE_VERSION = "2.1.280";
const SR_OPEN = "<system-reminder>\n";

interface WireTextBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface WireMessage {
  role: string;
  content: string | WireTextBlock[];
}

interface WireBody {
  model: string;
  messages: WireMessage[];
}

/** A text unit carrying a nonce: a string-content message or one text
 *  block of a block-content message, with the message's role. */
interface NonceCarrier {
  role: string;
  text: string;
}

/** A fixture entry before chaining: the helper supplies uuid, parentUuid,
 *  timestamp and the session-wide fields. `parentIndex` (into the whole
 *  fixture, the two prefix entries included) branches off the linear
 *  chain. */
type FixtureEntry = Omit<SessionEntry, "uuid" | "parentUuid" | "timestamp"> & {
  parentIndex?: number;
};

interface FixtureOptions {
  /** The fixture reply's model; the CLI resumes with the session's last
   *  assistant model, so this is what pins the request's model. */
  model?: string;
  env?: Record<string, string>;
  /** Written to the session cwd before the capture. */
  claudeMd?: string;
}

function assistantReply(
  content: unknown[],
  model: string,
  id = "msg_fixture_reply",
): FixtureEntry {
  return {
    type: "assistant",
    message: {
      model,
      id,
      type: "message",
      role: "assistant",
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 5,
      },
    },
    requestId: `req_${id}`,
  };
}

function attachmentEntry(
  attachment: Record<string, unknown>,
  rendered: unknown = null,
): FixtureEntry {
  return { type: "attachment", attachment, rendered };
}

function userPrompt(text: string, parentIndex?: number): FixtureEntry {
  return {
    type: "user",
    message: { role: "user", content: text },
    permissionMode: "dontAsk",
    promptSource: "sdk",
    ...(parentIndex === undefined ? {} : { parentIndex }),
  };
}

function writeFixture(
  cwd: string,
  tail: FixtureEntry[],
  model: string,
): string {
  const sessionId = randomUUID();
  const common = {
    isSidechain: false,
    userType: "external",
    entrypoint: "sdk-ts",
    cwd,
    sessionId,
    version: FIXTURE_VERSION,
    gitBranch: "HEAD",
  };
  const fixture: FixtureEntry[] = [
    {
      type: "user",
      message: { role: "user", content: "Reply with exactly the word alpha." },
      permissionMode: "dontAsk",
      promptSource: "sdk",
    },
    assistantReply([{ type: "text", text: "alpha" }], model),
    ...tail,
  ];
  const uuids: UUID[] = [];
  const entries = fixture.map(
    ({ parentIndex, ...entry }, index): SessionEntry => {
      const uuid = randomUUID();
      const chained = {
        parentUuid:
          parentIndex === undefined
            ? (uuids.at(-1) ?? null)
            : uuids[parentIndex]!,
        ...common,
        ...entry,
        uuid,
        timestamp: `2026-09-26T10:00:${String(index).padStart(2, "0")}.000Z`,
      };
      uuids.push(uuid);
      return chained;
    },
  );
  const file = path.join(os.tmpdir(), `api-context-fixture-${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  return file;
}

/** One capture of a fixture session; the capture utility, the conversion
 *  and the comparison wired together, the comparison asserted zero
 *  failing (criterion 2). Each capture gets its own cwd: the CLI reads
 *  CLAUDE.md and auto-memory from it. */
async function captureFixture(
  tail: FixtureEntry[],
  options: FixtureOptions = {},
): Promise<{ body: WireBody; comparison: ApiComparison }> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "api-context-cwd-"));
  if (options.claudeMd !== undefined) {
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), options.claudeMd);
  }
  const model = options.model ?? HAIKU;
  const resumableSession = scratchResumableSession(
    writeFixture(cwd, tail, model),
    undefined,
  );
  const promptNonce = randomUUID().slice(0, 8);
  let captured;
  try {
    captured = await captureInferenceRequest(
      {
        ...resumableSession,
        env: { ...resumableSession.env, ...options.env },
      },
      `Reply with exactly the word pong. (tag: ${promptNonce})`,
      promptNonce,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  const { request, all } = captured;
  assert.ok(
    request !== undefined,
    `no /v1/messages request carried the prompt; saw ${all.map((r) => r.path).join(", ")}`,
  );
  const body = request.body as WireBody;
  assert.equal(body.model, model);
  const capture = splitPromptTurn(body, promptNonce);
  const comparison = compareApiMessages(
    capture,
    toApiMessages(leafContext(resumableSession.entries), {
      forceMidConversationSystem: capture.systemTail !== undefined,
    }),
  );
  assert.deepEqual(comparison.failing, [], "conversion differences");
  return { body, comparison };
}

/** The per-type P3 probe: one attachment after the fixture reply. */
async function captureWith(
  attachment: Record<string, unknown>,
  options: { rendered?: unknown; env?: Record<string, string> } = {},
): Promise<WireBody> {
  const { body } = await captureFixture(
    [attachmentEntry(attachment, options.rendered)],
    { env: options.env },
  );
  return body;
}

function nonceCarriers(body: WireBody, nonce: string): NonceCarrier[] {
  return body.messages.flatMap(({ role, content }) =>
    typeof content === "string"
      ? content.includes(nonce)
        ? [{ role, text: content }]
        : []
      : content.flatMap((block) =>
          block.text?.includes(nonce) === true
            ? [{ role, text: block.text }]
            : [],
        ),
  );
}

function occurrences(body: WireBody, nonce: string): number {
  return JSON.stringify(body).split(nonce).length - 1;
}

/** The nonce appears exactly once on the wire, in one SR-wrapped text
 *  block of a user message whose text starts with `prefix`. */
function assertSrUserBlock(
  body: WireBody,
  nonce: string,
  prefix: string,
): void {
  assert.equal(occurrences(body, nonce), 1, "nonce once in the whole body");
  const carriers = nonceCarriers(body, nonce);
  assert.equal(carriers.length, 1);
  assert.equal(carriers[0]!.role, "user");
  assert.ok(
    carriers[0]!.text.startsWith(SR_OPEN + prefix),
    `expected ${JSON.stringify(SR_OPEN + prefix)} prefix, got ${JSON.stringify(carriers[0]!.text.slice(0, 200))}`,
  );
}

function nonce(type: string): string {
  return `ATT-${type}-${randomUUID().slice(0, 8)}`;
}

test("versions pinned", () => {
  assertVersions();
});

test("todo_reminder: renders nothing (a RENDERS_NOTHING type)", async () => {
  const marker = nonce("todo");
  const body = await captureWith({
    type: "todo_reminder",
    content: [{ content: marker, status: "pending", activeForm: marker }],
    itemCount: 1,
  });
  assert.equal(occurrences(body, marker), 0);
});

test("total_tokens_reminder: SR user block, text verbatim", async () => {
  const marker = nonce("tokens");
  const body = await captureWith({
    type: "total_tokens_reminder",
    text: `<total_tokens>${marker}</total_tokens>`,
  });
  assertSrUserBlock(
    body,
    marker,
    `<total_tokens>${marker}</total_tokens>\n</system-reminder>`,
  );
});

test("rendered replay: the persisted rendered content goes out verbatim, unwrapped, instead of the payload text", async () => {
  const payloadMarker = nonce("payload");
  const renderedMarker = nonce("rendered");
  const body = await captureWith(
    {
      type: "total_tokens_reminder",
      text: `<total_tokens>${payloadMarker}</total_tokens>`,
    },
    {
      rendered: [{ content: `<total_tokens>${renderedMarker}</total_tokens>` }],
    },
  );
  assert.equal(occurrences(body, payloadMarker), 0);
  assert.equal(occurrences(body, renderedMarker), 1);
  const carriers = nonceCarriers(body, renderedMarker);
  assert.equal(carriers.length, 1);
  assert.equal(carriers[0]!.role, "user");
  // The snapshot is replayed as stored: no <system-reminder> is re-applied.
  assert.equal(
    carriers[0]!.text,
    `<total_tokens>${renderedMarker}</total_tokens>`,
  );
});

// The env can only force mid-conversation system ON; HAIKU's default is
// the SR user block (asserted by the total_tokens_reminder test above and here).
test("CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM=1 → role system (block content, wrapper stripped); default for HAIKU → SR user block", async () => {
  const forcedMarker = nonce("forced");
  const forced = await captureWith(
    {
      type: "total_tokens_reminder",
      text: `<total_tokens>${forcedMarker}</total_tokens>`,
    },
    { env: { CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM: "1" } },
  );
  assert.equal(occurrences(forced, forcedMarker), 1);
  const forcedCarriers = nonceCarriers(forced, forcedMarker);
  assert.equal(forcedCarriers.length, 1);
  assert.equal(forcedCarriers[0]!.role, "system");
  assert.ok(
    forcedCarriers[0]!.text.startsWith(
      `<total_tokens>${forcedMarker}</total_tokens>`,
    ),
  );
  assert.ok(!forcedCarriers[0]!.text.startsWith(SR_OPEN));
  // Flushed at the end of the history, after the new prompt, joined with
  // the request-time `# Environment` attachment.
  assert.equal(forced.messages.at(-1)!.role, "system");
  assert.ok(forcedCarriers[0]!.text.includes("\n\n# Environment\n"));

  const defaultMarker = nonce("default");
  const unforced = await captureWith({
    type: "total_tokens_reminder",
    text: `<total_tokens>${defaultMarker}</total_tokens>`,
  });
  assertSrUserBlock(
    unforced,
    defaultMarker,
    `<total_tokens>${defaultMarker}</total_tokens>`,
  );
  assert.ok(!unforced.messages.some((message) => message.role === "system"));
});

// Verification table, "attachment after tool_result": the two snapshot
// texts fold into the tool_result block's string content. The fixture
// ends with an assistant: resuming an unsettled tail makes the CLI add a
// synthetic "Continue from where you left off." turn (docs/specs/api-messages.md, Edge cases).
test("attachment after tool_result: snapshot texts fold into the tool_result's string content", async () => {
  const marker = nonce("after-result");
  const texts = [
    `${SR_OPEN}Called the Read tool with the following input: {"file_path":"/n.txt"}\n</system-reminder>`,
    `${SR_OPEN}Result of calling the Read tool:\n1\t${marker}\n</system-reminder>`,
  ];
  const toolUseId = "toolu_fixture_read";
  const { body, comparison } = await captureFixture([
    assistantReply(
      [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Read",
          input: { file_path: "/n.txt" },
        },
      ],
      HAIKU,
      "msg_fixture_tool",
    ),
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUseId, content: "ok" },
        ],
      },
    },
    // The payload must be well-formed: the transcript loader drops `file`
    // attachments without `content` (docs/specs/api-messages.md, Edge cases).
    attachmentEntry(
      {
        type: "file",
        filename: "/n.txt",
        displayPath: "n.txt",
        content: {
          type: "text",
          file: {
            filePath: "/n.txt",
            content: marker,
            numLines: 1,
            startLine: 1,
            totalLines: 1,
          },
        },
      },
      texts.map((content) => ({ content })),
    ),
    assistantReply([{ type: "text", text: "read" }], HAIKU, "msg_fixture_done"),
  ]);
  const toolResultMessage = body.messages[3]!;
  assert.equal(toolResultMessage.role, "user");
  assert.deepEqual(toolResultMessage.content, [
    {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: ["ok", ...texts].join("\n\n"),
    },
  ]);
  assert.equal(occurrences(body, marker), 1);
  assert.deepEqual(comparison.tolerated, []);
});

// Verification table, "request-time reminders": a CLAUDE.md in the cwd
// makes the CLI add reminder blocks to the prompt turn; the persisted
// attachment precedes them (the prefix rule), and they are reported as
// request-time, never as a difference.
test("request-time reminders follow the persisted trailing attachment in the prompt turn", async () => {
  const marker = nonce("persisted");
  const rule = nonce("claude-md");
  const { comparison } = await captureFixture(
    [
      attachmentEntry({ type: "total_tokens_reminder", text: "payload" }, [
        {
          content: `${SR_OPEN}<total_tokens>${marker}</total_tokens>\n</system-reminder>`,
        },
      ]),
    ],
    { claudeMd: `Project rule ${rule}\n` },
  );
  const requestTimeTexts = comparison.requestTime.promptTurnBlocks.map(
    (block) => String(block.text),
  );
  assert.ok(requestTimeTexts.some((text) => text.includes(rule)));
  assert.ok(!requestTimeTexts.some((text) => text.includes(marker)));
  assert.deepEqual(comparison.tolerated, []);
});

// Verification table, "mid-conversation system": trailing attachments
// become the system tail — one text block, wrappers stripped whether the
// snapshot was persisted wrapped or bare, joined by "\n\n", continued by
// the request-time text.
test("mid-conversation system (forced): one system tail block, wrappers stripped, texts joined by a blank line", async () => {
  const wrapped = nonce("wrapped");
  const bare = nonce("bare");
  const { body, comparison } = await captureFixture(
    [
      attachmentEntry({ type: "nested_memory", path: "/m/CLAUDE.md" }, [
        {
          content: `${SR_OPEN}Contents of /m/CLAUDE.md:\n\n${wrapped}\n</system-reminder>`,
        },
      ]),
      attachmentEntry({ type: "total_tokens_reminder", text: "payload" }, [
        { content: `<total_tokens>${bare}</total_tokens>` },
      ]),
    ],
    { env: { CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM: "1" } },
  );
  const tail = body.messages.at(-1)!;
  assert.equal(tail.role, "system");
  assert.ok(Array.isArray(tail.content));
  assert.equal(tail.content.length, 1);
  assert.ok(
    tail.content[0]!.text!.startsWith(
      `Contents of /m/CLAUDE.md:\n\n${wrapped}\n\n<total_tokens>${bare}</total_tokens>\n\n`,
    ),
  );
  assert.ok(comparison.requestTime.systemText!.startsWith("# Environment"));
  assert.deepEqual(comparison.tolerated, []);
});

// Verification table, "model-gated mid-conversation system": no env; the
// session's last assistant model turns the mode on, and the CLI adds an
// empty system message after the first user message.
test("model-gated mid-conversation system: system tail without the env, plus an empty system message after the first user", async () => {
  const marker = nonce("gated");
  const { body, comparison } = await captureFixture(
    [
      attachmentEntry({ type: "total_tokens_reminder", text: "payload" }, [
        {
          content: `${SR_OPEN}<total_tokens>${marker}</total_tokens>\n</system-reminder>`,
        },
      ]),
    ],
    { model: GATED_MODEL },
  );
  assert.equal(body.messages[1]!.role, "system");
  assert.deepEqual(body.messages[1]!.content, []);
  const tail = body.messages.at(-1)!;
  assert.equal(tail.role, "system");
  assert.ok(
    Array.isArray(tail.content) &&
      tail.content[0]!.text!.startsWith(
        `<total_tokens>${marker}</total_tokens>\n\n# Environment`,
      ),
  );
  assert.deepEqual(
    comparison.tolerated.map((difference) => difference.tolerance),
    ["empty-system-message"],
  );
});

// Verification table, "thinking-only assistant dropped": the CLI removes
// an all-thinking assistant and then merges the users it separated.
test("thinking-only assistant dropped; the attachment user merges into the prompt turn", async () => {
  const marker = nonce("think");
  const { body } = await captureFixture([
    attachmentEntry({ type: "total_tokens_reminder", text: "payload" }, [
      {
        content: `${SR_OPEN}<total_tokens>${marker}</total_tokens>\n</system-reminder>`,
      },
    ]),
    assistantReply(
      [{ type: "thinking", thinking: "only thinking", signature: "sig" }],
      HAIKU,
      "msg_fixture_thinking",
    ),
  ]);
  assert.equal(body.messages.length, 3);
  assert.equal(occurrences(body, "only thinking"), 0);
  const promptTurn = body.messages[2]!;
  assert.equal(promptTurn.role, "user");
  assert.ok(Array.isArray(promptTurn.content));
  assert.equal(occurrences(body, marker), 1);
  assert.ok(promptTurn.content[0]!.text!.includes(marker));
});

// Verification table, "`tool_use` stripped to wire fields": the persisted
// block's `caller` annotation does not go out.
test("tool call: the tool_use block goes out without its caller annotation", async () => {
  const toolUseId = "toolu_fixture_caller";
  const { body } = await captureFixture([
    assistantReply(
      [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Read",
          input: { file_path: "/n.txt" },
          caller: { type: "direct" },
        },
      ],
      HAIKU,
      "msg_fixture_tool",
    ),
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUseId, content: "ok" },
        ],
      },
    },
    assistantReply([{ type: "text", text: "read" }], HAIKU, "msg_fixture_done"),
  ]);
  const toolCall = body.messages[2]!;
  assert.equal(toolCall.role, "assistant");
  assert.deepEqual(toolCall.content, [
    {
      type: "tool_use",
      id: toolUseId,
      name: "Read",
      input: { file_path: "/n.txt" },
    },
  ]);
});

// Verification table, "foreign-model thinking dropped": thinking of an
// assistant whose model is not the request's model is removed; its text
// stays.
test("foreign thinking: another model's thinking block is dropped, its text kept", async () => {
  const marker = nonce("foreign");
  const { body } = await captureFixture([
    assistantReply(
      [
        { type: "thinking", thinking: "foreign thought", signature: "sig" },
        { type: "text", text: marker },
      ],
      "claude-opus-4-1-20250805",
      "msg_fixture_foreign",
    ),
    userPrompt("and now haiku"),
    assistantReply(
      [{ type: "text", text: "haiku" }],
      HAIKU,
      "msg_fixture_haiku",
    ),
  ]);
  assert.equal(body.model, HAIKU);
  assert.equal(occurrences(body, "foreign thought"), 0);
  assert.deepEqual(body.messages[2]!.content, [{ type: "text", text: marker }]);
});

// Verification table, "branch: only the leaf chain is sent": a user
// branching off the fixture reply leaves the earlier sibling turn behind.
test("branch: the abandoned sibling turn is absent; the leaf chain goes out", async () => {
  const abandoned = nonce("abandoned");
  const live = nonce("live");
  const { body } = await captureFixture([
    userPrompt(abandoned),
    assistantReply(
      [{ type: "text", text: "dead end" }],
      HAIKU,
      "msg_fixture_dead",
    ),
    userPrompt(live, 1),
    assistantReply(
      [{ type: "text", text: "alive" }],
      HAIKU,
      "msg_fixture_live",
    ),
  ]);
  assert.equal(occurrences(body, abandoned), 0);
  assert.equal(occurrences(body, "dead end"), 0);
  assert.equal(occurrences(body, live), 1);
  assert.equal(body.messages[2]!.content, live);
});
