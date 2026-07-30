/*
 * tail's session-file paths (docs/specs/tail-parity.md): dormant history,
 * live follow through AgentObserver, --until entry catch-up, session
 * rollover, and byte-equivalence of formatted output with `--json | format`.
 * The events paths stay in stream-commands.test.ts.
 */

import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { INITIAL_AGENT_STATE, type AgentState } from "./agent-state.ts";
import { app } from "./app.ts";
import { RESPONSE_SENT, startSdkServer } from "./daemon/sdk-server.ts";
import { runCliApp } from "./generated/cli.ts";
import { fakeProcess, type CapturedProcess } from "./generated/test-util.ts";
import { sdkSocketPath, writeAgentRecord } from "./registry.ts";
import type { SdkEvent } from "./sdk-socket.ts";
import type { SessionEntry } from "./session/file.ts";
import { UntilSettlement } from "./tail.ts";

const UUID_A = "00000000-0000-4000-8000-00000000000a" as UUID;
const UUID_B = "00000000-0000-4000-8000-00000000000b" as UUID;
const UUID_C = "00000000-0000-4000-8000-00000000000c" as UUID;
const UUID_MISSING = "00000000-0000-4000-8000-0000000000ff" as UUID;

const BUSY_STATE: AgentState = { ...INITIAL_AGENT_STATE, activity: "working" };

const RESULT_EVENT: SdkEvent = {
  kind: "sdkMessage",
  message: { type: "result" } as unknown as SDKMessage,
};

