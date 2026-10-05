/*
 * `clauctl list | status` — read-only inspection of the registry. Neither
 * revives dormant agents: a dead daemon is not garbage. `list` is
 * registry-derived (running/dormant/archived/tombstoned/corrupt); `status`
 * also reads a running agent's subscribe seed for whether it needs input.
 */

import { resolve } from "node:path";
import {
  booleanFlag,
  commandMultiTarget,
  commandNoTarget,
  stringFlag,
  type InferFlags,
} from "../core/generated/cli.ts";
import {
  multiTargets,
  type CommandContext,
} from "../core/generated/targets.ts";
import {
  type AgentRecord,
  agentSocketPath,
  classifyAgentDir,
  isPidAlive,
  listAgentIds,
} from "../core/registry.ts";
import { allPendingAsks, isInputNeeded } from "../core/agent-state/index.ts";
import type { PermissionRequest } from "../core/protocol/index.ts";
import { SOCKET_CONNECT_DEADLINE_MS } from "../core/generated/constants.ts";
import {
  connectWithRetry,
  type ProtocolClient,
} from "../core/protocol-client/index.ts";
import { pendingAskLine } from "../format/events.ts";

type AgentStatus =
  "running" | "dormant" | "archived" | "tombstoned" | "corrupt";

interface AgentProbe {
  agentId: string;
  status: AgentStatus;
  record?: AgentRecord;
  error?: string;
  /** `isInputNeeded` of a running agent's seed; absent when not probed. */
  inputNeeded?: boolean;
  /** `allPendingAsks` of the same seed; `taskId` absent for the main agent. */
  pendingAsks?: { taskId?: string; request: PermissionRequest }[];
}

/** One subscribe seed from a running agent's daemon; an unreachable daemon
 *  is a warning, and the probe stays registry-only. */
async function withInputNeeded(probe: AgentProbe): Promise<AgentProbe> {
  const record = probe.record;
  if (probe.status !== "running" || record === undefined) {
    return probe;
  }
  let client: ProtocolClient | undefined;
  let replyTimer: NodeJS.Timeout | undefined;
  // A wedged daemon may accept the connection but never answer.
  const replyDeadline = new Promise<never>((_resolve, reject) => {
    replyTimer = setTimeout(
      () =>
        reject(new Error(`no reply within ${SOCKET_CONNECT_DEADLINE_MS}ms`)),
      SOCKET_CONNECT_DEADLINE_MS,
    );
  });
  try {
    client = await connectWithRetry(
      agentSocketPath(record.agentDir),
      SOCKET_CONNECT_DEADLINE_MS,
    );
    const { seed } = await Promise.race([client.subscribe(), replyDeadline]);
    return {
      ...probe,
      inputNeeded: isInputNeeded(seed),
      pendingAsks: allPendingAsks(seed).map(({ task, request }) => ({
        taskId: task?.taskId,
        request,
      })),
    };
  } catch (error) {
    process.stderr.write(
      `clauctl: warning: cannot reach agent ${probe.agentId}'s daemon (${(error as Error).message})\n`,
    );
    return probe;
  } finally {
    clearTimeout(replyTimer);
    client?.close();
  }
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
  if (probe.inputNeeded !== undefined) {
    lines.push(`input-needed: ${probe.inputNeeded ? "yes" : "no"}`);
    lines.push(
      ...(probe.pendingAsks ?? []).map(
        ({ taskId, request }) => `  ${pendingAskLine(request, taskId)}`,
      ),
    );
  }
  return lines.join("\n");
}

const statusFlags = {
  json: booleanFlag("Print JSON"),
};

type StatusFlags = InferFlags<typeof statusFlags>;

async function status(this: CommandContext, flags: StatusFlags): Promise<void> {
  const probes = await Promise.all(
    multiTargets(this).map(async (target) =>
      withInputNeeded(await probeAgent(target.id)),
    ),
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
