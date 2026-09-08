import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentState, AgentEvent } from "../core/protocol/index.ts";
import { initialAgentState } from "../core/agent-state/index.ts";
import { EventFormatter } from "./events.ts";
import type { MessageFormatOptions, TailRecord } from "./types.ts";

const OPTIONS: MessageFormatOptions = {
  toolResults: "summary",
  maxToolArgChars: 120,
  maxErrorLines: 10,
};

const uuidN = (n: number): UUID =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/** A prompt stamped `uuidN(n)` — the uuid its entry and dequeue carry. */
function prompt(text: string, n: number): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: uuidN(n),
  };
}

function snapshotRecord(agentState: Partial<AgentState> = {}): TailRecord {
  return { snapshot: { ...initialAgentState(), ...agentState } };
}

function event(sdkEvent: AgentEvent): TailRecord {
  return { event: sdkEvent };
}

/** Concatenated incremental output — what `format events` writes. */
function format(records: TailRecord[]): string {
  const formatter = new EventFormatter(OPTIONS);
  let output = "";
  for (const record of records) {
    output += formatter.push(record);
  }
  return output + formatter.end();
}

test("snapshot renders a header with the observed fields", () => {
  const output = format([
    snapshotRecord({
      activity: "idle",
      model: "claude-fable-5",
      permissionMode: "auto",
      querySessionId: "28972c69-0000-4000-8000-000000000000",
    }),
  ]);
  assert.equal(
    output,
    "[snapshot: idle, model claude-fable-5, permissions auto, session 28972c69-0000-4000-8000-000000000000]\n",
  );
});

test("snapshot omits unobserved fields and lists queued prompts", () => {
  const output = format([
    snapshotRecord({
      activity: "pending",
      queuedMessages: [{ uuid: uuidN(3), message: prompt("queued text", 3) }],
    }),
  ]);
  assert.equal(
    output,
    `[snapshot: pending]\n[queued ${uuidN(3)}: queued text]\n`,
  );
});

test("queued prompts render one-line truncated, full at dequeue", () => {
  const long = `start ${"x".repeat(100)}`;
  const output = format([
    event({
      kind: "userMessageQueued",
      uuid: uuidN(10),
      message: prompt(long, 3),
    }),
    event({ kind: "userMessageDequeued", delivery: "turn", uuids: [uuidN(3)] }),
  ]);
  const [queuedChunk, dequeuedChunk] = output.split("\n\n");
  const [queuedHeader, queuedLine] = queuedChunk!.split("\n");
  assert.equal(queuedHeader, `[event ${uuidN(10)}]`);
  assert.match(
    queuedLine!,
    /^\[queued 0{8}-0{4}-0{4}-0{4}-0{11}3: start x+…\]$/u,
  );
  // The whole bracketed content truncates, so the line width is fixed
  // regardless of how wide the uuid prefix is.
  assert.equal(queuedLine!.length, "[]".length + 80);
  assert.equal(
    dequeuedChunk,
    `[event ${uuidN(3)}]\n[dequeued (turn): ${uuidN(3)}]\n== user ==\n${long}\n`,
  );
});

test("snapshot queued messages seed the dequeue store", () => {
  const output = format([
    snapshotRecord({
      queuedMessages: [{ uuid: uuidN(7), message: prompt("from snapshot", 7) }],
    }),
    event({
      kind: "userMessageDequeued",
      delivery: "steer",
      uuids: [uuidN(7)],
    }),
  ]);
  assert.ok(
    output.endsWith(
      `[dequeued (steer): ${uuidN(7)}]\n== user ==\nfrom snapshot\n`,
    ),
  );
});

test("a merged run's dequeue renders the one joined message", () => {
  const run = format([
    event({
      kind: "userMessageQueued",
      uuid: uuidN(11),
      message: prompt("first", 1),
    }),
    event({
      kind: "userMessageQueued",
      uuid: uuidN(12),
      message: prompt("second", 2),
    }),
    event({
      kind: "userMessageDequeued",
      delivery: "turn",
      uuids: [uuidN(1), uuidN(2)],
    }),
  ]);
  assert.ok(
    run.endsWith(
      `[dequeued (turn): ${uuidN(1)}, ${uuidN(2)}]\n== user ==\nfirst\nsecond\n`,
    ),
  );
});

test("a new snapshot supersedes remembered queued messages", () => {
  const output = format([
    event({
      kind: "userMessageQueued",
      uuid: uuidN(11),
      message: prompt("stale", 1),
    }),
    snapshotRecord({ queuedMessages: [] }),
    event({ kind: "userMessageDequeued", delivery: "turn", uuids: [uuidN(1)] }),
  ]);
  assert.ok(output.endsWith(`[dequeued (turn): ${uuidN(1)}]\n`));
  assert.doesNotMatch(output, /== user ==/u);
});

test("control details with newlines or excess length are one-lined", () => {
  const output = format([
    event({
      kind: "controlApplied",
      uuid: uuidN(11),
      request: {
        type: "set-model",
        model: `spread\nover ${"x".repeat(100)}`,
      } as never,
    }),
  ]);
  assert.match(
    output,
    /^\[event [0-9a-f-]+\]\n\[control: set-model spread over x+…\]\n$/u,
  );
});

test("a dequeue of an unremembered uuid degrades to the annotation alone, under the run key", () => {
  const output = format([
    event({
      kind: "userMessageDequeued",
      delivery: "append",
      uuids: [uuidN(1), uuidN(2)],
    }),
  ]);
  assert.equal(
    output,
    `[event ${uuidN(2)}]\n[dequeued (append): ${uuidN(1)}, ${uuidN(2)}]\n`,
  );
});

