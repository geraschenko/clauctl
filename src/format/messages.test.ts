import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  formatSdkMessage,
  formatSessionRecords,
  newFormatState,
} from "./messages.ts";
import type { MessageFormatOptions, SessionRecord } from "./types.ts";

const OPTIONS: MessageFormatOptions = {
  toolResults: "summary",
  maxToolArgChars: 120,
  maxErrorLines: 10,
};

// The renderers only inspect the fields they read, so minimal stubs suffice
// (same convention as agent-state.test.ts).
function record(fields: Record<string, unknown>): SessionRecord {
  return fields as SessionRecord;
}

function user(content: unknown): SessionRecord {
  return record({ type: "user", message: { role: "user", content } });
}

function assistant(
  content: unknown[],
  model = "claude-fable-5",
): SessionRecord {
  return record({
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
): SessionRecord {
  return user([
    {
      type: "tool_result",
      tool_use_id: toolUseId,
      content,
      ...(isError && { is_error: true }),
    },
  ]);
}

function format(
  records: SessionRecord[],
  options: Partial<MessageFormatOptions> = {},
): string {
  return formatSessionRecords(records, { ...OPTIONS, ...options });
}

test("user message renders fully", () => {
  assert.equal(format([user("Fix the test")]), "== user ==\nFix the test\n");
});

test("assistant renders thinking marker, tool call, and text", () => {
  const output = format([
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
  const output = format(
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

test("model change is inferred, but not for the first assistant message", () => {
  const output = format([
    assistant([{ type: "text", text: "one" }], "claude-fable-5"),
    assistant([{ type: "text", text: "two" }], "claude-fable-5"),
    assistant([{ type: "text", text: "three" }], "claude-opus-4-8"),
  ]);
  const changes = output.match(/\[model:[^\]]*\]/gu);
  assert.deepEqual(changes, ["[model: claude-fable-5 -> claude-opus-4-8]"]);
  assert.match(output, /\[model: [^\]]*\]\n\n== assistant ==\nthree/u);
});

test("permission-mode entries dedupe to change lines only", () => {
  const mode = (permissionMode: string) =>
    record({ type: "permission-mode", permissionMode });
  const output = format([mode("auto"), mode("auto"), mode("plan")]);
  assert.equal(output, "[permission-mode: auto -> plan]\n");
});

test("dropped variants render nothing", () => {
  const dropped = [
    record({
      type: "user",
      isReplay: true,
      message: { role: "user", content: "replayed" },
    }),
    record({ type: "system", subtype: "init" }),
  ];
  assert.equal(format(dropped), "");
  // stream_event / rate_limit_event only reach the renderer in events mode.
  const formatState = newFormatState();
  for (const type of ["stream_event", "rate_limit_event"]) {
    const message = { type } as unknown as SDKMessage;
    assert.equal(formatSdkMessage(message, formatState, OPTIONS), undefined);
  }
});

test("mixed text and tool_result content renders both", () => {
  const output = format([
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
  assert.equal(
    format([record({ type: "system", subtype: "compact_boundary" })]),
    "[system: compact_boundary]\n",
  );
  const formatState = newFormatState();
  const noSubtype = { type: "rare_variant" } as unknown as SDKMessage;
  assert.equal(
    formatSdkMessage(noSubtype, formatState, OPTIONS),
    "[rare_variant]",
  );
});

test("unknown session-record types are skipped silently", () => {
  const output = format([
    record({ type: "file-history-snapshot", snapshot: {} }),
    record({ type: "attachment", attachment: {} }),
    user("hello"),
  ]);
  assert.equal(output, "== user ==\nhello\n");
});
