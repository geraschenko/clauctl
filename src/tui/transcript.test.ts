import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionEntry } from "../core/session/file.ts";
import { TranscriptRenderer } from "./transcript.ts";

// The Edit view's expanded diff reads pi's theme singleton; the TUI
// entrypoints initialize it the same way.
initTheme("dark");

// The renderer only inspects the fields the conversions read
// (sdk-render.ts), so partial stubs cast through unknown suffice — the same
// fixture style as sdk-render.test.ts. Shapes are carved from real session
// jsonl entries, reduced to the minimum.

// Each message gets its own uuid: the renderer renders a uuid's content
// once, and these tests are about content, not identity.
let nextUuid = 0;

function assistantMessage(
  content: unknown[],
  parentToolUseId: string | null = null,
): SDKMessage {
  nextUuid += 1;
  return {
    type: "assistant",
    uuid: `a-uuid-${nextUuid}`,
    parent_tool_use_id: parentToolUseId,
    message: { id: `msg-${nextUuid}`, content, stop_reason: null },
  } as unknown as SDKMessage;
}

function userMessage(content: unknown): SDKUserMessage {
  nextUuid += 1;
  return {
    type: "user",
    uuid: `u-uuid-${nextUuid}`,
    parent_tool_use_id: null,
    message: { role: "user", content },
  } as unknown as SDKUserMessage;
}

function toolResultMessage(
  toolUseId: string,
  text: string,
  isError = false,
): SDKMessage {
  return userMessage([
    {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: [{ type: "text", text }],
      is_error: isError,
    },
  ]) as SDKMessage;
}

function sessionEntry(entry: Record<string, unknown>): SessionEntry {
  return entry as unknown as SessionEntry;
}

/** Rendered plain text: ANSI/OSC stripped, blank edges trimmed. */
function renderedText(container: Container): string {
  return container
    .render(80)
    .map((line) =>
      // eslint-disable-next-line no-control-regex
      line.replaceAll(/\u001b\][^\u0007]*\u0007|\u001b\[[0-9;?]*[A-Za-z]/g, ""),
    )
    .join("\n")
    .trim();
}

function makeRenderer(): {
  renderer: TranscriptRenderer;
  container: Container;
} {
  const container = new Container();
  return { renderer: new TranscriptRenderer(container), container };
}

test("assistant text renders; a resolved Read folds by default and expands", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(
    assistantMessage([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file: "x" } },
    ]),
  );
  renderer.append(toolResultMessage("tool-1", "file contents here"));
  const collapsed = renderedText(container);
  assert.match(collapsed, /hello/);
  assert.match(collapsed, /Read 1 file \(ctrl\+o to expand\)/);
  assert.doesNotMatch(collapsed, /file contents here/);
  renderer.setToolsExpanded(true);
  const expanded = renderedText(container);
  assert.match(expanded, /Read/);
  assert.match(expanded, /file contents here/);
});

test("READ_ONLY_TOOLS without a bespoke view fold with a generic clause", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(
    assistantMessage([
      { type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "x" } },
      { type: "tool_use", id: "grep-2", name: "Grep", input: { pattern: "y" } },
    ]),
  );
  renderer.append(toolResultMessage("grep-1", "match"));
  renderer.append(toolResultMessage("grep-2", "match"));
  const collapsed = renderedText(container);
  // Capitalized: the run has no thinking clause to lead with.
  assert.match(collapsed, /Used Grep 2 times \(ctrl\+o to expand\)/);
  assert.doesNotMatch(collapsed, /match/);
});

test("an errored read-only call does not fold", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(
    assistantMessage([
      { type: "tool_use", id: "grep-3", name: "Grep", input: { pattern: "z" } },
    ]),
  );
  renderer.append(toolResultMessage("grep-3", "permission denied", true));
  const text = renderedText(container);
  assert.match(text, /Grep/);
  assert.match(text, /permission denied/);
  assert.doesNotMatch(text, /ctrl\+o to expand/);
});

test("a result for an unknown toolCallId is dropped", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(assistantMessage([{ type: "text", text: "hello" }]));
  const before = renderedText(container);
  renderer.append(toolResultMessage("no-such-tool", "orphan output"));
  assert.equal(renderedText(container), before);
});

test("append(user) renders prompt text unless the frame is a replay", () => {
  const { renderer, container } = makeRenderer();
  renderer.append({
    ...userMessage("a replay"),
    isReplay: true,
  } as unknown as SDKMessage);
  renderer.append({
    ...userMessage("a subagent's task prompt"),
    parent_tool_use_id: "task-1",
  });
  assert.equal(renderedText(container), "");
  renderer.append(userMessage("a live prompt"));
  assert.match(renderedText(container), /a live prompt/);
  // The CLI writes `isReplay: false` (events.jsonl:150); only true hides.
  renderer.append({
    ...userMessage("an ordinary prompt"),
    isReplay: false,
  } as unknown as SDKMessage);
  assert.match(renderedText(container), /an ordinary prompt/);
});

test("append(user) with no visible text renders nothing", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(userMessage([{ type: "image", source: {} }]));
  assert.equal(container.children.length, 0);
});