test("compact/interrupt/control events render one-liners under their stamped uuid", () => {
  const output = format([
    event({
      kind: "compactSent",
      uuid: uuidN(11),
      message: prompt("/compact", 1),
    }),
    event({ kind: "interruptSent", uuid: uuidN(12) }),
    event({
      kind: "controlApplied",
      uuid: uuidN(13),
      request: { type: "set-model", model: "claude-opus-4-8" },
    }),
    event({
      kind: "controlApplied",
      uuid: uuidN(14),
      request: { type: "reload-skills" },
    }),
    event({
      kind: "controlApplied",
      uuid: uuidN(15),
      request: {
        type: "set-mcp-servers",
        servers: { srv: { type: "stdio", command: "run" } },
      },
    }),
  ]);
  assert.equal(
    output,
    `[event ${uuidN(11)}]\n[compact sent]\n\n[event ${uuidN(12)}]\n[interrupt sent]\n\n` +
      `[event ${uuidN(13)}]\n[control: set-model claude-opus-4-8]\n\n` +
      `[event ${uuidN(14)}]\n[control: reload-skills]\n\n` +
      `[event ${uuidN(15)}]\n[control: set-mcp-servers {"servers":{"srv":{"type":"stdio","command":"run"}}}]\n`,
  );
});

test("contextChanged renders its boundary, with the metadata of a seen boundary entry", () => {
  const boundary = "28972c69-9dd5-4524-bb56-d8aaeb982094";
  const unseen = "aaaaaaaa-0000-4000-8000-000000000000";
  const output = format([
    event({
      kind: "contextChanged",
      uuid: uuidN(11),
      boundary: unseen,
      leaf: null,
    }),
    event({
      kind: "sessionEntry",
      entry: {
        type: "system",
        subtype: "compact_boundary",
        uuid: boundary,
        compactMetadata: { trigger: "manual", preTokens: 1234 },
      },
      expectsSdkMessage: true,
      leaf: { uuid: boundary },
      awaitingAnchors: [],
    }),
    event({
      kind: "contextChanged",
      uuid: uuidN(12),
      boundary,
      leaf: { uuid: boundary },
    }),
  ]);
  assert.equal(
    output,
    `[event ${uuidN(11)}]\n[context changed: boundary ${unseen}]\n\n` +
      `[event ${boundary}]\n[entry ${boundary} system/compact_boundary sdk twin leaf ${boundary}]\n\n` +
      `[event ${uuidN(12)}]\n[context changed: boundary ${boundary}, manual, 1234 preTokens]\n`,
  );
});

test("sessionEntry renders identity only, untruncated", () => {
  const uuid = "bbbbbbbb-0000-4000-8000-000000000000";
  const leaf = "cccccccc-0000-4000-8000-000000000000";
  const output = format([
    event({
      kind: "sessionEntry",
      entry: {
        type: "attachment",
        uuid,
        attachment: { type: "queued_command", prompt: "x".repeat(200) },
      },
      expectsSdkMessage: false,
      leaf: { uuid: leaf },
      awaitingAnchors: [],
    }),
  ]);
  assert.equal(
    output,
    `[event ${uuid}]\n[entry ${uuid} attachment session-only leaf ${leaf}]\n`,
  );
});

test("sdkMessage events flow through the shared message renderer; a uuid-less message prints under its stamp", () => {
  const output = format([
    event({
      kind: "sdkMessage",
      uuid: uuidN(11),
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
  assert.equal(output, `[event ${uuidN(11)}]\n== assistant ==\nhi\n`);
});

test("snapshot lists live tasks and pending asks, main before task, with the task suffix", () => {
  const request = {
    toolUseId: "toolu_main",
    toolName: "Bash",
    input: { command: "ls -la", description: "list" },
    suggestions: [],
  };
  const output = format([
    snapshotRecord({
      activity: "working",
      pendingPermissions: [request],
      tasks: [
        {
          taskId: "t1",
          description: "explore repo",
          background: true,
          status: "running",
          pendingPermissions: [
            {
              ...request,
              toolUseId: "toolu_task",
              toolName: "Read",
              input: { file_path: "/x" },
            },
          ],
        },
      ],
    }),
  ]);
  assert.equal(
    output,
    [
      "[snapshot: working]",
      "[task t1: explore repo]",
      "[pending permission toolu_main: Bash command: ls -la]",
      "[pending permission toolu_task: Read file_path: /x (task t1)]",
      "",
    ].join("\n"),
  );
});

test("permission events render one-liners with the resolution summarised", () => {
  const request = {
    toolUseId: "toolu_1",
    toolName: "ExitPlanMode",
    input: {},
    suggestions: [],
  };
  const output = format([
    event({ kind: "permissionRequested", uuid: uuidN(20), request }),
    event({
      kind: "permissionResolved",
      uuid: uuidN(21),
      toolUseId: "toolu_1",
      resolution: {
        behavior: "allow",
        updatedPermissions: [
          { type: "setMode", mode: "acceptEdits", destination: "session" },
        ],
      },
    }),
    event({
      kind: "permissionResolved",
      uuid: uuidN(22),
      toolUseId: "toolu_1",
      resolution: { behavior: "deny", message: "no" },
    }),
    event({
      kind: "permissionResolved",
      uuid: uuidN(23),
      toolUseId: "toolu_1",
      resolution: { behavior: "cancelled" },
    }),
  ]);
  assert.equal(
    output,
    [
      `[event ${uuidN(20)}]\n[permission requested toolu_1: ExitPlanMode {}]`,
      `[event ${uuidN(21)}]\n[permission resolved toolu_1: allow + 1 permission updates]`,
      `[event ${uuidN(22)}]\n[permission resolved toolu_1: deny: no]`,
      `[event ${uuidN(23)}]\n[permission resolved toolu_1: cancelled]\n`,
    ].join("\n\n"),
  );
});
