import assert from "node:assert/strict";
import { test } from "node:test";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import type { UUID } from "node:crypto";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionEntry } from "../core/session/file.ts";
import type { TreeNodeRef } from "../core/tree/nodes.ts";
import {
  beginMessage,
  foldStreamEvent,
  pathUpToBoundary,
  releaseDedupeUuid,
  renderAssistant,
  toolResultsOf,
  userText,
  userTurnViews,
  userTurnViewsFromText,
  type StreamingMessage,
} from "./sdk-render.ts";

// The fold only inspects type/index/content_block/delta, so partial stubs
// cast through unknown suffice (message_start's full BetaMessage, usage
// fields, etc. are irrelevant to rendering).
function event(shape: Record<string, unknown>): BetaRawMessageStreamEvent {
  return shape as unknown as BetaRawMessageStreamEvent;
}

function textStart(index: number, text = ""): BetaRawMessageStreamEvent {
  return event({
    type: "content_block_start",
    index,
    content_block: { type: "text", text, citations: null },
  });
}

function textDelta(index: number, text: string): BetaRawMessageStreamEvent {
  return event({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

function thinkingStart(index: number): BetaRawMessageStreamEvent {
  return event({
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "", signature: "" },
  });
}

function thinkingDelta(
  index: number,
  thinking: string,
): BetaRawMessageStreamEvent {
  return event({
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking },
  });
}

function run(events: BetaRawMessageStreamEvent[]): StreamingMessage {
  return events.reduce(foldStreamEvent, beginMessage());
}

test("beginMessage starts empty", () => {
  assert.deepEqual(beginMessage().partial, { content: [] });
});

test("text deltas accumulate into one text block", () => {
  const streaming = run([
    event({ type: "message_start", message: {} }),
    textStart(0),
    textDelta(0, "Hello"),
    textDelta(0, ", world"),
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_stop" }),
  ]);
  assert.deepEqual(streaming.partial, {
    content: [{ type: "text", text: "Hello, world" }],
  });
});

test("thinking then text keeps block order", () => {
  const streaming = run([
    thinkingStart(0),
    thinkingDelta(0, "hmm"),
    thinkingDelta(0, "..."),
    textStart(1),
    textDelta(1, "answer"),
  ]);
  assert.deepEqual(streaming.partial, {
    content: [
      { type: "thinking", thinking: "hmm..." },
      { type: "text", text: "answer" },
    ],
  });
});

test("tool_use block renders from its start event; input_json deltas are not accumulated", () => {
  const streaming = run([
    event({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
    }),
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":' },
    }),
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"ls"}' },
    }),
  ]);
  assert.deepEqual(streaming.partial, {
    content: [{ type: "toolCall", id: "tu_1", name: "Bash", arguments: {} }],
  });
});

test("unknown block types leave a hole, not a corrupt index mapping", () => {
  const streaming = run([
    event({
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: "opaque" },
    }),
    textStart(1),
    textDelta(1, "visible"),
    // A delta addressed to the dropped block is ignored.
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig" },
    }),
  ]);
  assert.deepEqual(streaming.partial, {
    content: [{ type: "text", text: "visible" }],
  });
});

test("fold is pure: earlier states are not mutated", () => {
  const first = run([textStart(0), textDelta(0, "a")]);
  const second = foldStreamEvent(first, textDelta(0, "b"));
  assert.deepEqual(first.partial, { content: [{ type: "text", text: "a" }] });
  assert.deepEqual(second.partial, { content: [{ type: "text", text: "ab" }] });
});

test("mismatched delta type for an existing block is ignored", () => {
  const streaming = run([textStart(0), thinkingDelta(0, "not text")]);
  assert.deepEqual(streaming.partial, {
    content: [{ type: "text", text: "" }],
  });
});

test("an event type outside the SDK's declared union is ignored", () => {
  const streaming = run([
    textStart(0),
    textDelta(0, "hi"),
    event({ type: "content_block_ping", index: 0 }),
  ]);
  assert.deepEqual(streaming.partial, {
    content: [{ type: "text", text: "hi" }],
  });
});

function assistantMessage(
  content: unknown[],
  stopReason: string | null = null,
): SDKAssistantMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content, stop_reason: stopReason },
    parent_tool_use_id: null,
  } as unknown as SDKAssistantMessage;
}

test("renderAssistant maps text/thinking/tool_use and drops the rest", () => {
  const rendered = renderAssistant(
    assistantMessage([
      { type: "thinking", thinking: "hmm", signature: "s" },
      { type: "text", text: "hi", citations: null },
      { type: "tool_use", id: "tu_1", name: "Read", input: { path: "x" } },
      { type: "redacted_thinking", data: "opaque" },
    ]),
  );
  assert.deepEqual(rendered, {
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hi" },
      { type: "toolCall", id: "tu_1", name: "Read", arguments: { path: "x" } },
    ],
  });
});

