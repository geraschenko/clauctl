/*
 * prompt's submission and gating paths (docs/specs/prompt-parity.md): detach
 * and --no-query fire-and-forget, the usage errors, the dequeue gate on both
 * the events and messages legs, the ungated /compact path, and the exit-code
 * classification (timeout → 3, close before condition → 1). The harness is
 * tail.test.ts's live-server pattern plus a query responder returning the
 * acceptance receipt; the daemon side of the receipt is covered in
 * request-handlers.test.ts.
 */

import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { INITIAL_AGENT_STATE, type AgentState } from "./agent-state.ts";
import { app } from "./app.ts";
import { RESPONSE_SENT, startSdkServer } from "./daemon/sdk-server.ts";
import { runCliApp } from "./generated/cli.ts";
import { fakeProcess, type CapturedProcess } from "./generated/test-util.ts";
import { sdkSocketPath, writeAgentRecord } from "./registry.ts";
import type { SdkEvent, SdkRequestRecord } from "./sdk-socket.ts";
import type { SessionEntry } from "./session/file.ts";

const UUID_A = "00000000-0000-4000-8000-00000000000a" as UUID;
const UUID_B = "00000000-0000-4000-8000-00000000000b" as UUID;
const UUID_H = "00000000-0000-4000-8000-00000000000e" as UUID;

const BUSY_STATE: AgentState = { ...INITIAL_AGENT_STATE, activity: "working" };

const RESULT_EVENT: SdkEvent = {
  kind: "sdkMessage",
  message: { type: "result" } as unknown as SDKMessage,
};

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

function queuedEvent(id: number, text: string): SdkEvent {
  return { kind: "userMessageQueued", id, message: userMessage(text) };
}

function dequeuedEvent(ids: number[]): SdkEvent {
  return { kind: "userMessageDequeued", delivery: "turn", ids };
}

function assistantEvent(uuid: UUID): SdkEvent {
  return {
    kind: "sdkMessage",
    message: {
      type: "assistant",
      uuid,
      message: { usage: {} },
    } as unknown as SDKMessage,
  };
}

function userEntry(uuid: UUID, text: string): SessionEntry {
  return {
    type: "user",
    uuid,
    sessionId: "test-session",
    message: { role: "user", content: text },
  };
}

async function runCommand(argv: string[]): Promise<CapturedProcess> {
  const capture = fakeProcess(process.env);
  await runCliApp(app, argv, capture.proc);
  return capture;
}

/**
 * A registry with one live agent (this process is its "daemon") and an
 * sdk.sock server: subscribe is answered with `seed` then `events` in a
 * single chunk (already queued when subscribe resolves, so they are pumped
 * before the separate query connection's round trip completes — sdk events
 * deterministically precede any entries `onQuery` appends); query is
 * answered by `onQuery`, which may append live entries to the session file
 * first. `sessionEntries` are on-disk history before the run.
 */
