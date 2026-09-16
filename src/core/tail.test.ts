/*
 * tail's session-file paths (docs/specs/tail-parity.md): dormant history,
 * live follow on the agent event stream (docs/specs/session-tracker.md, Data
 * flow 6), --until settlement, session rollover dedup, and byte-equivalence
 * of formatted output with `--json | format`. The events paths stay in
 * stream-commands.test.ts. The fake daemon's session id is "s1".
 */

import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  freshSessionState,
  initialAgentState,
  nextAgentState,
  type AgentState,
} from "./agent-state/agent-state.ts";
import { app } from "./app.ts";
import {
  RESPONSE_SENT,
  startProtocolServer,
} from "./daemon/protocol-server.ts";
import { runCliApp } from "./generated/cli.ts";
import { fakeProcess, type CapturedProcess } from "./generated/test-util.ts";
import { agentSocketPath, writeAgentRecord } from "./registry.ts";
import type { AgentEvent, GetEntriesResponse } from "./protocol.ts";
import type { SessionEntry } from "./session/file.ts";
import { UntilSettlement } from "./tail.ts";

const UUID_A = "00000000-0000-4000-8000-00000000000a" as UUID;
const UUID_B = "00000000-0000-4000-8000-00000000000b" as UUID;
const UUID_C = "00000000-0000-4000-8000-00000000000c" as UUID;
const UUID_MISSING = "00000000-0000-4000-8000-0000000000ff" as UUID;

const SESSION_S1 = "s1" as UUID;
const SESSION_S2 = "s2" as UUID;

/** The fake daemon tracking file s1 as the query file. */
function withFile(base: AgentState): AgentState {
  return { ...base, querySessionId: SESSION_S1, fileSessionId: SESSION_S1 };
}

const IDLE_STATE = withFile(initialAgentState());
const BUSY_STATE = withFile({ ...initialAgentState(), activity: "working" });

/** `base` with its query file's leaf at `uuid`. */
function withLeaf(base: AgentState, uuid: UUID): AgentState {
  return {
    ...base,
    sessions: {
      [SESSION_S1]: { ...freshSessionState(), treeLeaf: { uuid } },
    },
  };
}

function resultEvent(sessionId: UUID): AgentEvent {
  return {
    kind: "sdkMessage",
    message: { type: "result", session_id: sessionId } as unknown as SDKMessage,
  };
}

