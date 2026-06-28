import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CanonicalEntryFilter } from "../core/session/entry-stream.ts";
import type { SessionEntry } from "../core/session/file.ts";
import {
  MessageProjector,
  type MessageRecord,
} from "../core/session/messages.ts";
import { decodeFormatInput } from "./input.ts";
import { MessageFormatter } from "./messages.ts";
import { formatSdkMessage, newFormatState } from "./sdk-message.ts";
import type { MessageFormatOptions } from "./types.ts";

const OPTIONS: MessageFormatOptions = {
  toolResults: "summary",
  maxToolArgChars: 120,
  maxErrorLines: 10,
};

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

// The renderers only inspect the fields they read, so minimal stubs suffice
// (same convention as agent-state.test.ts).
function entry(fields: Record<string, unknown>): SessionEntry {
  return { uuid: uuid(), sessionId: "s1", ...fields } as SessionEntry;
}

function user(content: unknown): SessionEntry {
  return entry({ type: "user", message: { role: "user", content } });
}

function assistant(content: unknown[], model = "claude-fable-5"): SessionEntry {
  return entry({
    type: "assistant",
    message: { role: "assistant", model, content, stop_reason: null },
  });
}

function toolUse(id: string, name: string, input: unknown): unknown {
  return { type: "tool_use", id, name, input };
}

function toolResult(
  toolUseId: string,
  content: unknown,
  isError = false,
): SessionEntry {
  return user([
    {
      type: "tool_result",
      tool_use_id: toolUseId,
      content,
      ...(isError && { is_error: true }),
    },
  ]);
}

/** The full entries pipeline: filter → projector → formatter, concatenating
 *  every push and the final end — exactly what `format messages` writes. */
function format(
  entries: SessionEntry[],
  options: Partial<MessageFormatOptions> = {},
): string {
  const filter = new CanonicalEntryFilter();
  const projector = new MessageProjector();
  const formatter = new MessageFormatter({ ...OPTIONS, ...options });
  let output = "";
  for (const item of entries) {
    const accepted = filter.accept(item);
    if (accepted === undefined) {
      continue;
    }
    for (const record of projector.push(accepted)) {
      output += formatter.push(record);
    }
  }
  return output + formatter.end();
}

/** Body without the trailing `[cursor: …]` line, for tests about rendering
 *  rather than cursor mechanics. */
function formatBody(
  entries: SessionEntry[],
  options: Partial<MessageFormatOptions> = {},
): string {
  return format(entries, options).replace(/\n*\[cursor: [^\]]*\]\n$/u, "\n");
}

test("user message renders fully, cursor line last", () => {
  const message = user("Fix the test");
  assert.equal(
    format([message]),
    `== user ==\nFix the test\n\n[cursor: ${message.uuid}]\n`,
  );
});

test("assistant renders thinking marker, tool call, and text", () => {
  const output = formatBody([
    assistant([
      { type: "thinking", thinking: "hidden reasoning" },
      toolUse("t1", "Read", { file_path: "src/foo.ts" }),
      { type: "text", text: "Reading the file." },
    ]),
  ]);
  assert.equal(
    output,
    "== assistant ==\n[thinking]\n[tool:Read file_path: src/foo.ts]\nReading the file.\n",
  );
});

test("tool call without preferred keys shows truncated JSON", () => {
  const output = formatBody(
    [assistant([toolUse("t1", "Custom", { alpha: "x".repeat(200) })])],
    { maxToolArgChars: 20 },
  );
  assert.equal(output, `== assistant ==\n[tool:Custom {"alpha":"xxxxxxxxx…]\n`);
});

test("tool results are named by the preceding tool_use id", () => {
  const output = format([
    assistant([toolUse("t1", "Read", { file_path: "a.ts" })]),
    toolResult("t1", "line1\nline2"),
  ]);
  assert.match(output, /\[Read:ok 2 lines, 11 bytes\]/u);
});

test("tool result with no known call falls back to 'tool'", () => {
  assert.match(format([toolResult("mystery", "x")]), /\[tool:ok /u);
});

test("--tool-results none drops results entirely", () => {
  const output = format(
    [assistant([toolUse("t1", "Read", {})]), toolResult("t1", "text")],
    { toolResults: "none" },
  );
  assert.doesNotMatch(output, /Read:ok/u);
});

test("--tool-results full shows the whole result text", () => {
  const output = format(
    [assistant([toolUse("t1", "Read", {})]), toolResult("t1", "a\nb\nc")],
    { toolResults: "full" },
  );
  assert.match(output, /\[Read:ok 3 lines, 5 bytes\]\na\nb\nc/u);
});

test("error results show a snippet capped at --max-error-lines", () => {
  const output = format(
    [
      assistant([toolUse("t1", "Bash", {})]),
      toolResult("t1", "e1\ne2\ne3\ne4", true),
    ],
    { maxErrorLines: 2 },
  );
  assert.match(output, /\[Bash:error 4 lines, 11 bytes\]\ne1\ne2\n/u);
  assert.doesNotMatch(output, /e3/u);
});

test("result renders as a one-liner", () => {
  const message = {
    type: "result",
    subtype: "success",
    num_turns: 1,
    duration_ms: 12345,
    total_cost_usd: 0.0421,
  } as unknown as SDKMessage;
  assert.equal(
    formatSdkMessage(message, newFormatState(), OPTIONS),
    "[result: success, 1 turn, 12.3s, $0.0421]",
  );
});

test("model change renders as a control, but not for the first assistant message", () => {
  const output = format([
    assistant([{ type: "text", text: "one" }], "claude-fable-5"),
    assistant([{ type: "text", text: "two" }], "claude-fable-5"),
    assistant([{ type: "text", text: "three" }], "claude-opus-4-8"),
  ]);
  const changes = output.match(/\[model:[^\]]*\]/gu);
  assert.deepEqual(changes, ["[model: claude-fable-5 -> claude-opus-4-8]"]);
  assert.match(output, /\[model: [^\]]*\]\n\n== assistant ==\nthree/u);
});

