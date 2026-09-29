/**
 * `clauctl tail` — follow an agent as messages (default), entries, or events
 * (docs/specs/tail-parity.md). A live agent is followed on the daemon's
 * agent event stream (docs/specs/session-tracker.md, Data flow 6): subscribe,
 * fetch the snapshot, print it, then print the `sessionEntry` events that
 * follow it — for messages, completed from their `sdkMessage` twins
 * (entry-sink.ts). A dormant agent's history is read from its session file.
 * Formatted by default with the exact renderers `format` uses at default
 * options; canonical JSONL behind `--json`, so finite formatted output is
 * byte-equal to `--json` piped through the matching `clauctl format`
 * subcommand.
 *
 * Settlement (spec "Settlement classification"): a met `--until` (once the
 * query file settles), an expired `--timeout`, a dormant agent's history end,
 * and a socket close during a messages/entries follow are graceful — flush
 * and exit 0. A missing `--since` cursor, `--type events` on a dormant
 * agent, an events close with an unmet `--until`, and a settle-wait expiry
 * exit 1. tail never revives: watching an agent must not restart it, so it
 * checks the daemon pid itself instead of going through ensureAgentRunning.
 */

import type { UUID } from "node:crypto";
import { EventFormatter } from "../format/events.ts";
import { DEFAULT_MESSAGE_FORMAT_OPTIONS } from "../format/messages.ts";
import type { TailRecord } from "../format/types.ts";
import {
  describeSession,
  querySession,
  SETTLE_TIMEOUT_MS,
  settled,
} from "../core/agent-state/index.ts";
import type {
  AgentState,
  AgentEvent,
  GetEntriesResponse,
} from "../core/protocol/index.ts";
import { entrySink } from "./entry-sink.ts";
import {
  booleanFlag,
  commandOneTarget,
  completeChoices,
  enumFlag,
  parsedFlag,
  secondsFlag,
  type InferFlags,
} from "../core/generated/cli.ts";
import { runStream } from "../core/generated/streaming/driver.ts";
import { oneTarget, type CommandContext } from "../core/generated/targets.ts";
import {
  secondsToTimerMs,
  type UntilCondition,
} from "../core/generated/until-engine.ts";
import {
  parseUntilCondition,
  UNTIL_COMPLETIONS,
  UNTIL_USAGE,
} from "../core/until.ts";
import { fileExists, UsageError } from "../core/generated/util.ts";
import {
  archivedPath,
  isPidAlive,
  agentSocketPath,
  type AgentRecord,
} from "../core/registry.ts";
import { sessionEntryUuids } from "./sdk-commands.ts";
import { connectWithRetry } from "../core/protocol-client/index.ts";
import { canonicalizeEntries } from "../core/session/entry-stream.ts";
import { readSessionEntries, type SessionEntry } from "../core/session/file.ts";
import {
  untilMetAtSeed,
  untilMetByEvent,
  untilQuietMs,
} from "../core/until.ts";
import { SOCKET_CONNECT_DEADLINE_MS } from "../core/generated/constants.ts";
import {
  parseUuidPrefixFlag,
  resolveUuidPrefix,
  UUID_PATTERN,
} from "../core/uuid.ts";

const TAIL_TYPES = ["messages", "entries", "events"] as const;
type TailType = (typeof TAIL_TYPES)[number];

const tailFlags = {
  type: enumFlag("Stream type (default messages)", TAIL_TYPES),
  json: booleanFlag("Emit canonical JSONL instead of formatted text"),
  since: parsedFlag(
    "Replay after this session-entry uuid (any unique prefix)",
    parseUuidPrefixFlag,
    "uuid",
  ),
  until: parsedFlag(
    `Stream until ${UNTIL_USAGE}`,
    parseUntilCondition,
    "cond",
    completeChoices(UNTIL_COMPLETIONS),
  ),
  timeout: secondsFlag(),
};

type TailFlags = InferFlags<typeof tailFlags>;

/** `--until` settlement. A condition is met by one event (turn-end: the
 *  `result` message), and at that moment the log may still lack the entries
 *  the condition is about. So the condition latches, and the stream settles
 *  once the query file is settled — those entries have reached the log, and
 *  so the output. The wait is bounded by `settleTimeoutMs` (a constructor
 *  parameter so tests can inject a short one). */
export class UntilSettlement {
  private readonly condition: UntilCondition | undefined;
  private readonly settleTimeoutMs: number;
  private latched = false;
  private lastState: AgentState | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private rejectExpiry: ((error: Error) => void) | undefined;
  /** Rejects when the settle wait expires; never resolves. Race the stream
   *  against it. */
  readonly expiry: Promise<never>;