test("stream events drive a streaming component that the assistant message finalizes", () => {
  const { renderer, container } = makeRenderer();
  const streamEvent = (event: Record<string, unknown>): SDKMessage =>
    ({
      type: "stream_event",
      uuid: "s-uuid",
      parent_tool_use_id: null,
      event,
    }) as unknown as SDKMessage;
  renderer.append(
    streamEvent({ type: "message_start", message: { id: "msg_s" } }),
  );
  renderer.append(
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "par" },
    }),
  );
  renderer.append(
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "tial" },
    }),
  );
  assert.match(renderedText(container), /partial/);
  renderer.append(
    assistantFrame("s1", "msg_s", [{ type: "text", text: "final text" }]),
  );
  const text = renderedText(container);
  assert.match(text, /final text/);
  assert.doesNotMatch(text, /partial/);
  // The block's own item, then the (now empty) stream still open for the
  // rest of the response.
  assert.equal(container.children.length, 2);
  renderer.append(streamEvent({ type: "message_stop" }));
  assert.equal(container.children.length, 1);
  assert.match(renderedText(container), /final text/);
});

test("each assistant frame of a response takes its block out of the stream, in order", () => {
  const { renderer, container } = makeRenderer();
  const streamEvent = (event: Record<string, unknown>): SDKMessage =>
    ({
      type: "stream_event",
      uuid: "s-uuid",
      parent_tool_use_id: null,
      event,
    }) as unknown as SDKMessage;
  const textBlock = (index: number, text: string): void => {
    renderer.append(
      streamEvent({
        type: "content_block_start",
        index,
        content_block: { type: "text", text },
      }),
    );
  };
  renderer.append(
    streamEvent({ type: "message_start", message: { id: "msg_m" } }),
  );
  textBlock(0, "first block");
  renderer.append(
    assistantFrame("m1", "msg_m", [{ type: "text", text: "first block" }]),
  );
  textBlock(1, "second partial");
  // Item for block 0 ahead of the stream rendering block 1.
  assert.match(renderedText(container), /first block[\s\S]*second partial/);
  assert.equal(container.children.length, 2);
  renderer.append(
    assistantFrame("m2", "msg_m", [{ type: "text", text: "second block" }]),
  );
  renderer.append(streamEvent({ type: "message_stop" }));
  const text = renderedText(container);
  assert.match(text, /first block[\s\S]*second block/);
  assert.doesNotMatch(text, /partial/);
  assert.equal(container.children.length, 2);
});

test("a block's entry ahead of its frame leaves the stream open for the rest of the response", () => {
  const { renderer, container } = makeRenderer();
  const streamEvent = (event: Record<string, unknown>): SDKMessage =>
    ({
      type: "stream_event",
      uuid: "s-uuid",
      parent_tool_use_id: null,
      event,
    }) as unknown as SDKMessage;
  renderer.append(
    streamEvent({ type: "message_start", message: { id: "msg_e" } }),
  );
  renderer.append(
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "partial" },
    }),
  );
  renderer.appendEntry(
    assistantEntry("e1", "msg_e", [{ type: "text", text: "entry text" }]),
  );
  // The entry's item, then the stream.
  assert.equal(container.children.length, 2);
  assert.doesNotMatch(renderedText(container), /partial/);
  renderer.append(
    assistantFrame("e1", "msg_e", [{ type: "text", text: "entry text" }]),
  );
  assert.equal(container.children.length, 2);
  renderer.append(
    streamEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "still streaming" },
    }),
  );
  assert.match(renderedText(container), /entry text[\s\S]*still streaming/);
  renderer.append(streamEvent({ type: "message_stop" }));
  assert.equal(container.children.length, 1);
});

test("parent_tool_use_id routes content nested under the owning tool", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(
    assistantMessage([
      { type: "tool_use", id: "task-1", name: "Task", input: {} },
    ]),
  );
  const topLevelChildren = container.children.length;
  renderer.append(
    assistantMessage([{ type: "text", text: "subagent says hi" }], "task-1"),
  );
  assert.equal(container.children.length, topLevelChildren);
  // Collapsed, the subagent transcript hides behind the expand hint.
  assert.doesNotMatch(renderedText(container), /subagent says hi/);
  assert.match(renderedText(container), /\(ctrl\+o to expand\)/);
  renderer.setToolsExpanded(true);
  assert.match(renderedText(container), /subagent says hi/);
});

test("appendEntry: boundary banner, user prompt + result resolution, assistant", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "replayed prompt" },
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "assistant",
      uuid: "a1",
      message: {
        content: [{ type: "tool_use", id: "tool-9", name: "Grep", input: {} }],
        stop_reason: "tool_use",
      },
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-9",
            content: [{ type: "text", text: "grep output" }],
          },
        ],
      },
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 156_000, postTokens: 12_000 },
    }),
  );
  // Grep is read-only, so the resolved call folds until expanded.
  renderer.setToolsExpanded(true);
  const text = renderedText(container);
  assert.match(text, /replayed prompt/);
  assert.match(text, /Grep/);
  assert.match(text, /grep output/);
  assert.match(text, /context compacted \(156k → 12k tokens\)/);
});

test("compact banner omits token counts the boundary does not carry", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(
    sessionEntry({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 156_000 },
    }),
  );
  renderer.appendEntry(
    sessionEntry({ type: "system", subtype: "compact_boundary" }),
  );
  const text = renderedText(container);
  assert.match(text, /context compacted \(156k tokens\)/);
  assert.match(text, /context compacted$/m);
});

test("appendEntry skips meta and sidechain entries", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "m1",
      isMeta: true,
      message: { role: "user", content: "meta noise" },
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "s1",
      isSidechain: true,
      message: { role: "user", content: "sidechain noise" },
    }),
  );
  assert.equal(container.children.length, 0);
});