function initEvent(sessionId: string): SdkEvent {
  return {
    kind: "sdkMessage",
    message: {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "test-model",
      cwd: "/tmp",
      permissionMode: "default",
      claude_code_version: "0.0.0",
    } as unknown as SDKMessage,
  };
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

interface SessionSpec {
  sessionId: string;
  entries: SessionEntry[];
}

async function writeSessionFiles(
  projectDir: string,
  sessions: SessionSpec[],
): Promise<void> {
  for (const session of sessions) {
    await writeFile(
      join(projectDir, `${session.sessionId}.jsonl`),
      session.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
  }
}

/**
 * A registry with one agent whose session files exist on disk. `live`
 * additionally makes this process the daemon and stands up an sdk.sock server
 * answering subscribe with `seed` then `events` in a single chunk (already
 * queued when subscribe resolves), optionally hanging up. `onDiskOnly`
 * sessions exist as files but not in the agent record — rollover targets.
 */
async function withTailAgent(
  options: {
    live: boolean;
    seed?: AgentState;
    events?: SdkEvent[];
    hangUp?: boolean;
    sessions: SessionSpec[];
    onDiskOnly?: SessionSpec[];
  },
  fn: (agentId: string, projectDir: string) => Promise<void>,
): Promise<void> {
  const previousDir = process.env.CLAUCTL_DIR;
  const dir = await mkdtemp(join(tmpdir(), "clauctl-tail-test-"));
  process.env.CLAUCTL_DIR = dir;
  const agentDir = join(dir, "abcdef");
  const projectDir = join(dir, "project");
  await mkdir(agentDir);
  await mkdir(projectDir);
  await writeSessionFiles(projectDir, options.sessions);
  await writeSessionFiles(projectDir, options.onDiskOnly ?? []);
  await writeAgentRecord({
    id: "abcdef",
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
    persistedOptions: {},
    sessions: options.sessions.map((session) => ({
      sessionId: session.sessionId,
      sessionFile: join(projectDir, `${session.sessionId}.jsonl`),
    })),
    daemonPid: options.live ? process.pid : 99999999,
    attachments: [],
    agentDir,
  });
  let daemonSocket: Socket | undefined;
  const server = options.live
    ? startSdkServer(sdkSocketPath(agentDir), (request, connection) => {
        if (request.type === "subscribe") {
          connection.write(
            [
              JSON.stringify({
                id: request.id,
                ok: true,
                data: options.seed ?? INITIAL_AGENT_STATE,
              }),
              ...(options.events ?? []).map((event) =>
                JSON.stringify({ event }),
              ),
              "",
            ].join("\n"),
          );
          if (options.hangUp) {
            daemonSocket!.end();
          }
          return Promise.resolve(RESPONSE_SENT);
        }
        return Promise.resolve("ok");
      })
    : undefined;
  server?.on("connection", (socket: Socket) => {
    daemonSocket = socket;
  });
  try {
    await fn("abcdef", projectDir);
  } finally {
    server?.close();
    daemonSocket?.destroy();
    if (previousDir === undefined) {
      delete process.env.CLAUCTL_DIR;
    } else {
      process.env.CLAUCTL_DIR = previousDir;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("dormant messages: formatted output equals --json piped through format", async () => {
  const sessions = [
    {
      sessionId: "s1",
      entries: [userEntry(UUID_A, "first"), userEntry(UUID_B, "second")],
    },
  ];
  await withTailAgent({ live: false, sessions }, async (agentId) => {
    const json = await runCommand(["tail", "-t", agentId, "--json"]);
    assert.equal(json.proc.exitCode, 0);
    const uuids = json.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { uuid?: string }).uuid);
    assert.deepEqual(uuids, [UUID_A, UUID_B]);

    const formatted = await runCommand(["tail", "-t", agentId]);
    assert.equal(formatted.proc.exitCode, 0);

    const jsonPath = join(tmpdir(), `clauctl-tail-test-${process.pid}.jsonl`);
    await writeFile(jsonPath, json.stdout);
    try {
      const piped = await runCommand(["format", "messages", jsonPath]);
      assert.equal(piped.proc.exitCode, 0);
      assert.equal(formatted.stdout, piped.stdout);
      assert.match(formatted.stdout, /\[cursor: /);
    } finally {
      await rm(jsonPath, { force: true });
    }
  });
});

test("dormant entries with a missing --since cursor names the uuid and file", async () => {
  const sessions = [{ sessionId: "s1", entries: [userEntry(UUID_A, "only")] }];
  await withTailAgent({ live: false, sessions }, async (agentId) => {
    const result = await runCommand([
      "tail",
      "-t",
      agentId,
      "--type",
      "entries",
      "--since",
      UUID_MISSING,
    ]);
    assert.equal(result.proc.exitCode, 1);
    assert.match(result.stderr, new RegExp(UUID_MISSING));
    assert.match(result.stderr, /s1\.jsonl/);
  });
});

test("dormant --type events is an error; --since with events is a usage error", async () => {
  await withTailAgent({ live: false, sessions: [] }, async (agentId) => {
    const dormant = await runCommand([
      "tail",
      "-t",
      agentId,
      "--type",
      "events",
    ]);
    assert.equal(dormant.proc.exitCode, 1);
    assert.match(dormant.stderr, /dormant/);

    const usage = await runCommand([
      "tail",
      "-t",
      agentId,
      "--type",
      "events",
      "--since",
      UUID_A,
    ]);
    assert.equal(usage.proc.exitCode, 2);
  });
});

test("live messages --timeout 0 drains queued history before the deadline", async () => {
  const sessions = [
    {
      sessionId: "s1",
      entries: [userEntry(UUID_A, "first"), userEntry(UUID_B, "second")],
    },
  ];
  await withTailAgent({ live: true, sessions }, async (agentId) => {
    const result = await runCommand([
      "tail",
      "-t",
      agentId,
      "--json",
      "--timeout",
      "0",
    ]);
    assert.equal(result.proc.exitCode, 0);
    const uuids = result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { uuid?: string }).uuid);
    assert.deepEqual(uuids, [UUID_A, UUID_B]);
  });
});

test("live messages --since replays only entries after the cursor", async () => {
  const sessions = [
    {
      sessionId: "s1",
      entries: [userEntry(UUID_A, "first"), userEntry(UUID_B, "second")],
    },
  ];
  await withTailAgent({ live: true, sessions }, async (agentId) => {
    const result = await runCommand([
      "tail",
      "-t",
      agentId,
      "--json",
      "--since",
      UUID_A,
      "--timeout",
      "0",
    ]);
    assert.equal(result.proc.exitCode, 0);
    const uuids = result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { uuid?: string }).uuid);
    assert.deepEqual(uuids, [UUID_B]);
  });
});

