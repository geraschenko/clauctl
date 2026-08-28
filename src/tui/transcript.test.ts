import assert from "node:assert/strict";
import { test } from "node:test";
import { Container } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PathNode } from "../core/tree/nodes.ts";
import { TranscriptRenderer } from "./transcript.ts";

// The Edit view's expanded diff reads pi's theme singleton; the TUI
// entrypoints initialize it the same way.
initTheme("dark");

// The renderer only inspects the fields the conversions read
// (sdk-render.ts), so partial stubs cast through unknown suffice — the same
// fixture style as sdk-render.test.ts. Shapes are carved from real session
// jsonl entries, reduced to the minimum.

function assistantMessage(
  content: unknown[],
  parentToolUseId: string | null = null,
): SDKMessage {
  return {
    type: "assistant",
    uuid: "a-uuid",
    parent_tool_use_id: parentToolUseId,
    message: { content, stop_reason: null },
  } as unknown as SDKMessage;
}

function userMessage(content: unknown): SDKUserMessage {
  return {
    type: "user",
    uuid: "u-uuid",
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

function pathNode(entry: Record<string, unknown>): PathNode {
  return { ref: { uuid: entry.uuid }, entry } as unknown as PathNode;
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

test("append(user) never renders prompt text; appendUserTurn does", () => {
  const { renderer, container } = makeRenderer();
  renderer.append(userMessage("a live prompt") as SDKMessage);
  assert.equal(renderedText(container), "");
  renderer.appendUserTurn(userMessage("a live prompt"));
  assert.match(renderedText(container), /a live prompt/);
});

test("appendUserTurn with no visible text renders nothing", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendUserTurn(userMessage([{ type: "image", source: {} }]));
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
  renderer.append(streamEvent({ type: "message_start" }));
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
  renderer.append(assistantMessage([{ type: "text", text: "final text" }]));
  const text = renderedText(container);
  assert.match(text, /final text/);
  assert.doesNotMatch(text, /partial/);
  // One component: the finalizing message replaced the streaming content.
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

test("appendPathNode: boundary banner, user prompt + result resolution, assistant", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendPathNode(
    pathNode({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "replayed prompt" },
    }),
  );
  renderer.appendPathNode(
    pathNode({
      type: "assistant",
      uuid: "a1",
      message: {
        content: [{ type: "tool_use", id: "tool-9", name: "Grep", input: {} }],
        stop_reason: "tool_use",
      },
    }),
  );
  renderer.appendPathNode(
    pathNode({
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
  renderer.appendPathNode(
    pathNode({
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
  renderer.appendPathNode(
    pathNode({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 156_000 },
    }),
  );
  renderer.appendPathNode(
    pathNode({ type: "system", subtype: "compact_boundary" }),
  );
  const text = renderedText(container);
  assert.match(text, /context compacted \(156k tokens\)/);
  assert.match(text, /context compacted$/m);
});

test("appendPathNode skips meta and sidechain entries", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendPathNode(
    pathNode({
      type: "user",
      uuid: "m1",
      isMeta: true,
      message: { role: "user", content: "meta noise" },
    }),
  );
  renderer.appendPathNode(
    pathNode({
      type: "user",
      uuid: "s1",
      isSidechain: true,
      message: { role: "user", content: "sidechain noise" },
    }),
  );
  assert.equal(container.children.length, 0);
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
  renderer.appendPathNode(
    pathNode({
      type: "user",
      uuid: "u1",
      timestamp: at(0),
      message: { role: "user", content: "read both files" },
    }),
  );
  renderer.appendPathNode(
    pathNode({
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
  renderer.appendPathNode(
    pathNode({
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
  renderer.appendPathNode(
    pathNode({
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
  renderer.appendPathNode(
    pathNode({
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
  renderer.appendPathNode(
    pathNode({
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
  renderer.appendPathNode(
    pathNode({
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
  renderer.appendUserTurn(
    userMessage("keep **bold** and `code` markers verbatim in this prompt"),
  );
  renderer.append(assistantMessage([{ type: "text", text: "Sure thing" }]));
  const lines = container.render(40).map((line) =>
    line
      // eslint-disable-next-line no-control-regex
      .replaceAll(/\u001b\][^\u0007]*\u0007|\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .trimEnd(),
  );
  // Inline markdown markers are consumed (claude 2.1.250 behavior) and the
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

test("slash command with stdout renders a \u276f command block with \u23bf output", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendPathNode(
    pathNode({
      type: "system",
      subtype: "local_command",
      content:
        "<command-name>/login</command-name>\n            <command-message>login</command-message>\n            <command-args></command-args>",
    }),
  );
  renderer.appendPathNode(
    pathNode({
      type: "system",
      subtype: "local_command",
      content: "<local-command-stdout>Login successful</local-command-stdout>",
    }),
  );
  const lines = renderedText(container).split("\n");
  assert.equal(lines[0], "\u276f /login");
  assert.match(lines[1]!, /\u23bf\s+Login successful/u);
});

test("/compact stdout and 'No response requested.' are hidden", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendUserTurn(
    userMessage(
      "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>",
    ),
  );
  renderer.appendPathNode(
    pathNode({
      type: "system",
      subtype: "local_command",
      content:
        "<local-command-stdout>Not enough messages to compact.</local-command-stdout>",
    }),
  );
  renderer.append(
    assistantMessage([{ type: "text", text: "No response requested." }]),
  );
  assert.equal(renderedText(container), "\u276f /compact");
});

test("bash passthrough: \u276f ! command with unescaped collapsed output", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendUserTurn(
    userMessage("<bash-input>git show HEAD</bash-input>"),
  );
  renderer.appendUserTurn(
    userMessage(
      "<bash-stdout>Author: A &lt;a@b.c&gt;</bash-stdout><bash-stderr></bash-stderr>",
    ),
  );
  const lines = renderedText(container).split("\n");
  assert.equal(lines[0], "\u276f ! git show HEAD");
  assert.match(lines[1]!, /\u23bf\s+Author: A <a@b\.c>/u);
});

test("compact summary: collapsed one-liner, full markdown when expanded", () => {
  const { renderer, container } = makeRenderer();
  renderer.appendPathNode(
    pathNode({
      type: "user",
      uuid: "cs1",
      isCompactSummary: true,
      message: { role: "user", content: "## Summary\n\nAll the context." },
    }),
  );
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