test("appendEntry renders a queued_command attachment as the user turn it was; other attachments render nothing", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(
    sessionEntry({
      type: "attachment",
      uuid: "q1",
      attachment: { type: "queued_command", prompt: "also say QUEUED" },
    }),
  );
  assert.match(renderedText(container), /❯ also say QUEUED/);
  const rendered = container.children.length;
  renderer.appendEntry(
    sessionEntry({
      type: "attachment",
      uuid: "r1",
      attachment: { type: "total_tokens_reminder" },
    }),
  );
  assert.equal(container.children.length, rendered);
});

test("conversation_reset clears the transcript and shows a banner", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(assistantMessage([{ type: "text", text: "old content" }]));
  renderer.append({ type: "conversation_reset" } as unknown as SDKMessage);
  const text = renderedText(container);
  assert.doesNotMatch(text, /old content/);
  assert.match(text, /conversation reset/);
});

test("thinking is collapsed by default and setShowThinking(true) reveals it", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(
    assistantMessage([{ type: "thinking", thinking: "secret reasoning" }]),
  );
  // Default: both toggles collapsed, so the thinking-only message folds.
  assert.doesNotMatch(renderedText(container), /secret reasoning/);
  assert.match(renderedText(container), /Thought.*\(ctrl\+o to expand\)/);
  renderer.setShowThinking(true);
  assert.match(renderedText(container), /secret reasoning/);
  renderer.append(
    assistantMessage([{ type: "thinking", thinking: "later reasoning" }]),
  );
  assert.match(renderedText(container), /later reasoning/);
  renderer.setShowThinking(false);
  assert.doesNotMatch(renderedText(container), /secret reasoning/);
  assert.doesNotMatch(renderedText(container), /later reasoning/);
});

test("a fold run sums thinking durations and counts tools, claude-style", () => {
  const { renderer, container } = makeRenderer();
  const at = (seconds: number): string =>
    new Date(1700000000000 + seconds * 1000).toISOString();
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "u1",
      timestamp: at(0),
      message: { role: "user", content: "read both files" },
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "assistant",
      uuid: "a1",
      timestamp: at(2.21),
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "tool_use", id: "r1", name: "Read", input: { file: "a" } },
        ],
        stop_reason: "tool_use",
      },
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "u2",
      timestamp: at(3),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "r1", content: "a contents" },
        ],
      },
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "assistant",
      uuid: "a2",
      timestamp: at(5.67),
      message: {
        content: [
          { type: "thinking", thinking: "hmm more" },
          { type: "tool_use", id: "r2", name: "Read", input: { file: "b" } },
        ],
        stop_reason: "tool_use",
      },
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "u3",
      timestamp: at(6),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "r2", content: "b contents" },
        ],
      },
    }),
  );
  // 2.21s + 2.67s of thinking = 4.88 → floored to 4s, two Reads fold in.
  assert.match(
    renderedText(container),
    /Thought for 4s, read 2 files \(ctrl\+o to expand\)/,
  );
  assert.doesNotMatch(renderedText(container), /a contents/);
});

test("a message's late second arrival does not move the thinking baseline backwards", () => {
  const { renderer, container } = makeRenderer();
  renderer.setToolsExpanded(true);
  const at = (seconds: number): string =>
    new Date(1700000000000 + seconds * 1000).toISOString();
  const thinkingEntry = (uuid: string, seconds: number): SessionEntry =>
    sessionEntry({
      type: "assistant",
      uuid,
      timestamp: at(seconds),
      message: {
        content: [{ type: "thinking", thinking: "hmm" }],
        stop_reason: "end_turn",
      },
    });
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "u1",
      timestamp: at(0),
      message: { role: "user", content: "go" },
    }),
  );
  renderer.appendEntry(thinkingEntry("a1", 2));
  // u1's query frame, delivered after a1 (the two sides lag independently).
  renderer.append({
    type: "user",
    uuid: "u1",
    parent_tool_use_id: null,
    timestamp: at(0),
    message: { role: "user", content: "go" },
  } as unknown as SDKMessage);
  renderer.appendEntry(thinkingEntry("a2", 5));
  assert.match(renderedText(container), /Thought for 2s \(ctrl\+t to show\)/);
  assert.match(renderedText(container), /Thought for 3s \(ctrl\+t to show\)/);
  assert.doesNotMatch(renderedText(container), /Thought for 5s/);
});

test("error results and non-readOnly tools break fold runs", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(
    assistantMessage([{ type: "tool_use", id: "r1", name: "Read", input: {} }]),
  );
  renderer.append(toolResultMessage("r1", "boom", true));
  // An error result renders the tool individually (no fold line).
  const text = renderedText(container);
  assert.doesNotMatch(text, /Read 1 file/);
  assert.match(text, /boom/);
  renderer.append(
    assistantMessage([
      { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } },
    ]),
  );
  renderer.append(toolResultMessage("b1", "ok"));
  // Bash never folds: its header and generic summary render directly.
  assert.match(renderedText(container), /Bash\(ls\)/);
});

test("claude layout: Update header, Added/removed summary, expanded diff", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "u0",
      cwd: "/repo",
      message: { role: "user", content: "edit the file" },
    }),
  );
  renderer.append(
    assistantMessage([
      {
        type: "tool_use",
        id: "e1",
        name: "Edit",
        input: {
          file_path: "/repo/src/a.ts",
          old_string: "old line",
          new_string: "new line one\nnew line two",
        },
      },
    ]),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "e1", content: "updated" },
        ],
      },
      toolUseResult: {
        structuredPatch: [
          {
            oldStart: 4,
            oldLines: 1,
            newStart: 4,
            newLines: 2,
            lines: ["-old line", "+new line one", "+new line two"],
          },
        ],
      },
    }),
  );
  // The diff renders beneath the summary in both toggle states, with
  // file-anchored numbers (old-file for -, new-file for +).
  const collapsed = renderedText(container);
  assert.match(collapsed, /Update\(src\/a\.ts\)/);
  assert.match(collapsed, /Added 2 lines, removed 1 line/);
  assert.match(collapsed, /4 -old line/);
  assert.match(collapsed, /5 \+new line two/);
  renderer.setToolsExpanded(true);
  assert.match(renderedText(container), /5 \+new line two/);
});

