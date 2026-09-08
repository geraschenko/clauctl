import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { initialAgentState } from "./agent-state/index.ts";
import { RESPONSE_SENT, startProtocolServer } from "./protocol-server/index.ts";
import type { StreamEvent } from "./generated/streaming/driver.ts";
import type { AgentEvent, AgentState } from "./protocol/index.ts";
import { ProtocolClient } from "./protocol-client/index.ts";

const dir = mkdtempSync(join(tmpdir(), "clauctl-protocol-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const queryingMessage: SDKUserMessage = {
  type: "user",
  message: { role: "user", content: "hi" },
  parent_tool_use_id: null,
};

test("subscribe seeds the client fold and delivers (event, post-fold state) pairs", async () => {
  const socketPath = join(dir, "socket");
  const queuedId = randomUUID();
  const queuedEvent: AgentEvent = {
    kind: "userMessageQueued",
    uuid: randomUUID(),
    message: { ...queryingMessage, uuid: queuedId },
  };
  const dequeuedEvent: AgentEvent = {
    kind: "userMessageDequeued",
    delivery: "turn",
    uuids: [queuedId],
  };
  const server = startProtocolServer(socketPath, (request, connection) => {
    if (request.type === "subscribe") {
      // One write: the seed response and both events reach the client in a
      // single chunk, so all three lines dispatch before the subscribe
      // promise settles — the window the client-owned fold must handle.
      connection.write(
        [
          JSON.stringify({
            id: request.id,
            ok: true,
            data: initialAgentState(),
          }),
          JSON.stringify({ event: queuedEvent }),
          JSON.stringify({ event: dequeuedEvent }),
          "",
        ].join("\n"),
      );
      return Promise.resolve(RESPONSE_SENT);
    }
    return Promise.resolve("ok");
  });
  try {
    const client = await ProtocolClient.connect(socketPath);
    try {
      const { seed, events } = await client.subscribe();
      // The seed is the response's state, not the live folded state — the
      // caller's view starts where the queued events advance from.
      assert.deepEqual(seed, initialAgentState());
      // Both same-chunk events were queued before the promise settled, each
      // with the state after folding it.
      const pairs: Array<StreamEvent<AgentEvent, AgentState>> = [];
      for await (const pair of events) {
        pairs.push(pair);
        if (pairs.length === 2) {
          break;
        }
      }
      assert.equal(pairs[0]!.event.kind, "userMessageQueued");
      assert.equal(pairs[0]!.state.activity, "pending");
      assert.deepEqual(
        pairs[0]!.state.queuedMessages.map((entry) => entry.uuid),
        [queuedId],
      );
      assert.deepEqual(pairs[1]!.state.queuedMessages, []);
      await assert.rejects(client.subscribe(), /already subscribed/);
    } finally {
      client.close();
    }
  } finally {
    server.close();
  }
});

test("hello version mismatch rejects connect, match connects", async () => {
  const socketPath = join(dir, "hello-version.sock");
  const server = createServer((socket) => {
    socket.write(
      `${JSON.stringify({ type: "hello", protocol: "clauctl-protocol", version: 999 })}\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await assert.rejects(
      ProtocolClient.connect(socketPath),
      /version 999, expected/,
    );
  } finally {
    server.close();
  }

  const matchedPath = join(dir, "hello-match.sock");
  const matched = startProtocolServer(matchedPath, () => Promise.resolve("ok"));
  try {
    const client = await ProtocolClient.connect(matchedPath);
    client.close();
  } finally {
    matched.close();
  }
});

test("socket close drains the events already received", async () => {
  const socketPath = join(dir, "drain.sock");
  const event: AgentEvent = {
    kind: "userMessageQueued",
    uuid: randomUUID(),
    message: queryingMessage,
  };
  let daemonSocket: Socket | undefined;
  const server = startProtocolServer(socketPath, (request, connection) => {
    if (request.type === "subscribe") {
      connection.write(
        [
          JSON.stringify({
            id: request.id,
            ok: true,
            data: initialAgentState(),
          }),
          JSON.stringify({ event }),
          "",
        ].join("\n"),
      );
      return Promise.resolve(RESPONSE_SENT);
    }
    return Promise.resolve("ok");
  });
  server.on("connection", (socket: Socket) => {
    daemonSocket = socket;
  });
  try {
    const client = await ProtocolClient.connect(socketPath);
    try {
      const { events } = await client.subscribe();
      // Consume only after the close is observed, so the event is genuinely
      // sitting in the queue when the socket goes away: iteration must still
      // yield it and only then end. Dropping it would let a condition that
      // was met on the wire report as unmet.
      daemonSocket!.end();
      await client.waitClosed();
      const drained: Array<StreamEvent<AgentEvent, AgentState>> = [];
      for await (const pair of events) {
        drained.push(pair);
      }
      assert.equal(drained.length, 1);
      assert.equal(drained[0]!.event.kind, "userMessageQueued");
    } finally {
      client.close();
    }
  } finally {
    server.close();
  }
});

test("close before the subscribe seed rejects", async () => {
  const socketPath = join(dir, "no-seed.sock");
  let daemonSocket: Socket | undefined;
  const server = startProtocolServer(socketPath, (request) => {
    if (request.type === "subscribe") {
      // Claim the response, then vanish without writing one.
      daemonSocket!.end();
      return Promise.resolve(RESPONSE_SENT);
    }
    return Promise.resolve("ok");
  });
  server.on("connection", (socket: Socket) => {
    daemonSocket = socket;
  });
  try {
    const client = await ProtocolClient.connect(socketPath);
    try {
      await assert.rejects(
        client.subscribe(),
        /closed before the subscribe seed/,
      );
    } finally {
      client.close();
    }
  } finally {
    server.close();
  }
});
