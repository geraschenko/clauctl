import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { writeFile } from "node:fs/promises";
import {
  type AgentRecord,
  type SpawnOptions,
  agentDirPath,
  agentIdError,
  readAgentRecord,
  readSpawnOptions,
  resolveAgentId,
  socketPathLengthError,
  spawnOptionsPath,
  writeAgentRecord,
  writeSpawnOptions,
} from "./registry.ts";

/** An agentDir of exactly `len` ASCII bytes. sdk.sock adds 9, the NUL 1 more. */
function agentDirOfLength(len: number): string {
  return "/" + "a".repeat(len - 1);
}

let baseDir: string;

async function writeAgent(agentId: string): Promise<void> {
  const agentDir = agentDirPath(agentId);
  await mkdir(agentDir, { recursive: true });
  const record: AgentRecord = {
    id: agentId,
    createdAt: "2026-07-03T00:00:00.000Z",
    cwd: "/tmp",
    persistedOptions: { model: "sonnet" },
    sessions: [],
    daemonPid: 1,
    attachments: [],
    agentDir,
  };
  await writeAgentRecord(record);
}

before(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "clauctl-registry-test-"));
  process.env.CLAUCTL_DIR = baseDir;

  await writeAgent("alpha-agent");
  await writeAgent("beta-agent");
});

after(async () => {
  delete process.env.CLAUCTL_DIR;
  await rm(baseDir, { recursive: true, force: true });
});

test("exact agent id resolves", async () => {
  assert.equal(await resolveAgentId("alpha-agent"), "alpha-agent");
});

test("unique agent id prefix resolves", async () => {
  assert.equal(await resolveAgentId("al"), "alpha-agent");
});

test("ambiguous agent id prefix errors with candidates", async () => {
  await assert.rejects(
    resolveAgentId(""),
    /ambiguous agent id ''.*alpha-agent/s,
  );
});

test("no match errors", async () => {
  await assert.rejects(resolveAgentId("zzz"), /no agent matches 'zzz'/);
});

test("write/read round-trips the record and repopulates agentDir", async () => {
  const agentDir = agentDirPath("alpha-agent");
  const read = await readAgentRecord(agentDir);
  assert.equal(read.kind, "ok");
  if (read.kind === "ok") {
    assert.equal(read.record.id, "alpha-agent");
    assert.equal(read.record.agentDir, agentDir);
    assert.deepEqual(read.record.persistedOptions, { model: "sonnet" });
  }
});

test("readAgentRecord reports a missing agent.json", async () => {
  const agentDir = agentDirPath("never-spawned");
  assert.deepEqual(await readAgentRecord(agentDir), { kind: "missing" });
});

test("socketPathLengthError: a short path fits on both platforms", () => {
  const dir = agentDirOfLength(40);
  assert.equal(socketPathLengthError(dir, "linux"), undefined);
  assert.equal(socketPathLengthError(dir, "darwin"), undefined);
});

test("socketPathLengthError: Linux boundary is 108 bytes", () => {
  // agentDir 98 + "/sdk.sock" 9 + NUL 1 = 108 = limit.
  assert.equal(socketPathLengthError(agentDirOfLength(98), "linux"), undefined);
  assert.match(
    socketPathLengthError(agentDirOfLength(99), "linux") ?? "",
    /too long.*109 bytes.*limit is 108/s,
  );
});

test("socketPathLengthError: macOS boundary is 104 bytes", () => {
  // agentDir 94 + 9 + 1 = 104 = limit.
  assert.equal(
    socketPathLengthError(agentDirOfLength(94), "darwin"),
    undefined,
  );
  assert.match(
    socketPathLengthError(agentDirOfLength(95), "darwin") ?? "",
    /too long.*105 bytes.*limit is 104/s,
  );
});

test("socketPathLengthError: a path that fits Linux can overflow macOS", () => {
  const dir = agentDirOfLength(96);
  assert.equal(socketPathLengthError(dir, "linux"), undefined);
  assert.ok(socketPathLengthError(dir, "darwin"));
});

test("socketPathLengthError: counts bytes, not characters", () => {
  // 90 two-byte chars = 180 bytes, well over either limit despite 90 "chars".
  const dir = "/" + "é".repeat(90);
  assert.ok(socketPathLengthError(dir, "linux"));
});

test("socketPathLengthError: message names the path and a remedy", () => {
  const msg = socketPathLengthError(agentDirOfLength(200), "linux") ?? "";
  assert.match(msg, /sdk\.sock/);
  assert.match(msg, /--id|CLAUCTL_DIR/);
});

test("spawn options: write/read round-trips", async () => {
  const agentDir = agentDirPath("alpha-agent");
  const options: SpawnOptions = {
    cwd: "/tmp",
    tag: "worker",
    persistedOptions: { model: "sonnet" },
    resume: "session-123",
  };
  await writeSpawnOptions(agentDir, options);
  assert.deepEqual(await readSpawnOptions(agentDir), { kind: "ok", options });
});

test("readSpawnOptions reports a missing file", async () => {
  const agentDir = agentDirPath("never-spawned");
  assert.deepEqual(await readSpawnOptions(agentDir), { kind: "missing" });
});

test("readSpawnOptions reports invalid JSON as corrupt", async () => {
  const agentDir = agentDirPath("beta-agent");
  await writeFile(spawnOptionsPath(agentDir), "not json\n");
  const read = await readSpawnOptions(agentDir);
  assert.equal(read.kind, "corrupt");
});

test("readSpawnOptions reports missing required fields as corrupt", async () => {
  const agentDir = agentDirPath("beta-agent");
  await writeFile(spawnOptionsPath(agentDir), `{"tag":"worker"}\n`);
  assert.deepEqual(await readSpawnOptions(agentDir), {
    kind: "corrupt",
    error: "spawn-options.json missing required fields",
  });
});

test("agentIdError: accepts uuids and friendly ids", () => {
  assert.equal(agentIdError("c8b2e994-6872-425d-bfe7-b24b7987696d"), undefined);
  assert.equal(agentIdError("my_agent.1"), undefined);
});

test("agentIdError: rejects path traversal and separators", () => {
  for (const bad of ["..", ".", "../foo", "a/b", "a\\b", "", "with space"]) {
    assert.ok(agentIdError(bad), `expected '${bad}' to be rejected`);
  }
});