test("banners keep their transcript position across fold rebuilds", () => {
  const { renderer, container } = makeRenderer();
  renderer.addBanner("interrupted");
  renderer.append(
    assistantMessage([{ type: "thinking", thinking: "reasoning" }]),
  );
  assert.match(renderedText(container), /interrupted/);
  renderer.setToolsExpanded(true);
  renderer.setToolsExpanded(false);
  const text = renderedText(container);
  assert.match(text, /interrupted/);
  assert.ok(text.indexOf("interrupted") < text.indexOf("Thought"));
});

test("claude chrome: ❯ gutter with styled prompt echo, ● assistant gutter, one-blank spacing", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(
    userMessage("keep **bold** and `code` markers verbatim in this prompt"),
  );
  renderer.append(assistantMessage([{ type: "text", text: "Sure thing" }]));
  const lines = container.render(40).map((line) =>
    line
      // eslint-disable-next-line no-control-regex
      .replaceAll(/\u001b\][^\u0007]*\u0007|\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .trimEnd(),
  );
  // Inline markdown markers are consumed (claude 2.1.258 behavior) and the
  // wrap points follow the styled text.
  assert.deepEqual(lines, [
    "",
    "❯ keep bold and code markers verbatim",
    "  in this prompt",
    "",
    "● Sure thing",
  ]);
  // The user band uses claude's exact colors: bg 237, ❯ gutter 239, text
  // 231, inline code 153; **bold** is SGR 1.
  const rawUserLine = container.render(40)[1]!;
  // eslint-disable-next-line no-control-regex
  assert.match(rawUserLine, /\u001b\[48;5;237m/);
  // eslint-disable-next-line no-control-regex
  assert.match(rawUserLine, /\u001b\[38;5;239m❯ /);
  // eslint-disable-next-line no-control-regex
  assert.match(rawUserLine, /\u001b\[38;5;231m/);
  // eslint-disable-next-line no-control-regex
  assert.match(rawUserLine, /\u001b\[1mbold\u001b\[22m/);
  // eslint-disable-next-line no-control-regex
  assert.match(rawUserLine, /\u001b\[38;5;153mcode\u001b\[38;5;231m/);
});

test("setToolsExpanded expands collapsed tool output", () => {
  const { renderer, container } = makeRenderer();
  const longOutput = Array.from({ length: 12 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  renderer.append(
    assistantMessage([
      { type: "tool_use", id: "tool-2", name: "Bash", input: { cmd: "x" } },
    ]),
  );
  renderer.append(toolResultMessage("tool-2", longOutput));
  assert.doesNotMatch(renderedText(container), /line 11/);
  renderer.setToolsExpanded(true);
  assert.match(renderedText(container), /line 11/);
});

test("slash command with stdout renders a \u276f command block with \u2937 output", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(
    sessionEntry({
      type: "system",
      subtype: "local_command",
      uuid: "login-command",
      content:
        "<command-name>/login</command-name>\n            <command-message>login</command-message>\n            <command-args></command-args>",
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "system",
      subtype: "local_command",
      uuid: "login-output",
      parentUuid: "login-command",
      content: "<local-command-stdout>Login successful</local-command-stdout>",
    }),
  );
  const lines = renderedText(container).split("\n");
  assert.equal(lines[0], "\u276f /login");
  assert.match(lines[1]!, /\u2937 {2}Login successful/u);
});

test("output entry attaches to its parent command even when a pending item follows", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(
    sessionEntry({
      type: "system",
      subtype: "local_command",
      uuid: "login-command",
      content:
        "<command-name>/login</command-name><command-message>login</command-message><command-args></command-args>",
    }),
  );
  renderer.append(assistantMessage([{ type: "text", text: "hello" }]));
  renderer.appendEntry(
    sessionEntry({
      type: "system",
      subtype: "local_command",
      uuid: "login-output",
      parentUuid: "login-command",
      content: "<local-command-stdout>Login successful</local-command-stdout>",
    }),
  );
  const lines = renderedText(container).split("\n");
  assert.equal(lines[0], "\u276f /login");
  assert.match(lines[1]!, /\u2937 {2}Login successful/u);
  assert.equal(lines.at(-1), "\u25cf hello");
});

test("showResolvedBoundary draws a full-width rule between the resolved and pending parts, also with nothing pending", () => {
  const container = new Container();
  const renderer = new TranscriptRenderer(container, true);
  renderer.appendEntry(userEntry("r1", "resolved prompt"));
  const rule = "─".repeat(80);
  assert.equal(renderedText(container).split("\n").at(-1), rule);
  renderer.append(assistantMessage([{ type: "text", text: "pending" }]));
  const lines = renderedText(container).split("\n");
  assert.equal(lines[0], "❯ resolved prompt");
  assert.equal(lines.at(-1), "● pending");
  assert.ok(lines.indexOf(rule) > 0 && lines.indexOf(rule) < lines.length - 1);
});

test("output entry with unknown parent renders standalone", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(
    sessionEntry({
      type: "system",
      subtype: "local_command",
      uuid: "login-command",
      content:
        "<command-name>/login</command-name><command-message>login</command-message><command-args></command-args>",
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "system",
      subtype: "local_command",
      uuid: "login-output",
      parentUuid: "pruned-command",
      content: "<local-command-stdout>Login successful</local-command-stdout>",
    }),
  );
  assert.equal(container.children.length, 2);
  assert.match(renderedText(container), /Login successful/);
});

test("/compact stdout attaches as the command's result line; 'No response requested.' is hidden", () => {
  const { renderer, container } = makeRenderer();
  const command = userMessage(
    "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>",
  );
  renderer.append(command);
  renderer.appendEntry(
    sessionEntry({
      type: "system",
      subtype: "local_command",
      uuid: "compact-output",
      parentUuid: command.uuid,
      content:
        "<local-command-stdout>Not enough messages to compact.</local-command-stdout>",
    }),
  );
  renderer.append(
    assistantMessage([{ type: "text", text: "No response requested." }]),
  );
  const lines = renderedText(container).split("\n");
  assert.deepEqual([lines[0], lines.length], ["\u276f /compact", 2]);
  assert.match(lines[1]!, /\u2937 {2}Not enough messages to compact\./u);
});

test("bash passthrough: \u276f ! command with unescaped collapsed output", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(userMessage("<bash-input>git show HEAD</bash-input>"));
  renderer.append(
    userMessage(
      "<bash-stdout>Author: A &lt;a@b.c&gt;</bash-stdout><bash-stderr></bash-stderr>",
    ),
  );
  const lines = renderedText(container).split("\n");
  assert.equal(lines[0], "\u276f ! git show HEAD");
  assert.match(lines[1]!, /\u2937 {2}Author: A <a@b\.c>/u);
});

// Render-once fixtures: the same assistant message as its query-stream
// frame (`stop_reason: null`) and as its file entry (final stop_reason),
// sharing the transcript uuid and the API message id.
function assistantFrame(
  uuid: string,
  apiMessageId: string,
  content: unknown[],
): SDKMessage {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    message: { id: apiMessageId, content, stop_reason: null },
  } as unknown as SDKMessage;
}

function assistantEntry(
  uuid: string,
  apiMessageId: string,
  content: unknown[],
  stopReason = "end_turn",
): SessionEntry {
  return sessionEntry({
    type: "assistant",
    uuid,
    message: { id: apiMessageId, content, stop_reason: stopReason },
  });
}

function messageStart(apiMessageId: string): SDKMessage {
  return {
    type: "stream_event",
    uuid: `stream-${apiMessageId}`,
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id: apiMessageId } },
  } as unknown as SDKMessage;
}

function messageStop(): SDKMessage {
  return {
    type: "stream_event",
    uuid: "stream-stop",
    parent_tool_use_id: null,
    event: { type: "message_stop" },
  } as unknown as SDKMessage;
}

function textDelta(text: string): SDKMessage {
  return {
    type: "stream_event",
    uuid: "stream-delta",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text },
    },
  } as unknown as SDKMessage;
}

