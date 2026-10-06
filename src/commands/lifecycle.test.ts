import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { initialAgentState } from "../core/agent-state/index.ts";
import type {
  AgentEvent,
  ProtocolRequest,
  AgentState,
} from "../core/protocol/index.ts";
import {
  RESPONSE_SENT,
  startProtocolServer,
} from "../core/protocol-server/index.ts";
import { stopRunningAgent } from "./lifecycle.ts";
import {
  agentSocketPath,
  isPidAlive,
  type AgentRecord,
} from "../core/registry.ts";

const dir = mkdtempSync(join(tmpdir(), "clauctl-lifecycle-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in daemon: exits on SIGTERM like the real one. */
function spawnIdleProcess(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  return new Promise((resolve) =>
    child.once("spawn", () => resolve(child.pid!)),
  );
}

test("archive stops a daemon whose socket speaks a foreign protocol", async () => {
  const agentDir = join(dir, "foreign");
  const socketPath = agentSocketPath(agentDir);
  mkdirSync(agentDir);
  const server = createServer((socket) => {
    socket.write(
      '{"type":"hello","protocol":"clauctl-sdk-socket","version":1}\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const daemonPid = await spawnIdleProcess();
  const agent: AgentRecord = {
    id: "foreign",
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
    persistedOptions: {},
    sessions: [],
    daemonPid,
    attachments: [],
    agentDir,
  };
  const stderrWrites: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await stopRunningAgent(agent, undefined);
  } finally {
    process.stderr.write = originalWrite;
    server.close();
  }
  assert.equal(isPidAlive(daemonPid), false);
  assert.match(stderrWrites.join(""), /not a clauctl agent socket/);
});

const record = (
  id: string,
  agentDir: string,
  daemonPid: number,
): AgentRecord => ({
  id,
  createdAt: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp",
  persistedOptions: {},
  sessions: [],
  daemonPid,
  attachments: [],
  agentDir,
});

test("archive interrupts a pending ask, and a re-ask after it, then stops once quiescent", async () => {
  const agentDir = join(dir, "asking");
  mkdirSync(agentDir);
  // The main agent's own tool call waits on its ask, a prompt queued behind
  // it: input-needed with an ask.
  const queuedUuid = crypto.randomUUID();
  const asking: AgentState = {
    ...initialAgentState(),
    activity: "working",
    queuedMessages: [
      {
        uuid: queuedUuid,
        message: {
          type: "user",
          message: { role: "user", content: "next" },
          parent_tool_use_id: null,
        },
      },
    ],
    unresolvedToolUses: ["toolu_ask"],
    pendingPermissions: [
      {
        toolUseId: "toolu_ask",
        toolName: "Bash",
        input: {},
        arrivedAt: 0,
        suggestions: [],
      },
    ],
  };
  const sdkMessage = (message: Record<string, unknown>): AgentEvent => ({
    kind: "sdkMessage",
    uuid: crypto.randomUUID(),
    message: message as unknown as SDKMessage,
  });
  // An interrupt cancels the ask and ends the turn.
  const cancelled = (toolUseId: string): AgentEvent[] => [
    {
      kind: "permissionResolved",
      uuid: crypto.randomUUID(),
      toolUseId,
      resolution: { behavior: "cancelled" },
    },
    sdkMessage({ type: "result" }),
  ];
  // The queued prompt runs after the interrupt and asks again; the second
  // interrupt leaves the agent quiescent.
  const afterInterrupt: AgentEvent[][] = [
    [
      ...cancelled("toolu_ask"),
      { kind: "userMessageDequeued", delivery: "turn", uuids: [queuedUuid] },
      sdkMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_use", id: "toolu_reask", name: "Bash" }],
        },
      }),
      {
        kind: "permissionRequested",
        uuid: crypto.randomUUID(),
        request: {
          toolUseId: "toolu_reask",
          toolName: "Bash",
          input: {},
          arrivedAt: 0,
          suggestions: [],
        },
      },
    ],
    cancelled("toolu_reask"),
  ];
  const requests: ProtocolRequest["type"][] = [];
  const server = startProtocolServer(
    agentSocketPath(agentDir),
    (request, connection) => {
      requests.push(request.type);
      if (request.type === "subscribe") {
        connection.write(
          `${JSON.stringify({ id: request.id, ok: true, data: asking })}\n`,
        );
        return Promise.resolve(RESPONSE_SENT);
      }
      if (request.type === "interrupt") {
        connection.write(
          (afterInterrupt.shift() ?? [])
            .map((event) => `${JSON.stringify({ event })}\n`)
            .join(""),
        );
      }
      return Promise.resolve(undefined);
    },
  );
  const daemonPid = await spawnIdleProcess();
  try {
    await stopRunningAgent(record("asking", agentDir, daemonPid), 5_000);
  } finally {
    server.close();
  }
  assert.deepEqual(requests, ["subscribe", "interrupt", "interrupt"]);
  assert.equal(isPidAlive(daemonPid), false);
});
