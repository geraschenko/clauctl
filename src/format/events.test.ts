import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState } from "../core/agent-state.ts";
import { INITIAL_AGENT_STATE } from "../core/agent-state.ts";
import type { SdkEvent } from "../core/sdk-socket.ts";
import { formatTailRecords } from "./events.ts";
import type { MessageFormatOptions, TailRecord } from "./types.ts";

const OPTIONS: MessageFormatOptions = {
  toolResults: "summary",
  maxToolArgChars: 120,
  maxErrorLines: 10,
};

function prompt(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

function snapshotRecord(agentState: Partial<AgentState> = {}): TailRecord {
  return { snapshot: { ...INITIAL_AGENT_STATE, ...agentState } };
}

function event(sdkEvent: SdkEvent): TailRecord {
  return { event: sdkEvent };
}

function format(records: TailRecord[]): string {
  return formatTailRecords(records, OPTIONS);
}

test("snapshot renders a header with the observed fields", () => {
  const output = format([
    snapshotRecord({
      activity: "idle",
      model: "claude-fable-5",
      permissionMode: "auto",
      sessionId: "28972c69",
    }),
  ]);
  assert.equal(
    output,
    "[snapshot: idle, model claude-fable-5, permissions auto, session 28972c69]\n",
  );
});

test("snapshot omits unobserved fields and lists queued/delivered prompts", () => {
  const output = format([
    snapshotRecord({
      activity: "pending",
      queuedMessages: [{ id: 3, message: prompt("queued text") }],
      deliveredMessages: [prompt("delivered text")],
    }),
  ]);
  assert.equal(
    output,
    "[snapshot: pending]\n[queued #3: queued text]\n[delivered: delivered text]\n",
  );
});

test("queued prompts render one-line truncated, full at dequeue", () => {
  const long = `start ${"x".repeat(100)}`;
  const output = format([
    event({ kind: "userMessageQueued", id: 3, message: prompt(long) }),
    event({ kind: "userMessageDequeued", delivery: "turn", ids: [3] }),
  ]);
  const [queuedChunk, dequeuedChunk] = output.split("\n\n");
  assert.match(queuedChunk!, /^\[queued #3: start x+…\]$/u);
  // The whole bracketed content truncates, so the line width is fixed
  // regardless of how wide the id prefix is.
  assert.equal(queuedChunk!.length, "[]".length + 80);
  assert.equal(dequeuedChunk, `[dequeued (turn): #3]\n== user ==\n${long}\n`);
});

test("snapshot queued messages seed the dequeue store", () => {
  const output = format([
    snapshotRecord({
      queuedMessages: [{ id: 7, message: prompt("from snapshot") }],
    }),
    event({ kind: "userMessageDequeued", delivery: "steer", ids: [7] }),
  ]);
  assert.match(
    output,
    /\[dequeued \(steer\): #7\]\n== user ==\nfrom snapshot\n$/u,
  );
});

test("a merged-bucket dequeue separates its messages as records", () => {
  const output = format([
    event({ kind: "userMessageQueued", id: 1, message: prompt("first") }),
    event({ kind: "userMessageQueued", id: 2, message: prompt("second") }),
    event({ kind: "userMessageDequeued", delivery: "turn", ids: [1, 2] }),
  ]);
  assert.match(
    output,
    /\[dequeued \(turn\): #1, #2\]\n== user ==\nfirst\n\n== user ==\nsecond\n$/u,
  );
});

test("a new snapshot supersedes remembered queued messages", () => {
  const output = format([
    event({ kind: "userMessageQueued", id: 1, message: prompt("stale") }),
    snapshotRecord({ queuedMessages: [] }),
    event({ kind: "userMessageDequeued", delivery: "turn", ids: [1] }),
  ]);
  assert.match(output, /\[dequeued \(turn\): #1\]\n$/u);
  assert.doesNotMatch(output, /== user ==/u);
});

test("control details with newlines or excess length are one-lined", () => {
  const output = format([
    event({
      kind: "controlApplied",
      request: {
        type: "set-model",
        model: `spread\nover ${"x".repeat(100)}`,
      } as never,
    }),
  ]);
  assert.match(output, /^\[control: set-model spread over x+…\]\n$/u);
});

test("a dequeue of an unremembered id degrades to the annotation alone", () => {
  const output = format([
    event({ kind: "userMessageDequeued", delivery: "append", ids: [1, 2] }),
  ]);
  assert.equal(output, "[dequeued (append): #1, #2]\n");
});

test("compact/interrupt/control events render one-liners", () => {
  const output = format([
    event({ kind: "compactSent", message: prompt("/compact") }),
    event({ kind: "interruptSent" }),
    event({
      kind: "controlApplied",
      request: { type: "set-model", model: "claude-opus-4-8" },
    }),
    event({
      kind: "controlApplied",
      request: { type: "reload-skills" },
    }),
    event({
      kind: "controlApplied",
      request: {
        type: "set-mcp-servers",
        servers: { srv: { type: "stdio", command: "run" } },
      },
    }),
  ]);
  assert.equal(
    output,
    "[compact sent]\n\n[interrupt sent]\n\n" +
      "[control: set-model claude-opus-4-8]\n\n[control: reload-skills]\n\n" +
      '[control: set-mcp-servers {"servers":{"srv":{"type":"stdio","command":"run"}}}]\n',
  );
});

test("contextChanged renders a request one-liner", () => {
  const output = format([
    event({
      kind: "contextChanged",
      request: {
        type: "set-context",
        rewindTo: { uuid: "28972c69-9dd5-4524-bb56-d8aaeb982094" },
      },
      leaf: null,
    }),
  ]);
  // rewindTo is structured, so the annotation takes the JSON fallback (and
  // the 80-char annotation truncation).
  assert.equal(
    output,
    '[context changed: set-context {"rewindTo":{"uuid":"28972c69-9dd5-4524-bb56-d8aae…]\n',
  );
});

test("sdkMessage events flow through the shared message renderer", () => {
  const output = format([
    event({
      kind: "sdkMessage",
      message: {
        type: "assistant",
        message: {
          role: "assistant",
          model: "m",
          content: [{ type: "text", text: "hi" }],
          stop_reason: null,
        },
      } as never,
    }),
  ]);
  assert.equal(output, "== assistant ==\nhi\n");
});