/** Anchored at `anchorUuid` (its summary), or at itself when omitted. */
function boundaryFrame(uuid: string, anchorUuid: string = uuid): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid,
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 156_000,
      preserved_messages: { anchor_uuid: anchorUuid, uuids: [] },
    },
  } as unknown as SDKMessage;
}

function boundaryEntry(uuid: string, anchorUuid: string = uuid): SessionEntry {
  return sessionEntry({
    type: "system",
    subtype: "compact_boundary",
    uuid,
    compactMetadata: {
      preTokens: 156_000,
      preservedMessages: { anchorUuid, uuids: [] },
    },
  });
}

const SUMMARY_TEXT = "## Summary\n\nAll the context.";

function summaryFrame(uuid: string): SDKMessage {
  return {
    type: "user",
    uuid,
    parent_tool_use_id: null,
    message: { role: "user", content: SUMMARY_TEXT },
  } as unknown as SDKMessage;
}

function summaryEntry(uuid: string): SessionEntry {
  return sessionEntry({
    type: "user",
    uuid,
    isCompactSummary: true,
    message: { role: "user", content: SUMMARY_TEXT },
  });
}

const TEXT_A = [{ type: "text", text: "reply A" }];
const TEXT_B = [{ type: "text", text: "reply B" }];

test("render-once: an assistant message renders once from whichever side arrives first", () => {
  const frameFirst = makeRenderer();
  frameFirst.renderer.append(assistantFrame("a1", "msg_1", TEXT_A));
  frameFirst.renderer.appendEntry(assistantEntry("a1", "msg_1", TEXT_A));
  assert.equal(frameFirst.container.children.length, 1);
  assert.equal(renderedText(frameFirst.container), "● reply A");

  const entryFirst = makeRenderer();
  entryFirst.renderer.appendEntry(assistantEntry("a1", "msg_1", TEXT_A));
  entryFirst.renderer.append(assistantFrame("a1", "msg_1", TEXT_A));
  assert.equal(entryFirst.container.children.length, 1);
  assert.equal(renderedText(entryFirst.container), "● reply A");
});

test("render-once: a compact boundary banners once from either side", () => {
  const frameFirst = makeRenderer();
  frameFirst.renderer.append(boundaryFrame("b1"));
  frameFirst.renderer.appendEntry(boundaryEntry("b1"));
  assert.equal(frameFirst.container.children.length, 1);

  const entryFirst = makeRenderer();
  entryFirst.renderer.appendEntry(boundaryEntry("b1"));
  entryFirst.renderer.append(boundaryFrame("b1"));
  assert.equal(entryFirst.container.children.length, 1);
  assert.match(renderedText(entryFirst.container), /context compacted/);
});

