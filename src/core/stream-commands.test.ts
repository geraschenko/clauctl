/*
 * End-to-end settlement behavior of the protocol stream commands: what
 * `tail --type events --json` and `wait` print and exit with for each
 * runStream outcome. Driven through the real `app` so the exit-code mapping
 * (UntilTimeoutError → 3) is part of what is under test. The session-file
 * tail paths (messages/entries) are covered in tail.test.ts.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { initialAgentState, type AgentState } from "./agent-state.ts";
import { app } from "./app.ts";
import {
  RESPONSE_SENT,
  startProtocolServer,
} from "./daemon/protocol-server.ts";
import { runCliApp } from "./generated/cli.ts";
import { fakeProcess, type CapturedProcess } from "./generated/test-util.ts";
import { agentSocketPath, writeAgentRecord } from "./registry.ts";
import type { AgentEvent } from "./protocol.ts";

/** Not idle, so `--until turn-end` is unmet at the seed and the commands
 *  actually watch the stream. */
const BUSY_STATE: AgentState = { ...initialAgentState(), activity: "working" };

/** The fold reads only `type` here; a result with nothing queued means idle. */
const RESULT_EVENT: AgentEvent = {
  kind: "sdkMessage",
  message: { type: "result" } as unknown as SDKMessage,
};

async function runCommand(argv: string[]): Promise<CapturedProcess> {
  const capture = fakeProcess(process.env);
  await runCliApp(app, argv, capture.proc);
  return capture;
}

/**
 * Stand up a registry holding one live agent (this process is its "daemon")
 * plus a protocol server that answers subscribe with `seed`, then writes
 * `events` and optionally hangs up — the whole reply in a single chunk, so
 * the events are already queued when subscribe resolves.
 */
async function withAgent<T>(
  seed: AgentState,
  events: AgentEvent[],
  hangUp: boolean,
  fn: (agentId: string) => Promise<T>,
): Promise<T> {
  const previousDir = process.env.CLAUCTL_DIR;
  const dir = await mkdtemp(join(tmpdir(), "clauctl-stream-test-"));
  process.env.CLAUCTL_DIR = dir;
  const agentDir = join(dir, "abcdef");
  await mkdir(agentDir);
  await writeAgentRecord({
    id: "abcdef",
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
    persistedOptions: {},
    sessions: [],
    daemonPid: process.pid,
    attachments: [],
    agentDir,
  });
  let daemonSocket: Socket | undefined;
  const server = startProtocolServer(
    agentSocketPath(agentDir),
    (request, connection) => {
      if (request.type === "subscribe") {
        connection.write(
          [
            JSON.stringify({ id: request.id, ok: true, data: seed }),
            ...events.map((event) => JSON.stringify({ event })),
            "",
          ].join("\n"),
        );
        if (hangUp) {
          daemonSocket!.end();
        }
        return Promise.resolve(RESPONSE_SENT);
      }
      return Promise.resolve("ok");
    },
  );
  server.on("connection", (socket: Socket) => {
    daemonSocket = socket;
  });
  try {
    return await fn("abcdef");
  } finally {
    server.close();
    daemonSocket?.destroy();
    if (previousDir === undefined) {
      delete process.env.CLAUCTL_DIR;
    } else {
      process.env.CLAUCTL_DIR = previousDir;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("tail prints the snapshot before the event that satisfies --until", async () => {
  await withAgent(BUSY_STATE, [RESULT_EVENT], false, async (agentId) => {
    const result = await runCommand([
      "tail",
      "-t",
      agentId,
      "--type",
      "events",
      "--json",
      "--until",
      "turn-end",
    ]);
    assert.equal(result.proc.exitCode, 0);
    const records = result.stdoutChunks.map(
      (line) =>
        JSON.parse(line) as { snapshot?: AgentState; event?: AgentEvent },
    );
    assert.deepEqual(records[0]!.snapshot, BUSY_STATE);
    assert.equal(records[1]!.event!.kind, "sdkMessage");
    assert.equal(records.length, 2);
  });
});

// The queue-level backlog case (close observed while the event is still
// queued) is covered in protocol.test.ts; here the daemon hangs up in the
// same breath, which the consumer wins outright.
test("an event delivered as the daemon hangs up still satisfies --until", async () => {
  await withAgent(BUSY_STATE, [RESULT_EVENT], true, async (agentId) => {
    const result = await runCommand([
      "wait",
      "-t",
      agentId,
      "--until",
      "turn-end",
    ]);
    assert.equal(result.proc.exitCode, 0);
  });
});

test("a socket close with nothing to satisfy --until fails", async () => {
  await withAgent(BUSY_STATE, [], true, async (agentId) => {
    const result = await runCommand([
      "wait",
      "-t",
      agentId,
      "--until",
      "turn-end",
    ]);
    assert.equal(result.proc.exitCode, 1);
    assert.match(result.stderr, /closed before condition met/);
  });
});

test("tail treats an expired --timeout as success, wait as exit 3", async () => {
  await withAgent(BUSY_STATE, [], false, async (agentId) => {
    const tailed = await runCommand([
      "tail",
      "-t",
      agentId,
      "--type",
      "events",
      "--json",
      "--until",
      "turn-end",
      "--timeout",
      "0.05",
    ]);
    // Watching for the requested span is the whole job; the snapshot it
    // observed is still reported.
    assert.equal(tailed.proc.exitCode, 0);
    assert.equal(tailed.stdoutChunks.length, 1);

    const waited = await runCommand([
      "wait",
      "-t",
      agentId,
      "--until",
      "turn-end",
      "--timeout",
      "0.05",
    ]);
    assert.equal(waited.proc.exitCode, 3);
    assert.match(waited.stderr, /not met within 0.05s/);
  });
});

test("tail --timeout without --until is a bounded watch", async () => {
  await withAgent(BUSY_STATE, [RESULT_EVENT], false, async (agentId) => {
    const result = await runCommand([
      "tail",
      "-t",
      agentId,
      "--type",
      "events",
      "--json",
      "--timeout",
      "0.05",
    ]);
    // No condition to meet: the deadline simply ends an otherwise endless
    // stream, after everything seen so far has been printed.
    assert.equal(result.proc.exitCode, 0);
    assert.equal(result.stdoutChunks.length, 2);
  });
});

test("tail --timeout 0 is a snapshot-only watch, not an error", async () => {
  await withAgent(BUSY_STATE, [], false, async (agentId) => {
    const result = await runCommand([
      "tail",
      "-t",
      agentId,
      "--type",
      "events",
      "--json",
      "--until",
      "turn-end",
      "--timeout",
      "0",
    ]);
    assert.equal(result.proc.exitCode, 0);
    assert.equal(result.stdoutChunks.length, 1);
  });
});