async function withPromptAgent(
  options: {
    seed?: AgentState;
    events?: SdkEvent[];
    hangUp?: boolean;
    sessionEntries?: SessionEntry[];
    onQuery?: (request: SdkRequestRecord) => Promise<unknown>;
  },
  fn: (agentId: string) => Promise<void>,
): Promise<void> {
  const previousDir = process.env.CLAUCTL_DIR;
  const dir = await mkdtemp(join(tmpdir(), "clauctl-prompt-test-"));
  process.env.CLAUCTL_DIR = dir;
  const agentDir = join(dir, "abcdef");
  const projectDir = join(dir, "project");
  await mkdir(agentDir);
  await mkdir(projectDir);
  const sessionFile = join(projectDir, "s1.jsonl");
  await writeFile(
    sessionFile,
    (options.sessionEntries ?? [])
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join(""),
  );
  await writeAgentRecord({
    id: "abcdef",
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
    persistedOptions: {},
    sessions: [{ sessionId: "s1", sessionFile }],
    daemonPid: process.pid,
    attachments: [],
    agentDir,
  });
  let subscribedSocket: Socket | undefined;
  let latestSocket: Socket | undefined;
  const server = startSdkServer(
    sdkSocketPath(agentDir),
    async (request, connection) => {
      if (request.type === "subscribe") {
        subscribedSocket = latestSocket;
        connection.write(
          [
            JSON.stringify({
              id: request.id,
              ok: true,
              data: options.seed ?? INITIAL_AGENT_STATE,
            }),
            ...(options.events ?? []).map((event) => JSON.stringify({ event })),
            "",
          ].join("\n"),
        );
        if (options.hangUp) {
          subscribedSocket!.end();
        }
        return RESPONSE_SENT;
      }
      if (request.type === "query" && options.onQuery !== undefined) {
        return await options.onQuery(request);
      }
      return "ok";
    },
  );
  server.on("connection", (socket: Socket) => {
    latestSocket = socket;
  });
  try {
    await fn("abcdef");
  } finally {
    server.close();
    subscribedSocket?.destroy();
    latestSocket?.destroy();
    if (previousDir === undefined) {
      delete process.env.CLAUCTL_DIR;
    } else {
      process.env.CLAUCTL_DIR = previousDir;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("--detach submits and prints nothing", async () => {
  const seen: SdkRequestRecord[] = [];
  await withPromptAgent(
    {
      onQuery: (request) => {
        seen.push(request);
        return Promise.resolve({ id: 1 });
      },
    },
    async (agentId) => {
      const result = await runCommand(["prompt", "-t", agentId, "-d", "hi"]);
      assert.equal(result.proc.exitCode, 0);
      assert.equal(result.stdout, "");
      assert.equal(seen.length, 1);
      assert.equal((seen[0] as { content?: unknown }).content, "hi");
    },
  );
});

test("--no-query implies detach and sends shouldQuery: false", async () => {
  const seen: SdkRequestRecord[] = [];
  await withPromptAgent(
    {
      onQuery: (request) => {
        seen.push(request);
        return Promise.resolve({ id: 1 });
      },
    },
    async (agentId) => {
      const result = await runCommand([
        "prompt",
        "-t",
        agentId,
        "--no-query",
        "note",
      ]);
      assert.equal(result.proc.exitCode, 0);
      assert.equal(result.stdout, "");
      assert.equal((seen[0] as { shouldQuery?: unknown }).shouldQuery, false);
    },
  );
});

test("detach combined with stream flags is a usage error", async () => {
  await withPromptAgent({}, async (agentId) => {
    for (const extra of [
      ["--until", "turn-end"],
      ["--json"],
      ["--type", "events"],
      ["--timeout", "1"],
    ]) {
      const result = await runCommand([
        "prompt",
        "-t",
        agentId,
        "-d",
        ...extra,
        "hi",
      ]);
      assert.equal(result.proc.exitCode, 2, extra.join(" "));
    }
    const noQuery = await runCommand([
      "prompt",
      "-t",
      agentId,
      "--no-query",
      "--json",
      "hi",
    ]);
    assert.equal(noQuery.proc.exitCode, 2);
  });
});

test("events leg starts at our dequeue, inclusive, and ends at the result", async () => {
  await withPromptAgent(
    {
      seed: BUSY_STATE,
      // Pre-gate noise (another turn's activity and our queued echo) must be
      // suppressed; the window opens at the dequeue carrying our id.
      events: [
        assistantEvent(UUID_A),
        queuedEvent(1, "hi"),
        dequeuedEvent([1]),
        RESULT_EVENT,
      ],
      onQuery: () => Promise.resolve({ id: 1 }),
    },
    async (agentId) => {
      const result = await runCommand([
        "prompt",
        "-t",
        agentId,
        "--type",
        "events",
        "--json",
        "hi",
      ]);
      assert.equal(result.proc.exitCode, 0);
      const kinds = result.stdoutChunks.map(
        (line) => (JSON.parse(line) as { event: SdkEvent }).event.kind,
      );
      assert.deepEqual(kinds, ["userMessageDequeued", "sdkMessage"]);
    },
  );
});

test("a dequeue without our id does not open the gate; --timeout exits 3", async () => {
  await withPromptAgent(
    {
      seed: BUSY_STATE,
      events: [queuedEvent(1, "hi"), dequeuedEvent([7]), RESULT_EVENT],
      onQuery: () => Promise.resolve({ id: 1 }),
    },
    async (agentId) => {
      const result = await runCommand([
        "prompt",
        "-t",
        agentId,
        "--type",
        "events",
        "--json",
        "--timeout",
        "0.05",
        "hi",
      ]);
      assert.equal(result.proc.exitCode, 3);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /not met within/);
    },
  );
});

test("messages leg renders only our turn's entries, not history", async () => {
  let appendOurTurn: (() => Promise<void>) | undefined;
  await withPromptAgent(
    {
      seed: BUSY_STATE,
      events: [
        queuedEvent(1, "hi"),
        dequeuedEvent([1]),
        assistantEvent(UUID_B),
        RESULT_EVENT,
      ],
      sessionEntries: [userEntry(UUID_H, "history")],
      onQuery: async () => {
        // The entry scan completed when the observer's subscribe resolved,
        // before this submission — these land as live entries.
        await appendOurTurn!();
        return { id: 1 };
      },
    },
    async (agentId) => {
      appendOurTurn = async () => {
        const sessionFile = join(
          process.env.CLAUCTL_DIR!,
          "project",
          "s1.jsonl",
        );
        await appendFile(
          sessionFile,
          [userEntry(UUID_A, "our user"), userEntry(UUID_B, "our reply")]
            .map((entry) => `${JSON.stringify(entry)}\n`)
            .join(""),
        );
      };
      const result = await runCommand([
        "prompt",
        "-t",
        agentId,
        "--json",
        "hi",
      ]);
      assert.equal(result.proc.exitCode, 0);
      const uuids = result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { uuid?: string }).uuid);
      // History is skipped; the --until turn-end catch-up holds settlement
      // open until the leaf announced by the assistant event is consumed.
      assert.deepEqual(uuids, [UUID_A, UUID_B]);
    },
  );
});