test("renderAssistant maps API stop reasons onto pi-ai's StopReason", () => {
  const text = [{ type: "text", text: "hi", citations: null }];
  assert.equal(renderAssistant(assistantMessage(text)).stopReason, undefined);
  assert.equal(
    renderAssistant(assistantMessage(text, "end_turn")).stopReason,
    "stop",
  );
  assert.equal(
    renderAssistant(assistantMessage(text, "max_tokens")).stopReason,
    "length",
  );
  assert.equal(
    renderAssistant(assistantMessage(text, "tool_use")).stopReason,
    "toolUse",
  );
  const refused = renderAssistant(assistantMessage(text, "refusal"));
  assert.equal(refused.stopReason, "error");
  assert.equal(typeof refused.errorMessage, "string");
});

function sdkUserMessage(content: string | unknown[]): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage;
}

test("toolResultsOf extracts tool_result blocks with text flattening", () => {
  const results = toolResultsOf(
    sdkUserMessage([
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "plain output",
      },
      {
        type: "tool_result",
        tool_use_id: "tu_2",
        is_error: true,
        content: [
          { type: "text", text: "line one" },
          { type: "image", source: {} },
          { type: "text", text: "line two" },
        ],
      },
    ]),
  );
  assert.deepEqual(results, [
    { toolCallId: "tu_1", content: "plain output", isError: false },
    { toolCallId: "tu_2", content: "line one\nline two", isError: true },
  ]);
});

test("toolResultsOf is empty for plain user turns", () => {
  assert.deepEqual(toolResultsOf(sdkUserMessage("just text")), []);
  assert.deepEqual(
    toolResultsOf(sdkUserMessage([{ type: "text", text: "hi" }])),
    [],
  );
});