function assistantEvent(uuid: UUID, sessionId: UUID): AgentEvent {
  return {
    kind: "sdkMessage",
    message: {
      type: "assistant",
      uuid,
      session_id: sessionId,
      message: { role: "assistant", content: [], usage: {} },
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

/** A structural assistant entry: its payload rides on the sdkMessage twin. */
function assistantEntry(uuid: UUID): SessionEntry {
  return {
    type: "assistant",
    uuid,
    sessionId: "test-session",
    message: { role: "assistant", content: [] },
  };
}

function entryEvent(
  entry: SessionEntry,
  expectsSdkMessage: boolean,
): AgentEvent {
  return {
    kind: "sessionEntry",
    entry,
    expectsSdkMessage,
    leaf: entry.uuid === undefined ? null : { uuid: entry.uuid },
    awaitingAnchors: [],
  };
}

function fileChangedEvent(sessionId: UUID): AgentEvent {
  return { kind: "sessionFileChanged", sessionId };
}

async function runCommand(argv: string[]): Promise<CapturedProcess> {
  const capture = fakeProcess(process.env);
  await runCliApp(app, argv, capture.proc);
  return capture;
}

function outputUuids(capture: CapturedProcess): (string | undefined)[] {
  return capture.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { uuid?: string }).uuid);
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

/** The fake daemon's `get-entries` answer: the latest session's entries
 *  after `since` (all of them when absent), every uuid, no leaf. */
function snapshotOf(
  sessions: SessionSpec[],
  since: unknown,
): GetEntriesResponse {
  const entries = sessions.at(-1)?.entries ?? [];
  const uuids = entries.map((entry) => entry.uuid!);
  if (since === undefined) {
    return { uuids, entries, leaf: null };
  }
  const index = uuids.indexOf(since as UUID);
  if (index === -1) {
    throw new Error(`since cursor ${String(since)} not found`);
  }
  return { uuids, entries: entries.slice(index + 1), leaf: null };
}

/**
 * A registry with one agent whose session files exist on disk. `live`
 * additionally makes this process the daemon and stands up a protocol server
 * answering subscribe with `seed`, and the `"full"` get-entries with a
 * snapshot of the latest session file followed by `events` in the same chunk
 * (queued after the response, so they are live), optionally hanging up.
 */
async function withTailAgent(
  options: {
    live: boolean;
    seed?: AgentState;
    events?: AgentEvent[];
    hangUp?: boolean;
    sessions: SessionSpec[];
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
    ? startProtocolServer(agentSocketPath(agentDir), (request, connection) => {
        if (request.type === "subscribe") {
          return Promise.resolve(options.seed ?? IDLE_STATE);
        }
        if (request.type === "get-entries" && "payload" in request) {
          const snapshot = snapshotOf(options.sessions, request.since);
          if (request.payload === "uuids") {
            return Promise.resolve({ uuids: snapshot.uuids, leaf: null });
          }
          connection.write(
            [
              JSON.stringify({ id: request.id, ok: true, data: snapshot }),
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
    assert.deepEqual(outputUuids(json), [UUID_A, UUID_B]);

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

test("--since resolves a unique uuid prefix; ambiguity and bad syntax error", async () => {
  const UUID_P1 = "aa111111-0000-4000-8000-000000000001" as UUID;
  const UUID_P2 = "aa222222-0000-4000-8000-000000000002" as UUID;
  const sessions = [
    {
      sessionId: "s1",
      entries: [userEntry(UUID_P1, "first"), userEntry(UUID_P2, "second")],
    },
  ];
  await withTailAgent({ live: false, sessions }, async (agentId) => {
    const resolved = await runCommand([
      "tail",
      "-t",
      agentId,
      "--json",
      "--since",
      "aa1",
    ]);
    assert.equal(resolved.proc.exitCode, 0);
    assert.deepEqual(outputUuids(resolved), [UUID_P2]);

    const ambiguous = await runCommand([
      "tail",
      "-t",
      agentId,
      "--json",
      "--since",
      "aa",
    ]);
    assert.equal(ambiguous.proc.exitCode, 1);
    assert.match(ambiguous.stderr, /ambiguous entry uuid prefix 'aa'/);
    assert.match(ambiguous.stderr, new RegExp(UUID_P1));
    assert.match(ambiguous.stderr, new RegExp(UUID_P2));

    const malformed = await runCommand([
      "tail",
      "-t",
      agentId,
      "--json",
      "--since",
      "zz",
    ]);
    assert.equal(malformed.proc.exitCode, 2);
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

test("live messages --timeout 0 prints the snapshot before the deadline", async () => {
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
    assert.deepEqual(outputUuids(result), [UUID_A, UUID_B]);
  });
});

test("live messages --since prints only entries after the cursor", async () => {
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
    assert.deepEqual(outputUuids(result), [UUID_B]);
  });
});

test("live --since resolves a uuid prefix through the daemon's uuids", async () => {
  const UUID_P1 = "aa111111-0000-4000-8000-000000000001" as UUID;
  const UUID_P2 = "aa222222-0000-4000-8000-000000000002" as UUID;
  const sessions = [
    {
      sessionId: "s1",
      entries: [userEntry(UUID_P1, "first"), userEntry(UUID_P2, "second")],
    },
  ];
  await withTailAgent({ live: true, sessions }, async (agentId) => {
    const result = await runCommand([
      "tail",
      "-t",
      agentId,
      "--json",
      "--since",
      "aa1",
      "--timeout",
      "0",
    ]);
    assert.equal(result.proc.exitCode, 0);
    assert.deepEqual(outputUuids(result), [UUID_P2]);
  });
});

test("--until turn-end on an idle agent prints the snapshot and exits", async () => {
  const sessions = [
    {
      sessionId: "s1",
      entries: [userEntry(UUID_A, "first"), userEntry(UUID_B, "second")],
    },
  ];
  await withTailAgent(
    { live: true, seed: withLeaf(IDLE_STATE, UUID_B), sessions },
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
      assert.deepEqual(outputUuids(result), [UUID_A, UUID_B]);
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

test("--until settles only once the query file has caught up", async () => {
  const sessions = [{ sessionId: "s1", entries: [userEntry(UUID_A, "first")] }];
  await withTailAgent(
    {
      live: true,
      seed: BUSY_STATE,
      // The result meets the condition while B is pending on the query
      // stream; the sessionEntry for B settles the file and the stream.
      events: [
        assistantEvent(UUID_B, SESSION_S1),
        resultEvent(SESSION_S1),
        entryEvent(assistantEntry(UUID_B), true),
      ],
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
      assert.deepEqual(outputUuids(result), [UUID_A, UUID_B]);
      const reply = JSON.parse(result.stdout.split("\n")[1]!) as {
        message: { usage?: unknown };
      };
      // The structural entry was completed from its twin's payload.
      assert.deepEqual(reply.message.usage, {});
    },
  );
});

test("rollover: an entry re-persisted by the new file is not printed again", async () => {
  const sessions = [
    {
      sessionId: "s1",
      entries: [userEntry(UUID_A, "first"), userEntry(UUID_B, "second")],
    },
  ];
  await withTailAgent(
    {
      live: true,
      seed: BUSY_STATE,
      events: [
        fileChangedEvent(SESSION_S2),
        entryEvent(userEntry(UUID_B, "second again"), false),
        entryEvent(userEntry(UUID_C, "third"), false),
        resultEvent(SESSION_S1),
      ],
      sessions,
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
      assert.deepEqual(outputUuids(result), [UUID_A, UUID_B, UUID_C]);
    },
  );
});

test("UntilSettlement's settle deadline expires describing the query file", async () => {
  const settlement = new UntilSettlement({ kind: "turn-end" }, 50);
  try {
    // B is observed on the query stream only: the file has not caught up.
    const unsettled = nextAgentState(
      BUSY_STATE,
      assistantEvent(UUID_B, SESSION_S1),
    );
    assert.equal(settlement.observe(resultEvent(SESSION_S1), unsettled), false);
    await assert.rejects(settlement.expiry, (error: Error) => {
      assert.match(error.message, /did not settle within 50ms/);
      assert.match(error.message, new RegExp(UUID_B));
      return true;
    });
  } finally {
    settlement.dispose();
  }
});
