/**
 * `clauctl tail` — follow an agent as messages (default), entries, or events
 * (docs/specs/tail-parity.md). Messages and entries come from the session
 * file through the canonical entry stream, composed with sdk.sock by
 * AgentObserver so dormancy, rollover, and settlement are observable facts;
 * events are the raw sdk.sock stream. Formatted by default with the exact
 * renderers `format` uses at default options; canonical JSONL behind
 * `--json`, so finite formatted output is byte-equal to `--json` piped
 * through the matching `clauctl format` subcommand.
 *
 * Settlement (spec "Settlement classification"): a met `--until` (after
 * entry catch-up), an expired `--timeout`, a dormant agent's history end,
 * and a socket close during a messages/entries follow are graceful — flush
 * and exit 0. Entry-stream failure, a missing `--since` cursor, `--type
 * events` on a dormant agent, an events close with an unmet `--until`, and
 * catch-up expiry exit 1. tail never revives: watching an agent must not
 * restart it, so it checks the daemon pid itself instead of going through
 * ensureAgentRunning.
 */

import type { UUID } from "node:crypto";
import {
  DEFAULT_ENTRY_FORMAT_OPTIONS,
  formatEntryLine,
} from "../format/entries.ts";
import { EventFormatter } from "../format/events.ts";
import {
  DEFAULT_MESSAGE_FORMAT_OPTIONS,
  MessageFormatter,
} from "../format/messages.ts";
import type { TailRecord } from "../format/types.ts";
import {
  AgentObserver,
  type AgentObservation,
  type AgentObservationState,
} from "./agent-observer.ts";
import {
  booleanFlag,
  commandOneTarget,
  completeChoices,
  enumFlag,
  parsedFlag,
  secondsFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { runStream } from "./generated/streaming/driver.ts";
import { oneTarget, type CommandContext } from "./generated/targets.ts";
import {
  parseUntilCondition,
  secondsToTimerMs,
  UNTIL_COMPLETIONS,
  UNTIL_USAGE,
  type UntilCondition,
} from "./generated/until-engine.ts";
import { fileExists, UsageError } from "./generated/util.ts";
import {
  archivedPath,
  isPidAlive,
  sdkSocketPath,
  type AgentRecord,
} from "./registry.ts";
import { connectWithRetry } from "./sdk-socket.ts";
import {
  canonicalizeEntries,
  type EntryClientOptions,
} from "./session/entry-stream.ts";
import { readSessionEntries, type SessionEntry } from "./session/file.ts";
import { MessageProjector } from "./session/messages.ts";
import { untilMetAtSeed, untilMetByEvent, untilQuietMs } from "./until.ts";
import { SOCKET_CONNECT_DEADLINE_MS } from "./generated/constants.ts";
import { parseUuidFlag } from "./uuid.ts";

/** Bound on the entry catch-up after `--until` fires: the target leaf must
 *  be consumed as an entry observation within this window, or the tail fails
 *  naming it — a flush failure becomes a diagnosis instead of a hang. */
export const CATCHUP_TIMEOUT_MS = 10_000;

const TAIL_TYPES = ["messages", "entries", "events"] as const;
type TailType = (typeof TAIL_TYPES)[number];

const tailFlags = {
  type: enumFlag("Stream type (default messages)", TAIL_TYPES),
  json: booleanFlag("Emit canonical JSONL instead of formatted text"),
  since: parsedFlag(
    "Replay after this session-entry uuid",
    parseUuidFlag,
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

/** Where canonical entries are rendered: one push per entry, end() flushes
 *  (the cursor line for formatted messages). Shared by the dormant and live
 *  paths so they cannot diverge. The messages legs run MessageProjector —
 *  the projectEntries streaming core; the canonical filter has already been
 *  applied by whichever path feeds the sink. */
interface EntrySink {
  push(entry: SessionEntry): void;
  end(): void;
}

function entrySink(
  context: CommandContext,
  type: "messages" | "entries",
  json: boolean,
): EntrySink {
  const write = (text: string): void => {
    if (text !== "") {
      context.process.stdout.write(text);
    }
  };
  if (type === "entries") {
    return {
      push: (entry) =>
        write(
          json
            ? `${JSON.stringify(entry)}\n`
            : `${formatEntryLine(entry, DEFAULT_ENTRY_FORMAT_OPTIONS)}\n`,
        ),
      end: () => {},
    };
  }
  const projector = new MessageProjector();
  if (json) {
    return {
      push: (entry) => {
        for (const record of projector.push(entry)) {
          write(`${JSON.stringify(record)}\n`);
        }
      },
      end: () => {},
    };
  }
  const formatter = new MessageFormatter(DEFAULT_MESSAGE_FORMAT_OPTIONS);
  return {
    push: (entry) => {
      for (const record of projector.push(entry)) {
        write(formatter.push(record));
      }
    },
    end: () => write(formatter.end()),
  };
}

/** `--until` settlement with entry catch-up (spec "`--until` settlement and
 *  entry catch-up"): conditions are evaluated on the sdk side of the
 *  observation stream; when one fires, the target leaf is recorded and the
 *  tail settles once that entry has been consumed as an entry observation.
 *  Consumption is tracked here rather than via EntryStreamState.seenUuids —
 *  that set is shared by reference with the file scanner and already holds
 *  every history uuid at seed time, so testing it would settle before the
 *  queued history rendered. Owns the bounded catch-up deadline. Exported for
 *  tests, which inject a short deadline. */
export class UntilSettlement {
  private readonly condition: UntilCondition | undefined;
  private readonly describeFile: () => string | undefined;
  private readonly catchupTimeoutMs: number;
  private readonly consumedUuids = new Set<UUID>();
  private conditionMet = false;
  /** The leaf awaited since the condition fired; unset once nothing is owed. */
  private target: UUID | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private rejectExpiry: ((error: Error) => void) | undefined;
  /** Rejects when the catch-up deadline expires; never resolves. Race the
   *  stream against it. */
  readonly expiry: Promise<never>;

  constructor(
    condition: UntilCondition | undefined,
    describeFile: () => string | undefined,
    catchupTimeoutMs = CATCHUP_TIMEOUT_MS,
  ) {
    this.condition = condition;
    this.describeFile = describeFile;
    this.catchupTimeoutMs = catchupTimeoutMs;
    this.expiry = new Promise((_resolve, reject) => {
      this.rejectExpiry = reject;
    });
  }

  /** true = settle immediately: the condition holds with nothing to catch
   *  up. false with a met condition starts the catch-up — queued history
   *  drains and renders until the target leaf is consumed. */
  metAtSeed(seed: AgentObservationState): boolean {
    if (
      this.condition === undefined ||
      !untilMetAtSeed(this.condition, seed.sdk)
    ) {
      return false;
    }
    return this.beginCatchup(seed.sdk.leaf?.uuid);
  }

  /** true = settle the stream. */
  observe(
    observation: AgentObservation,
    state: AgentObservationState,
  ): boolean {
    if (observation.source === "entry") {
      if (typeof observation.entry.uuid === "string") {
        this.consumedUuids.add(observation.entry.uuid);
      }
      return this.target !== undefined && this.consumedUuids.has(this.target);
    }
    if (
      this.conditionMet ||
      this.condition === undefined ||
      !untilMetByEvent(this.condition, observation.event, state.sdk)
    ) {
      return false;
    }
    return this.beginCatchup(state.sdk.leaf?.uuid);
  }

  /** Clear the deadline timer; call when the stream ends for any reason. */
  dispose(): void {
    clearTimeout(this.expiryTimer);
  }

  private beginCatchup(target: UUID | undefined): boolean {
    this.conditionMet = true;
    if (target === undefined || this.consumedUuids.has(target)) {
      return true;
    }
    this.target = target;
    this.expiryTimer = setTimeout(() => {
      this.rejectExpiry?.(
        new Error(
          `--until condition met, but its target entry ${target} did not ` +
            `appear in ${this.describeFile() ?? "the session file"} within ` +
            `${this.catchupTimeoutMs}ms`,
        ),
      );
    }, this.catchupTimeoutMs);
    return false;
  }
}

/** Finite path for a dormant/archived agent: latest session file, canonical,
 *  through the same sink as the live path. Any `--until` is trivially met (a
 *  dead process is conclusive inactivity), so history is emitted and the
 *  command exits 0. */
function tailDormant(
  context: CommandContext,
  agent: AgentRecord,
  type: "messages" | "entries",
  json: boolean,
  since: UUID | undefined,
): void {
  const sink = entrySink(context, type, json);
  const sessionFile = agent.sessions.at(-1)?.sessionFile;
  if (sessionFile === undefined) {
    if (since !== undefined) {
      throw new Error(
        `agent '${agent.id}' has no session file to resolve the since cursor against`,
      );
    }
    sink.end();
    return;
  }
  let canonical: SessionEntry[];
  try {
    canonical = canonicalizeEntries(readSessionEntries(sessionFile), since);
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

/** Live messages/entries: AgentObserver's merged stream, entries rendered
 *  through the sink, `--until` settled with entry catch-up. A merged-stream
 *  close is graceful unless the observer failed: the daemon exiting is
 *  conclusive idleness, and the observer has already drained the visible
 *  file bytes. */
async function tailObserved(
  context: CommandContext,
  agent: AgentRecord,
  type: "messages" | "entries",
  json: boolean,
  since: UUID | undefined,
  condition: UntilCondition | undefined,
  timeoutMs: number | undefined,
): Promise<void> {
  const sink = entrySink(context, type, json);
  const options: EntryClientOptions = {
    history: "emit",
    ...(since !== undefined && { since }),
  };
  const observer = new AgentObserver(agent, options);
  const settlement = new UntilSettlement(
    condition,
    () => observer.sessionFilePath,
  );
  try {
    const { outcome } = await Promise.race([
      runStream(
        observer,
        {
          onSeed: (seed) => settlement.metAtSeed(seed),
          onEvent: (observation, state) => {
            if (observation.source === "entry") {
              sink.push(observation.entry);
            }
            return settlement.observe(observation, state);
          },
          quietMs:
            condition === undefined ? undefined : untilQuietMs(condition),
        },
        timeoutMs,
      ),
      settlement.expiry,
    ]);
    if (outcome === "closed" && observer.failure !== undefined) {
      throw observer.failure;
    }
    sink.end();
  } finally {
    settlement.dispose();
    observer.close();
  }
}

/** Live events: the sdk.sock stream in today's framing (`--json`) or through
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
    sdkSocketPath(agent.agentDir),
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
      throw new Error("sdk socket closed before condition met");
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
          `tail never revives — send it a command (e.g. \`clauctl query\`) ` +
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
  await tailObserved(
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