test("stream ownership is the API message id: file A → message_start A → file B → frame A", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(assistantEntry("a1", "msg_A", TEXT_A));
  renderer.append(messageStart("msg_A"));
  renderer.append(textDelta("partial A"));
  // B's entry is not the open stream's owner: it renders whole, above the
  // pending stream, and leaves it alone.
  renderer.appendEntry(assistantEntry("b1", "msg_B", TEXT_B));
  assert.match(renderedText(container), /partial A/);
  assert.match(renderedText(container), /reply B/);
  // A's frame takes its block out of its own stream, which stays open.
  renderer.append(assistantFrame("a1", "msg_A", TEXT_A));
  assert.equal(container.children.length, 3);
  assert.doesNotMatch(renderedText(container), /partial A/);
  renderer.append(messageStop());
  assert.equal(container.children.length, 2);
  assert.equal(renderedText(container), "● reply A\n\n● reply B");
});

test("resolve with the frame's entry updates its item in place without re-creating tool items", () => {
  const { renderer, container } = makeRenderer();
  const content = [
    { type: "text", text: "cut off" },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
  ];
  renderer.append(assistantFrame("a1", "msg_1", content));
  const childrenBefore = container.children.length;
  renderer.resolve(
    "a1" as never,
    assistantEntry("a1", "msg_1", content, "max_tokens"),
  );
  assert.equal(container.children.length, childrenBefore);
  assert.match(renderedText(container), /maximum output token limit/);
});

test("a user frame renders its prompt and resolves tool results; its entry renders nothing more", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(
    assistantMessage([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]),
  );
  const message = {
    role: "user",
    content: [
      { type: "text", text: "next question" },
      { type: "tool_result", tool_use_id: "t1", content: "listing" },
    ],
  };
  renderer.append({
    type: "user",
    uuid: "u1",
    parent_tool_use_id: null,
    message,
  } as unknown as SDKMessage);
  assert.match(renderedText(container), /listing/);
  assert.equal(renderedText(container).match(/next question/g)?.length, 1);
  renderer.appendEntry(sessionEntry({ type: "user", uuid: "u1", message }));
  assert.equal(renderedText(container).match(/next question/g)?.length, 1);
});

test("a compact summary renders once: the frame as its boundary's anchor, the entry by isCompactSummary", () => {
  const frameFirst = makeRenderer();
  frameFirst.renderer.append(boundaryFrame("b1", "cs1"));
  frameFirst.renderer.append(summaryFrame("cs1"));
  assert.equal(frameFirst.container.children.length, 2);
  assert.match(renderedText(frameFirst.container), /Compacted/);
  assert.doesNotMatch(renderedText(frameFirst.container), /❯/u);
  frameFirst.renderer.appendEntry(boundaryEntry("b1", "cs1"));
  frameFirst.renderer.appendEntry(summaryEntry("cs1"));
  assert.equal(frameFirst.container.children.length, 2);

  const entryFirst = makeRenderer();
  entryFirst.renderer.appendEntry(boundaryEntry("b1", "cs1"));
  entryFirst.renderer.appendEntry(summaryEntry("cs1"));
  entryFirst.renderer.append(boundaryFrame("b1", "cs1"));
  entryFirst.renderer.append(summaryFrame("cs1"));
  assert.equal(entryFirst.container.children.length, 2);
  assert.match(renderedText(entryFirst.container), /Compacted/);
});

test("a self-anchored boundary frame (no summary) expects none: the next user frame is a prompt", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(boundaryFrame("b1"));
  renderer.append(userMessage("a prompt after a rewind"));
  assert.match(renderedText(container), /a prompt after a rewind/);
  assert.doesNotMatch(renderedText(container), /Compacted/);
});

test("only the anchor is the summary: a boundary frame's expectation lapses at the next user frame", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(boundaryFrame("b1", "cs1"));
  renderer.append(userMessage("not the summary"));
  renderer.append(summaryFrame("cs1"));
  assert.match(renderedText(container), /not the summary/);
  assert.doesNotMatch(renderedText(container), /Compacted \(/);
});

test("a relinked summary entry renders as the summary under a boundary that is not its own", () => {
  // A later boundary preserves an earlier compaction's summary without
  // its boundary (session file: boundary f3e4b1fa self-anchored, next
  // entry 2dac0aa6 isCompactSummary parented on it).
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(boundaryEntry("b2"));
  renderer.appendEntry(summaryEntry("cs1"));
  assert.match(renderedText(container), /Compacted \(/);
  assert.doesNotMatch(renderedText(container), /❯/u);
});

test("output-only frame then entry attaches the output once", () => {
  const { renderer, container } = makeRenderer();
  const command = userMessage(
    "<command-name>/login</command-name><command-message>login</command-message><command-args></command-args>",
  );
  renderer.append(command);
  const output =
    "<local-command-stdout>Login successful</local-command-stdout>";
  renderer.append({
    type: "user",
    uuid: "o1",
    parent_tool_use_id: null,
    isReplay: true,
    message: { role: "user", content: output },
  } as unknown as SDKMessage);
  assert.doesNotMatch(renderedText(container), /Login successful/);
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "o1",
      parentUuid: command.uuid,
      message: { role: "user", content: output },
    }),
  );
  renderer.appendEntry(
    sessionEntry({
      type: "user",
      uuid: "o1",
      parentUuid: command.uuid,
      message: { role: "user", content: output },
    }),
  );
  assert.equal(container.children.length, 1);
  assert.equal(renderedText(container).match(/Login successful/g)?.length, 1);
});

