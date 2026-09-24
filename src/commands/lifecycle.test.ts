import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
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