test("permission-mode entries render change controls only", () => {
  const mode = (permissionMode: string) =>
    ({ type: "permission-mode", permissionMode }) as SessionEntry;
  const output = format([mode("auto"), mode("auto"), mode("plan")]);
  assert.equal(output, "[permission-mode: auto -> plan]\n");
});

test("compact_boundary renders a compaction control", () => {
  const boundary = entry({
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: { trigger: "manual", preTokens: 12345 },
  });
  assert.equal(
    format([boundary]),
    `[compaction: manual, 12345 preTokens]\n\n[cursor: ${boundary.uuid}]\n`,
  );
  assert.equal(
    formatBody([entry({ type: "system", subtype: "compact_boundary" })]),
    "[compaction]\n",
  );
});

test("queued input renders as a truncated one-line annotation", () => {
  const long = `start ${"x".repeat(100)}`;
  const output = format([
    { type: "queue-operation", operation: "enqueue", content: long },
  ] as SessionEntry[]);
  assert.match(output, /^\[queued: start x+…\]\n$/u);
});

test("a render-dropped record still advances the cursor", () => {
  // A results-only user message renders nothing under --tool-results none,
  // but it was consumed, so resuming after it is correct.
  const results = toolResult("t1", "text");
  assert.equal(
    format([user("hi"), results], { toolResults: "none" }),
    `== user ==\nhi\n\n[cursor: ${results.uuid}]\n`,
  );
});

test("empty stream renders nothing, uuid-less stream gets no cursor", () => {
  assert.equal(format([]), "");
  assert.equal(
    format([
      { type: "permission-mode", permissionMode: "auto" } as SessionEntry,
    ]),
    "",
  );
});

test("duplicate uuids are canonicalized first-wins", () => {
  const original = user("original");
  const mutated = {
    ...original,
    message: { role: "user", content: "mutated" },
  } as SessionEntry;
  const output = format([original, mutated]);
  assert.match(output, /original/u);
  assert.doesNotMatch(output, /mutated/u);
});

test("mixed text and tool_result content renders both", () => {
  const output = formatBody([
    user([
      { type: "text", text: "interrupted by user" },
      { type: "tool_result", tool_use_id: "t1", content: "partial" },
    ]),
  ]);
  assert.equal(
    output,
    "== user ==\ninterrupted by user\n\n[tool:ok 1 lines, 7 bytes]\n",
  );
});

test("the SDKMessage long tail gets a generic type/subtype one-liner", () => {
  const formatState = newFormatState();
  const noSubtype = { type: "rare_variant" } as unknown as SDKMessage;
  assert.equal(
    formatSdkMessage(noSubtype, formatState, OPTIONS),
    "[rare_variant]",
  );
});

test("unprojected session-entry types are skipped silently", () => {
  const output = formatBody([
    entry({ type: "file-history-snapshot", snapshot: {} }),
    entry({ type: "attachment", attachment: {} }),
    entry({ type: "system", subtype: "init" }),
    user("hello"),
  ]);
  assert.equal(output, "== user ==\nhello\n");
});

test("formatted entries ≡ their projected records piped back as message JSONL", async () => {
  const entries = [
    user("Fix the torn-tail bug"),
    assistant(
      [toolUse("t1", "Read", { file_path: "src/core/session/file.ts" })],
      "claude-opus-5",
    ),
    toolResult("t1", "27 lines"),
    assistant([{ type: "text", text: "Done." }], "claude-fable-5"),
  ];
  const direct = format(entries);

  const filter = new CanonicalEntryFilter();
  const projector = new MessageProjector();
  const records: MessageRecord[] = [];
  for (const item of entries) {
    const accepted = filter.accept(item);
    if (accepted !== undefined) {
      records.push(...projector.push(accepted));
    }
  }
  const jsonl = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  const input = await decodeFormatInput(
    (async function* () {
      yield Buffer.from(jsonl);
    })(),
  );
  assert.equal(input.kind, "messages");
  assert(input.kind === "messages");
  const formatter = new MessageFormatter(OPTIONS);
  let piped = "";
  for await (const record of input.records) {
    piped += formatter.push(record);
  }
  piped += formatter.end();
  assert.equal(piped, direct);
});
