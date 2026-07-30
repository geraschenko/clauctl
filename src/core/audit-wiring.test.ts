import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApplication, buildRouteMap } from "@stricli/core";
import type { AuditCommandEvent } from "./generated/audit.ts";
import {
  commandOneTarget,
  recordCommandAudit,
  runCliApp,
} from "./generated/cli.ts";
import type { CommandContext } from "./generated/targets.ts";
import { fakeProcess } from "./generated/test-util.ts";
import { auditLogPath, writeAgentRecord } from "./registry.ts";

async function withRegistry<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const old = process.env.CLAUCTL_DIR;
  const dir = await mkdtemp(join(tmpdir(), "clauctl-audit-test-"));
  process.env.CLAUCTL_DIR = dir;
  try {
    const agentDir = join(dir, "abcdef");
    await mkdir(agentDir);
    await writeAgentRecord({
      id: "abcdef",
      createdAt: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp",
      persistedOptions: {},
      sessions: [],
      daemonPid: 99999999,
      attachments: [],
      agentDir,
    });
    return await fn(dir);
  } finally {
    if (old === undefined) {
      delete process.env.CLAUCTL_DIR;
    } else {
      process.env.CLAUCTL_DIR = old;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

// Audit wiring is probed with no-op commands rather than the real audited
// routes: those are sdk.sock commands whose funcs would attempt daemon
// revival against the fake registry. The wrappers under test are the same
// ones the real routes go through.
const auditProbeApp = buildApplication<CommandContext>(
  buildRouteMap({
    routes: {
      "audited-cmd": commandOneTarget({
        docs: { brief: "audited no-op" },
        audited: true,
        func: async () => {},
      }),
      "plain-cmd": commandOneTarget({
        docs: { brief: "unaudited no-op" },
        func: async () => {},
      }),
    },
    docs: { brief: "audit wiring probe" },
  }),
  { name: "clauctl-probe" },
);

function readAuditEvents(raw: string): AuditCommandEvent[] {
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as AuditCommandEvent);
}

test("target wrappers audit exactly the audited commands", async () => {
  await withRegistry(async (dir) => {
    const auditLog = auditLogPath(join(dir, "abcdef"));

    const audited = fakeProcess();
    await runCliApp(auditProbeApp, ["audited-cmd", "-t", "abc"], audited.proc);
    assert.equal(audited.proc.exitCode, 0);
    const events = readAuditEvents(await readFile(auditLog, "utf8"));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.argv, ["audited-cmd", "-t", "abc"]);
    assert.ok(events[0]!.source.length > 0);

    const plain = fakeProcess();
    await runCliApp(auditProbeApp, ["plain-cmd", "-t", "abc"], plain.proc);
    assert.equal(plain.proc.exitCode, 0);

    const off = fakeProcess({ CLAUCTL_AUDIT: "off" });
    await runCliApp(auditProbeApp, ["audited-cmd", "-t", "abc"], off.proc);
    assert.equal(off.proc.exitCode, 0);

    const after = readAuditEvents(await readFile(auditLog, "utf8"));
    assert.equal(after.length, 1);
  });
});

test("recordCommandAudit writes one event per agent dir", async () => {
  await withRegistry(async (dir) => {
    const agentDirs = [join(dir, "abcdef"), join(dir, "zzzzzz")];
    await mkdir(agentDirs[1]!);
    await recordCommandAudit(
      {},
      ["archive", "-t", "abc", "-t", "zzz"],
      agentDirs,
    );
    for (const agentDir of agentDirs) {
      const events = readAuditEvents(
        await readFile(auditLogPath(agentDir), "utf8"),
      );
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]!.argv, ["archive", "-t", "abc", "-t", "zzz"]);
    }
  });
});