  constructor(
    condition: UntilCondition | undefined,
    settleTimeoutMs = SETTLE_TIMEOUT_MS,
  ) {
    this.condition = condition;
    this.settleTimeoutMs = settleTimeoutMs;
    this.expiry = new Promise((_resolve, reject) => {
      this.rejectExpiry = reject;
    });
  }

  /** true = settle immediately: the condition holds at the seed and the
   *  query file is settled. */
  metAtSeed(state: AgentState): boolean {
    return (
      this.condition !== undefined &&
      untilMetAtSeed(this.condition, state) &&
      this.latch(state)
    );
  }

  /** true = settle the stream. */
  observe(event: AgentEvent, state: AgentState): boolean {
    if (this.latched) {
      return this.settledAt(state);
    }
    return (
      this.condition !== undefined &&
      untilMetByEvent(this.condition, event, state) &&
      this.latch(state)
    );
  }

  /** Clear the deadline timer; call when the stream ends for any reason. */
  dispose(): void {
    clearTimeout(this.expiryTimer);
  }

  private latch(state: AgentState): boolean {
    this.latched = true;
    if (this.settledAt(state)) {
      return true;
    }
    this.expiryTimer = setTimeout(() => {
      const last = this.lastState;
      const file =
        last?.querySessionId === undefined
          ? "no query file"
          : `query file ${last.querySessionId}: ${describeSession(querySession(last))}`;
      this.rejectExpiry?.(
        new Error(
          `--until condition met, but the log did not settle within ` +
            `${this.settleTimeoutMs}ms; ${file}`,
        ),
      );
    }, this.settleTimeoutMs);
    return false;
  }

  private settledAt(state: AgentState): boolean {
    this.lastState = state;
    if (!settled(state)) {
      return false;
    }
    clearTimeout(this.expiryTimer);
    return true;
  }
}

/** Finite path for a dormant/archived agent: latest session file, canonical,
 *  through the same sink as the live path. Any `--until` is trivially met (a
 *  dead process is conclusive inactivity), so history is emitted and the
 *  command exits 0. A `--since` prefix resolves against the same file — tail
 *  never revives, so there is no daemon to ask. */
function tailDormant(
  context: CommandContext,
  agent: AgentRecord,
  type: "messages" | "entries",
  json: boolean,
  sinceFlag: string | undefined,
): void {
  const sink = entrySink(context, type, json);
  const sessionFile = agent.sessions.at(-1)?.sessionFile;
  if (sessionFile === undefined) {
    if (sinceFlag !== undefined) {
      throw new Error(
        `agent '${agent.id}' has no session file to resolve the since cursor against`,
      );
    }
    sink.end();
    return;
  }
  const entries = readSessionEntries(sessionFile);
  const since =
    sinceFlag === undefined || UUID_PATTERN.test(sinceFlag)
      ? (sinceFlag as UUID | undefined)
      : resolveUuidPrefix(
          sinceFlag,
          new Set(entries.map((entry) => entry.uuid).filter(hasStringUuid)),
        );
  let canonical: SessionEntry[];
  try {
    canonical = canonicalizeEntries(entries, since);
  } catch (error) {
    throw since === undefined
      ? error
      : new Error(
          `since cursor ${since} does not match any entry in ${sessionFile}`,
        );
  }
  for (const entry of canonical) {
    sink.push(entry);
  }
  sink.end();
}

const hasStringUuid = (uuid: unknown): uuid is UUID => typeof uuid === "string";

/** Live messages/entries on the agent event stream: subscribe (events
 *  buffer), fetch the snapshot, print it, skip the `sessionEntry` events
 *  queued before the response (they are in the snapshot), then print live
 *  ones. Entries already printed are not printed again when a later file
 *  re-persists them (first-wins across a session rollover). A socket close
 *  is graceful: the daemon exiting is conclusive idleness. */
