import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { initialAgentState } from "../agent-state/agent-state.ts";
import type { AgentEvent } from "../protocol.ts";
import { AnomalyRecorder } from "./anomaly-bundle.ts";

function sdkMessage(fields: Record<string, unknown>): AgentEvent {
  return { kind: "sdkMessage", message: fields as unknown as SDKMessage };
}

function writeBundle(recorder: AnomalyRecorder, dir: string): unknown {
  const path = recorder.write(
    { kind: "head-mismatch", detail: "x" },
    initialAgentState(),
    initialAgentState(),
  );
  return JSON.parse(readFileSync(join(dir, path.split("/").at(-1)!), "utf8"));
}

test("the ring skips stream events and subagent traffic; assistant frames and entries carry their API message id and parent", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "clauctl-anomaly-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recorder = new AnomalyRecorder(dir);
  const uuid = randomUUID();
  const parentUuid = randomUUID();
  recorder.record(
    sdkMessage({ type: "stream_event", parent_tool_use_id: null }),
  );
  recorder.record(
    sdkMessage({
      type: "assistant",
      uuid: randomUUID(),
      parent_tool_use_id: "toolu_task",
      message: { id: "msg_sub" },
    }),
  );
  recorder.record(
    sdkMessage({
      type: "user",
      uuid: randomUUID(),
      parent_tool_use_id: "toolu_task",
      message: { role: "user", content: [] },
    }),
  );
  recorder.record(
    sdkMessage({
      type: "assistant",
      uuid,
      session_id: "s",
      parent_tool_use_id: null,
      message: { id: "msg_1" },
    }),
  );
  recorder.record({
    kind: "sessionEntry",
    uuid,
    expectsSdkMessage: true,
    leaf: null,
    awaitingAnchors: [],
    entry: {
      uuid,
      parentUuid,
      type: "assistant",
      message: { id: "msg_1", role: "assistant", content: [] },
    },
  });
  const bundle = writeBundle(recorder, dir) as {
    recentEvents: Record<string, unknown>[];
  };
  assert.deepEqual(bundle.recentEvents, [
    {
      kind: "sdkMessage",
      type: "assistant",
      uuid,
      session_id: "s",
      apiMessageId: "msg_1",
    },
    {
      kind: "sessionEntry",
      type: "assistant",
      uuid,
      apiMessageId: "msg_1",
      parentUuid,
    },
  ]);
});