// Resolution fixtures (see file comment of transcript.ts: resolved part,
// then pending part). `userEntry` has no frame in these tests: resolving
// it appends to the resolved part, so where it lands shows the boundary.
function userEntry(uuid: string, text: string): SessionEntry {
  return sessionEntry({
    type: "user",
    uuid,
    message: { role: "user", content: text },
  });
}

test("resolve: a frame's item moves into the resolved part and re-renders from its entry, ahead of every pending item", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(assistantFrame("a1", "msg_1", TEXT_A));
  renderer.append(assistantFrame("a2", "msg_2", TEXT_B));
  renderer.resolve(
    "a1" as never,
    assistantEntry("a1", "msg_1", TEXT_A, "max_tokens"),
  );
  assert.equal(container.children.length, 2);
  assert.match(
    renderedText(container),
    /reply A[\s\S]*maximum output token limit[\s\S]*reply B/,
  );
  // An entry without a frame lands at the end of the resolved part: after
  // a1, before the still-pending a2.
  renderer.resolve("u3" as never, userEntry("u3", "a prompt"));
  assert.match(renderedText(container), /reply A[\s\S]*a prompt[\s\S]*reply B/);
});

test("resolve: an unkeyed banner joins the resolved part when nothing is pending, else waits behind the pending items", () => {
  const withNothingPending = makeRenderer();
  withNothingPending.renderer.addBanner("interrupted");
  withNothingPending.renderer.append(assistantFrame("a2", "msg_2", TEXT_B));
  withNothingPending.renderer.resolve(
    "u1" as never,
    userEntry("u1", "a prompt"),
  );
  assert.match(
    renderedText(withNothingPending.container),
    /interrupted[\s\S]*a prompt[\s\S]*reply B/,
  );

  const behindPending = makeRenderer();
  behindPending.renderer.append(assistantFrame("a2", "msg_2", TEXT_B));
  behindPending.renderer.addBanner("interrupted");
  behindPending.renderer.resolve("u1" as never, userEntry("u1", "a prompt"));
  assert.match(
    renderedText(behindPending.container),
    /a prompt[\s\S]*reply B[\s\S]*interrupted/,
  );
});

test("resolve: the moved prefix carries the unkeyed items after the keyed one and stops at the next keyed item", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(assistantFrame("a1", "msg_1", TEXT_A));
  renderer.addBanner("interrupted");
  renderer.append(assistantFrame("a2", "msg_2", TEXT_B));
  renderer.resolve("a1" as never, assistantEntry("a1", "msg_1", TEXT_A));
  renderer.resolve("u3" as never, userEntry("u3", "a prompt"));
  assert.match(
    renderedText(container),
    /reply A[\s\S]*interrupted[\s\S]*a prompt[\s\S]*reply B/,
  );
});

test("resolve: a tool_use frame's tool item moves with its frame; the tool result's resolution moves nothing new", () => {
  const { renderer, container } = makeRenderer();
  const toolUse = [
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
  ];
  renderer.append(assistantFrame("a1", "msg_1", toolUse));
  renderer.append(toolResultMessage("t1", "listing"));
  renderer.append(assistantFrame("a2", "msg_2", TEXT_B));
  renderer.resolve("a1" as never, assistantEntry("a1", "msg_1", toolUse));
  renderer.resolve("u3" as never, userEntry("u3", "a prompt"));
  assert.match(renderedText(container), /ls[\s\S]*a prompt[\s\S]*reply B/);
  renderer.resolve("r1" as never, undefined);
  assert.match(renderedText(container), /ls[\s\S]*a prompt[\s\S]*reply B/);
});

test("message_stop on a stream nothing precedes releases the banners behind it", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(messageStart("msg_2"));
  renderer.append(textDelta("partial B"));
  renderer.addBanner("interrupted");
  renderer.append(assistantFrame("a2", "msg_2", TEXT_B));
  renderer.resolve("a2" as never, assistantEntry("a2", "msg_2", TEXT_B));
  // The stream, still open, holds the banner back from a2's resolution.
  renderer.resolve("u3" as never, userEntry("u3", "a later prompt"));
  assert.match(
    renderedText(container),
    /reply B[\s\S]*a later prompt[\s\S]*interrupted/,
  );
  renderer.append(messageStop());
  renderer.resolve("u4" as never, userEntry("u4", "a final prompt"));
  assert.match(
    renderedText(container),
    /reply B[\s\S]*a later prompt[\s\S]*interrupted[\s\S]*a final prompt/,
  );
});

test("resolve: an open stream stays pending and stops the prefix move; a file-only entry resolving meanwhile lands above it", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(assistantFrame("a1", "msg_1", TEXT_A));
  renderer.append(messageStart("msg_2"));
  renderer.append(textDelta("partial B"));
  renderer.resolve("a1" as never, assistantEntry("a1", "msg_1", TEXT_A));
  renderer.resolve("u3" as never, userEntry("u3", "a steer"));
  assert.match(
    renderedText(container),
    /reply A[\s\S]*a steer[\s\S]*partial B/,
  );
  renderer.append(assistantFrame("a2", "msg_2", TEXT_B));
  renderer.append(messageStop());
  renderer.resolve(
    "a2" as never,
    assistantEntry("a2", "msg_2", TEXT_B, "max_tokens"),
  );
  assert.equal(container.children.length, 3);
  assert.match(
    renderedText(container),
    /reply A[\s\S]*a steer[\s\S]*reply B[\s\S]*maximum output token limit/,
  );
});