async function tailLive(
  context: CommandContext,
  agent: AgentRecord,
  type: "messages" | "entries",
  json: boolean,
  sinceFlag: string | undefined,
  condition: UntilCondition | undefined,
  timeoutMs: number | undefined,
): Promise<void> {
  const client = await connectWithRetry(
    agentSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  const settlement = new UntilSettlement(condition);
  try {
    // A full --since uuid passes through unchecked (the daemon's cursor
    // error keeps that job); a prefix resolves against the daemon's uuids.
    const since =
      sinceFlag === undefined || UUID_PATTERN.test(sinceFlag)
        ? (sinceFlag as UUID | undefined)
        : resolveUuidPrefix(sinceFlag, await sessionEntryUuids(client));
    const subscription = await client.subscribe();
    const { data, eventsBefore } = await client.requestWithEventCount({
      type: "get-entries",
      payload: "full",
      ...(since !== undefined && { since }),
    });
    const snapshot = data as GetEntriesResponse;
    const sink = entrySink(context, type, json);
    for (const entry of snapshot.entries!) {
      sink.push(entry);
    }
    const emittedUuids = new Set<UUID>(snapshot.uuids);
    let position = 0;
    await Promise.race([
      runStream(
        { subscribe: () => Promise.resolve(subscription) },
        {
          onSeed: (seed) => settlement.metAtSeed(seed),
          onEvent: (event, state) => {
            position += 1;
            if (event.kind === "sessionEntry" && position > eventsBefore) {
              const uuid = event.entry.uuid;
              if (uuid === undefined || !emittedUuids.has(uuid)) {
                if (uuid !== undefined) {
                  emittedUuids.add(uuid);
                }
                sink.push(event.entry);
              }
            }
            return settlement.observe(event, state);
          },
          quietMs:
            condition === undefined ? undefined : untilQuietMs(condition),
        },
        timeoutMs,
      ),
      settlement.expiry,
    ]);
    sink.end();
  } finally {
    settlement.dispose();
    client.close();
  }
}

/** Live events: the protocol event stream in today's framing (`--json`) or through
 *  EventFormatter. A close with an unmet `--until` is an error — events have
 *  no file to give the dormancy reading. */
async function tailEvents(
  context: CommandContext,
  agent: AgentRecord,
  json: boolean,
  condition: UntilCondition | undefined,
  timeoutMs: number | undefined,
): Promise<void> {
  const client = await connectWithRetry(
    agentSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  const formatter = json
    ? undefined
    : new EventFormatter(DEFAULT_MESSAGE_FORMAT_OPTIONS);
  const write = (record: TailRecord): void => {
    const text =
      formatter === undefined
        ? `${JSON.stringify(record)}\n`
        : formatter.push(record);
    if (text !== "") {
      context.process.stdout.write(text);
    }
  };
  try {
    const { outcome } = await runStream(
      client,
      {
        onSeed: (snapshot) => {
          write({ snapshot });
          return condition !== undefined && untilMetAtSeed(condition, snapshot);
        },
        onEvent: (event, state) => {
          write({ event });
          return (
            condition !== undefined && untilMetByEvent(condition, event, state)
          );
        },
        quietMs: condition === undefined ? undefined : untilQuietMs(condition),
      },
      timeoutMs,
    );
    if (outcome === "closed" && condition !== undefined) {
      throw new Error("agent socket closed before condition met");
    }
    if (formatter !== undefined) {
      const text = formatter.end();
      if (text !== "") {
        context.process.stdout.write(text);
      }
    }
  } finally {
    client.close();
  }
}

async function tail(this: CommandContext, flags: TailFlags): Promise<void> {
  const type: TailType = flags.type ?? "messages";
  const condition = flags.until;
  // Validated before the dormancy check and connection: a malformed flag is
  // a usage error regardless of the agent's state.
  const timeoutMs =
    flags.timeout === undefined ? undefined : secondsToTimerMs(flags.timeout);
  if (type === "events" && flags.since !== undefined) {
    throw new UsageError(
      "--since replays session entries; --type events has no historical event log",
    );
  }
  const agent = oneTarget(this);
  if (!isPidAlive(agent.daemonPid)) {
    if (type === "events") {
      const state = (await fileExists(archivedPath(agent.agentDir)))
        ? "archived"
        : "dormant";
      throw new Error(
        `agent '${agent.id}' is ${state}; there is no live event source and ` +
          `tail never revives — send it a command (e.g. \`clauctl prompt\`) ` +
          `to revive it first`,
      );
    }
    tailDormant(this, agent, type, flags.json, flags.since);
    return;
  }
  if (type === "events") {
    await tailEvents(this, agent, flags.json, condition, timeoutMs);
    return;
  }
  await tailLive(
    this,
    agent,
    type,
    flags.json,
    flags.since,
    condition,
    timeoutMs,
  );
}

export const tailRoute = {
  tail: commandOneTarget<TailFlags>({
    common: true,
    docs: { brief: "follow the agent as messages, entries, or events" },
    parameters: { flags: tailFlags },
    func: tail,
  }),
} as const;