test("--until turn-end on an idle agent emits history and exits", async () => {
  const sessions = [
    {
      sessionId: "s1",
      entries: [userEntry(UUID_A, "first"), userEntry(UUID_B, "second")],
    },
  ];
  await withTailAgent(
    {
      live: true,
      seed: { ...INITIAL_AGENT_STATE, leaf: { uuid: UUID_B } },
      sessions,
    },
    async (agentId) => {
      // The condition is met at the idle seed, which must not bypass
      // history: catch-up drains the queued entries through the seed leaf
      // before settling (spec "`--until` settlement and entry catch-up").
      const result = await runCommand([
        "tail",
        "-t",
        agentId,
        "--json",
        "--until",
        "turn-end",
      ]);
      assert.equal(result.proc.exitCode, 0);
      const uuids = result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { uuid?: string }).uuid);
      assert.deepEqual(uuids, [UUID_A, UUID_B]);
    },
  );
});

test("socket close during a messages follow is conclusive idleness", async () => {
  const sessions = [{ sessionId: "s1", entries: [userEntry(UUID_A, "hello")] }];
  await withTailAgent(
    { live: true, seed: BUSY_STATE, hangUp: true, sessions },
    async (agentId) => {
      const result = await runCommand([
        "tail",
        "-t",
        agentId,
        "--until",
        "turn-end",
      ]);
      // The daemon hung up with the condition unmet; for a session-file tail
      // that is graceful completion, with the history flushed and a cursor.
      assert.equal(result.proc.exitCode, 0);
      assert.match(result.stdout, /hello/);
      assert.match(result.stdout, /\[cursor: /);
    },
  );
});

test("--until settles only after the target leaf is consumed as an entry", async () => {
  const sessions = [
    {
      sessionId: "s1",
      entries: [userEntry(UUID_A, "first"), userEntry(UUID_B, "second")],
    },
  ];
  await withTailAgent(
    {
      live: true,
      seed: { ...BUSY_STATE, leaf: { uuid: UUID_B } },
      events: [RESULT_EVENT],
      sessions,
    },
    async (agentId) => {
      const result = await runCommand([
        "tail",
        "-t",
        agentId,
        "--json",
        "--until",
        "turn-end",
      ]);
      assert.equal(result.proc.exitCode, 0);
      const uuids = result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { uuid?: string }).uuid);
      // The condition fired at the result, but the queued history through the
      // target leaf still rendered before settlement.
      assert.deepEqual(uuids, [UUID_A, UUID_B]);
    },
  );
});

test("rollover switches files and carries first-wins dedup", async () => {
  const sessions = [
    {
      sessionId: "s1",
      entries: [userEntry(UUID_A, "first"), userEntry(UUID_B, "second")],
    },
  ];
  // s2 re-persists UUID_B (suppressed by the carried filter) then adds UUID_C.
  const onDiskOnly = [
    {
      sessionId: "s2",
      entries: [userEntry(UUID_B, "second again"), userEntry(UUID_C, "third")],
    },
  ];
  await withTailAgent(
    {
      live: true,
      seed: BUSY_STATE,
      events: [initEvent("s2"), assistantEvent(UUID_C), RESULT_EVENT],
      sessions,
      onDiskOnly,
    },
    async (agentId) => {
      const result = await runCommand([
        "tail",
        "-t",
        agentId,
        "--type",
        "entries",
        "--json",
        "--until",
        "turn-end",
      ]);
      assert.equal(result.proc.exitCode, 0);
      const uuids = result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { uuid?: string }).uuid);
      assert.deepEqual(uuids, [UUID_A, UUID_B, UUID_C]);
    },
  );
});

test("UntilSettlement's catch-up deadline expires naming the target and file", async () => {
  const settlement = new UntilSettlement(
    { kind: "turn-end" },
    () => "/tmp/session.jsonl",
    50,
  );
  try {
    const settled = settlement.metAtSeed({
      sdk: { ...INITIAL_AGENT_STATE, leaf: { uuid: UUID_MISSING } },
      entries: { seenUuids: new Set() },
    });
    // Idle at the seed, so the condition holds, but the leaf has not been
    // consumed as an entry observation: catch-up begins instead of settling.
    assert.equal(settled, false);
    await assert.rejects(settlement.expiry, (error: Error) => {
      assert.match(error.message, new RegExp(UUID_MISSING));
      assert.match(error.message, /session\.jsonl/);
      return true;
    });
  } finally {
    settlement.dispose();
  }
});