test("/compact has no receipt and streams ungated until the result", async () => {
  const compactSent: SdkEvent = {
    kind: "compactSent",
    message: userMessage("/compact"),
  };
  await withPromptAgent(
    {
      seed: BUSY_STATE,
      events: [compactSent, RESULT_EVENT],
      // No data: the daemon's /compact path bypasses the queue model.
      onQuery: () => Promise.resolve(undefined),
    },
    async (agentId) => {
      const result = await runCommand([
        "prompt",
        "-t",
        agentId,
        "--type",
        "events",
        "--json",
        "/compact",
      ]);
      assert.equal(result.proc.exitCode, 0);
      const kinds = result.stdoutChunks.map(
        (line) => (JSON.parse(line) as { event: SdkEvent }).event.kind,
      );
      assert.deepEqual(kinds, ["compactSent", "sdkMessage"]);
    },
  );
});

test("a stream close before the condition is met fails", async () => {
  await withPromptAgent(
    {
      seed: BUSY_STATE,
      events: [queuedEvent(1, "hi")],
      hangUp: true,
      onQuery: () => Promise.resolve({ id: 1 }),
    },
    async (agentId) => {
      const result = await runCommand(["prompt", "-t", agentId, "hi"]);
      assert.equal(result.proc.exitCode, 1);
      assert.match(result.stderr, /closed before condition met/);
    },
  );
});

test("a malformed receipt is an internal error", async () => {
  await withPromptAgent(
    {
      seed: BUSY_STATE,
      onQuery: () => Promise.resolve("ok"),
    },
    async (agentId) => {
      const result = await runCommand([
        "prompt",
        "-t",
        agentId,
        "--type",
        "events",
        "--json",
        "hi",
      ]);
      assert.equal(result.proc.exitCode, 1);
      assert.match(result.stderr, /malformed query receipt/);
    },
  );
});