function uuid(n: number): UUID {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

function pathEntry(
  type: string,
  entryUuid: UUID,
  extra: Partial<SessionEntry> = {},
): SessionEntry {
  return { type, uuid: entryUuid, ...extra };
}

/** A root-first path of raw refs plus the byUuid lookup over its entries. */
function pathFixture(entries: SessionEntry[]): {
  path: TreeNodeRef[];
  byUuid: Map<UUID, SessionEntry>;
} {
  return {
    path: entries.map((entry) => ({ uuid: entry.uuid! })),
    byUuid: new Map(entries.map((entry) => [entry.uuid!, entry])),
  };
}

function pathUuids(refs: TreeNodeRef[]): UUID[] {
  return refs.map((ref) => ref.uuid);
}

test("pathUpToBoundary drops ordinary rows after the leaf row", () => {
  const { path, byUuid } = pathFixture([
    pathEntry("user", uuid(1)),
    pathEntry("assistant", uuid(2)),
    pathEntry("user", uuid(3)),
    pathEntry("assistant", uuid(4)),
  ]);
  const result = pathUpToBoundary(path, byUuid, { uuid: uuid(2) });
  assert.deepEqual(pathUuids(result.nodes), [uuid(1), uuid(2)]);
  assert.equal(result.boundaryMissing, false);
});

test("pathUpToBoundary keeps post-leaf boundary and summary rows", () => {
  // A native compaction landed between the state snapshot and the tree
  // read: the leaf is the pre-compaction assistant, and the display path
  // continues boundary → summary. Both replay (the banner keeps the
  // segment structurally complete; the summary's live user event renders
  // no text), the ordinary row after them drops (its live events render).
  const boundary = uuid(9);
  const { path, byUuid } = pathFixture([
    pathEntry("user", uuid(1)),
    pathEntry("assistant", uuid(2)),
    pathEntry("system", boundary, { subtype: "compact_boundary" }),
    pathEntry("user", uuid(8), {
      isCompactSummary: true,
      parentUuid: boundary,
    }),
    pathEntry("assistant", uuid(4)),
  ]);
  const result = pathUpToBoundary(path, byUuid, { uuid: uuid(2) });
  assert.deepEqual(pathUuids(result.nodes), [
    uuid(1),
    uuid(2),
    boundary,
    uuid(8),
  ]);
  assert.equal(result.boundaryMissing, false);
});

test("pathUpToBoundary without a leaf row returns the whole path", () => {
  const { path, byUuid } = pathFixture([pathEntry("user", uuid(1))]);
  assert.deepEqual(pathUpToBoundary(path, byUuid, undefined), {
    nodes: path,
    boundaryMissing: false,
  });
});

test("pathUpToBoundary with an absent leaf row returns everything, flagged", () => {
  const { path, byUuid } = pathFixture([pathEntry("user", uuid(1))]);
  assert.deepEqual(pathUpToBoundary(path, byUuid, { uuid: uuid(7) }), {
    nodes: path,
    boundaryMissing: true,
  });
});

test("releaseDedupeUuid covers exactly the kinds a path replay renders", () => {
  const withUuid = (shape: Record<string, unknown>): SDKMessage =>
    ({ ...shape, uuid: uuid(1) }) as unknown as SDKMessage;
  assert.equal(releaseDedupeUuid(withUuid({ type: "user" })), uuid(1));
  assert.equal(releaseDedupeUuid(withUuid({ type: "assistant" })), uuid(1));
  assert.equal(releaseDedupeUuid(withUuid({ type: "stream_event" })), uuid(1));
  assert.equal(
    releaseDedupeUuid(
      withUuid({ type: "system", subtype: "compact_boundary" }),
    ),
    uuid(1),
  );
  // Other system subtypes render content no replay produces — a uuid
  // collision must not swallow them.
  assert.equal(
    releaseDedupeUuid(
      withUuid({ type: "system", subtype: "local_command_output" }),
    ),
    undefined,
  );
  assert.equal(releaseDedupeUuid(withUuid({ type: "result" })), undefined);
});

test("userText handles string and block content", () => {
  assert.equal(userText(sdkUserMessage("hello")), "hello");
  assert.equal(
    userText(
      sdkUserMessage([
        { type: "image", source: {} },
        { type: "text", text: "with image" },
      ]),
    ),
    "with image",
  );
});

// userTurnViews fixtures are verbatim tag shapes from captured 2.1.211
// sessions (parity spec WORK LOG).

test("userTurnViews: plain prompt and tool-result carrier", () => {
  assert.deepEqual(userTurnViews(sdkUserMessage("just a question")), [
    { kind: "prompt", text: "just a question" },
  ]);
  assert.deepEqual(
    userTurnViews(
      sdkUserMessage([{ type: "tool_result", tool_use_id: "t", content: [] }]),
    ),
    [],
  );
});

test("userTurnViews: command tags in either order, args captured", () => {
  assert.deepEqual(
    userTurnViewsFromText(
      "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>",
    ),
    [{ kind: "slashCommand", command: "/compact", args: "" }],
  );
  assert.deepEqual(
    userTurnViewsFromText(
      "<command-message>spec</command-message>\n<command-name>/spec</command-name>\n<command-args>do the thing</command-args>",
    ),
    [{ kind: "slashCommand", command: "/spec", args: "do the thing" }],
  );
});

test("userTurnViews: local-command stdout and caveat", () => {
  assert.deepEqual(
    userTurnViewsFromText(
      "<local-command-stdout>Login successful</local-command-stdout>",
    ),
    [{ kind: "commandOutput", text: "Login successful" }],
  );
  assert.deepEqual(
    userTurnViewsFromText(
      "<local-command-caveat>Caveat: local commands.</local-command-caveat>",
    ),
    [],
  );
});

test("userTurnViews: bash passthrough with <>-only entity unescaping", () => {
  assert.deepEqual(
    userTurnViewsFromText("<bash-input>git show HEAD</bash-input>"),
    [{ kind: "bashInput", command: "git show HEAD" }],
  );
  assert.deepEqual(
    userTurnViewsFromText(
      "<bash-stdout>Author: A &lt;a@b.c&gt; & more</bash-stdout><bash-stderr></bash-stderr>",
    ),
    // & stays: the CLI escapes exactly < and > (empirical).
    [{ kind: "bashOutput", stdout: "Author: A <a@b.c> & more", stderr: "" }],
  );
});

test("userTurnViews: ide_selection then the real prompt", () => {
  assert.deepEqual(
    userTurnViewsFromText(
      "<ide_selection>The user selected lines 1 to 2.</ide_selection>\nWhat does it do?",
    ),
    [
      {
        kind: "contextTag",
        tag: "ide_selection",
        text: "The user selected lines 1 to 2.",
      },
      { kind: "prompt", text: "What does it do?" },
    ],
  );
});

test("userTurnViews: malformed known tag falls back to one verbatim prompt", () => {
  const malformed = "<bash-input>unclosed";
  assert.deepEqual(userTurnViewsFromText(malformed), [
    { kind: "prompt", text: malformed },
  ]);
  const unknownTag = "see <not-a-real-tag> in the docs";
  assert.deepEqual(userTurnViewsFromText(unknownTag), [
    { kind: "prompt", text: unknownTag },
  ]);
});
