/*
 * `clauctl list | status` — read-only inspection of the registry. Neither
 * revives dormant agents: a dead daemon is not garbage. Phase 1 is
 * registry-derived only (running/dormant/archived/tombstoned/corrupt); live
 * assistant-state probes arrive with the Phase-2 sdk.sock protocol.
 */

import { resolve } from "node:path";
import {
  booleanFlag,
  commandMultiTarget,
  commandNoTarget,
  stringFlag,
  type InferFlags,
} from "./cli.ts";
import { multiTargets, type CommandContext } from "./targets.ts";
import {
  type AgentRecord,
  classifyAgentDir,
  isPidAlive,
  listAgentIds,
} from "./registry.ts";

type AgentStatus =
  "running" | "dormant" | "archived" | "tombstoned" | "corrupt";

interface AgentProbe {
  agentId: string;
  status: AgentStatus;
  record?: AgentRecord;
  error?: string;
}

async function probeAgent(agentId: string): Promise<AgentProbe> {
  const classified = await classifyAgentDir(agentId);
  if (classified.kind === "tombstoned") {
    return { agentId, status: "tombstoned" };
  }
  if (classified.kind === "corrupt") {
    return { agentId, status: "corrupt", error: classified.error };
  }
  return { agentId, status: classified.kind, record: classified.record };
}

function formatTable(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const listFlags = {
  cwd: stringFlag("Filter by cwd", "path"),
  all: booleanFlag("Include archived agents"),
  json: booleanFlag("Print JSON"),
};

type ListFlags = InferFlags<typeof listFlags>;

async function list(this: CommandContext, flags: ListFlags): Promise<void> {
  const cwdFilter = flags.cwd === undefined ? undefined : resolve(flags.cwd);
  const agentIds = await listAgentIds();
  let probes = await Promise.all(agentIds.map(probeAgent));
  // Archived agents are kept but hidden unless asked for; --cwd matches the
  // agent's recorded working directory exactly (resolved).
  if (!flags.all) {
    probes = probes.filter((probe) => probe.status !== "archived");
  }
  if (cwdFilter !== undefined) {
    probes = probes.filter((probe) => probe.record?.cwd === cwdFilter);
  }
  probes.sort((a, b) =>
    (a.record?.createdAt ?? "").localeCompare(b.record?.createdAt ?? ""),
  );

  if (flags.json) {
    this.process.stdout.write(`${JSON.stringify(probes, null, 2)}\n`);
    return;
  }
  if (probes.length === 0) {
    this.process.stdout.write("no agents\n");
    return;
  }
  const rows = [["ID", "TAG", "STATUS", "CWD", "CREATED"]];
  for (const probe of probes) {
    rows.push([
      probe.agentId.slice(0, 8),
      probe.record?.tag ?? "-",
      probe.status,
      probe.record?.cwd ?? "-",
      probe.record?.createdAt ?? "-",
    ]);
  }
  this.process.stdout.write(`${formatTable(rows)}\n`);
}

const listCommand = commandNoTarget<ListFlags>({
  common: true,
  docs: { brief: "list agents and their status" },
  parameters: {
    flags: listFlags,
    aliases: { a: "all" },
  },
  func: list,
});

function formatProbe(probe: AgentProbe): string {
  const lines = [
    `id:       ${probe.agentId}`,
    `status:   ${probe.status}${probe.error ? ` (${probe.error})` : ""}`,
  ];
  const record = probe.record;
  if (record) {
    if (record.tag !== undefined) {
      lines.push(`tag:      ${record.tag}`);
    }
    lines.push(`cwd:      ${record.cwd}`);
    lines.push(`created:  ${record.createdAt}`);
    lines.push(
      `daemon:   pid ${record.daemonPid}${isPidAlive(record.daemonPid) ? "" : " (dead)"}`,
    );
    if (record.claudeCodeVersion !== undefined) {
      lines.push(`claude:   ${record.claudeCodeVersion}`);
    }
    const currentSession = record.sessions.at(-1);
    lines.push(`session:  ${currentSession?.sessionId ?? "-"}`);
    if (record.sessions.length > 0) {
      lines.push("sessions:");
      for (const entry of record.sessions) {
        lines.push(`  ${entry.sessionId}`);
      }
    }
    lines.push(`options:  ${JSON.stringify(record.persistedOptions)}`);
  }
  return lines.join("\n");
}

const statusFlags = {
  json: booleanFlag("Print JSON"),
};

type StatusFlags = InferFlags<typeof statusFlags>;

async function status(this: CommandContext, flags: StatusFlags): Promise<void> {
  const probes = await Promise.all(
    multiTargets(this).map((target) => probeAgent(target.id)),
  );

  if (flags.json) {
    this.process.stdout.write(`${JSON.stringify(probes, null, 2)}\n`);
    return;
  }
  this.process.stdout.write(`${probes.map(formatProbe).join("\n\n")}\n`);
}

const statusCommand = commandMultiTarget<StatusFlags>({
  docs: { brief: "detailed status of agents" },
  parameters: { flags: statusFlags },
  func: status,
});

export const listRoute = {
  list: listCommand,
} as const;

export const statusRoute = {
  status: statusCommand,
} as const;