test("resolve: an open stream with nothing pending is still pending; a banner after it moves with the last block's resolution", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(messageStart("msg_2"));
  renderer.append(textDelta("partial B"));
  renderer.addBanner("interrupted");
  renderer.resolve("u1" as never, userEntry("u1", "a prompt"));
  assert.match(
    renderedText(container),
    /a prompt[\s\S]*partial B[\s\S]*interrupted/,
  );
  renderer.append(assistantFrame("a2", "msg_2", TEXT_B));
  renderer.append(messageStop());
  renderer.resolve("a2" as never, assistantEntry("a2", "msg_2", TEXT_B));
  renderer.resolve("u3" as never, userEntry("u3", "a later prompt"));
  assert.match(
    renderedText(container),
    /a prompt[\s\S]*reply B[\s\S]*interrupted[\s\S]*a later prompt/,
  );
});

test("resolve: a user frame that rendered text still takes its entry's tool-result enrichment", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(
    assistantMessage([
      {
        type: "tool_use",
        id: "e1",
        name: "Edit",
        input: {
          file_path: "/repo/src/a.ts",
          old_string: "old line",
          new_string: "new line one\nnew line two",
        },
      },
    ]),
  );
  const toolResult = {
    type: "tool_result",
    tool_use_id: "e1",
    content: "updated",
  };
  const frame = userMessage([{ type: "text", text: "and a note" }, toolResult]);
  renderer.append(frame);
  assert.match(renderedText(container), /and a note/);
  renderer.resolve(
    frame.uuid as never,
    sessionEntry({
      type: "user",
      uuid: frame.uuid,
      message: { role: "user", content: [toolResult] },
      toolUseResult: {
        structuredPatch: [
          {
            oldStart: 4,
            oldLines: 1,
            newStart: 4,
            newLines: 2,
            lines: ["-old line", "+new line one", "+new line two"],
          },
        ],
      },
    }),
  );
  const text = renderedText(container);
  assert.match(text, /4 -old line/);
  assert.equal(text.match(/and a note/g)?.length, 1);
});

test("compact summary: collapsed one-liner, full markdown when expanded", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendEntry(boundaryEntry("b1", "cs1"));
  renderer.appendEntry(summaryEntry("cs1"));
  assert.match(
    renderedText(container),
    /Compacted \(ctrl\+o to see full summary\)/,
  );
  assert.doesNotMatch(renderedText(container), /All the context\./);
  renderer.setCompactSummaryExpanded(true);
  const text = renderedText(container);
  assert.match(text, /Summary/);
  assert.match(text, /All the context\./);
  // Markdown-rendered (heading marker stripped), not a \u276f prompt block.
  assert.doesNotMatch(text, /##/);
  assert.doesNotMatch(text, /\u276f/u);
  renderer.setCompactSummaryExpanded(false);
  assert.doesNotMatch(renderedText(container), /All the context\./);
});

// Phase 3 (docs/specs/query-pending-list/phase-3-identity.md): a dequeue
// echo's user turn is one item that its entry re-renders in place.
test("resolve: a dequeue echo's user turn is replaced in place by its entry, keeping attached output and expansion", () => {
  const { renderer, container } = makeRenderer();
  const echo = userMessage(
    "<command-name>/login</command-name><command-message>login</command-message><command-args></command-args>",
  );
  renderer.append(echo);
  renderer.append({
    type: "system",
    subtype: "local_command_output",
    uuid: "o1",
    content: "Login successful",
  } as unknown as SDKMessage);
  renderer.setToolsExpanded(true);
  const childrenBefore = container.children.length;
  renderer.resolve(
    echo.uuid as never,
    sessionEntry({
      type: "user",
      uuid: echo.uuid,
      message: {
        role: "user",
        content:
          "<command-name>/login</command-name><command-message>login</command-message><command-args>--sso</command-args>",
      },
    }),
  );
  assert.equal(container.children.length, childrenBefore);
  const lines = renderedText(container).split("\n");
  assert.equal(lines[0], "❯ /login --sso");
  assert.match(lines[1]!, /Login successful/);
  assert.equal(renderedText(container).match(/Login successful/g)?.length, 1);
  renderer.setToolsExpanded(false);
  assert.match(
    renderedText(container).split("\n")[1]!,
    /⤷ {2}Login successful/u,
  );
});

test("resolve: a steer's echo is replaced by its queued_command attachment under the source uuid", () => {
  const { renderer, container } = makeRenderer();
  const steer = userMessage("also say QUEUD");
  renderer.append(steer);
  assert.match(renderedText(container), /also say QUEUD/);
  renderer.resolve(
    steer.uuid as never,
    sessionEntry({
      type: "attachment",
      uuid: "q1",
      attachment: {
        type: "queued_command",
        prompt: "also say QUEUED",
        source_uuid: steer.uuid,
      },
    }),
  );
  assert.equal(container.children.length, 1);
  assert.match(renderedText(container), /❯ also say QUEUED/);
  assert.doesNotMatch(renderedText(container), /QUEUD/);
});

test("resolve: a merged run's echo is replaced by the entry's joined text", () => {
  const { renderer, container } = makeRenderer();
  const run = userMessage("first\nsecond");
  renderer.append(run);
  renderer.resolve(
    run.uuid as never,
    sessionEntry({
      type: "user",
      uuid: run.uuid,
      message: { role: "user", content: "first\nsecond\nthird" },
    }),
  );
  assert.equal(container.children.length, 1);
  assert.match(renderedText(container), /first[\s\S]*second[\s\S]*third/);
  assert.equal(renderedText(container).match(/first/g)?.length, 1);
});
