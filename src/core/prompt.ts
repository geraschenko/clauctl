/**
 * `clauctl prompt` — submit input and stream the turn it causes
 * (docs/specs/prompt-parity.md), rendered by exactly the machinery tail uses.
 * The observation stream is subscribed before the input is submitted (a fast
 * turn cannot be missed), submission happens on a separate short-lived
 * sdk.sock connection, and output plus `--until` evaluation are gated on the
 * `userMessageDequeued` event carrying the acceptance receipt's queue id —
 * so a busy agent's unrelated activity is not mistaken for our turn.
 * `/compact` bypasses the queue model (the receipt is undefined), so its
 * stream runs ungated until the terminating result.
 *
 * Settlement: condition met → flush and exit 0; `--timeout` expiry →
 * UntilTimeoutError (exit 3, like wait — prompt has a condition it failed to
 * reach); stream close before the condition is met → exit 1 (the daemon
 * dying mid-prompt is not conclusive success, unlike tail's dormancy
 * reading). `-d`/`--detach` preserves fire-and-forget: submit, print nothing
 * (the receipt is internal), exit 0; `--no-query` implies it.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type {
  ContentBlockParam,
  ImageBlockParam,
} from "@anthropic-ai/sdk/resources";
import { EventFormatter } from "../format/events.ts";
import { DEFAULT_MESSAGE_FORMAT_OPTIONS } from "../format/messages.ts";
import type { TailRecord } from "../format/types.ts";
import {
  AgentObserver,
  type AgentObservation,
  type AgentObservationState,
} from "./agent-observer.ts";
import { entrySink } from "./entry-sink.ts";
import {
  booleanFlag,
  commandOneTarget,
  completeChoices,
  enumFlag,
  parsedFlag,
  secondsFlag,
  stringArg,
  variadicStringFlag,
  type InferFlags,
} from "./generated/cli.ts";
import { SOCKET_CONNECT_DEADLINE_MS } from "./generated/constants.ts";
import { runStream, type StreamClient } from "./generated/streaming/driver.ts";
import { oneTarget, type CommandContext } from "./generated/targets.ts";
import {
  parseUntilCondition,
  secondsToTimerMs,
  UNTIL_COMPLETIONS,
  UNTIL_USAGE,
  UntilTimeoutError,
  type UntilCondition,
} from "./generated/until-engine.ts";
import { UsageError } from "./generated/util.ts";
import { ensureAgentRunning } from "./lifecycle.ts";
import { sdkSocketPath, type AgentRecord } from "./registry.ts";
import { connectWithRetry, type AgentEvent } from "./sdk-socket.ts";
import { UntilSettlement } from "./tail.ts";
import { untilMetByEvent, untilQuietMs } from "./until.ts";

const PROMPT_TYPES = ["messages", "entries", "events"] as const;

const PRIORITIES = ["now", "next", "later"] as const;

const promptFlags = {
  type: enumFlag("Stream type (default messages)", PROMPT_TYPES),
  json: booleanFlag("Emit canonical JSONL instead of formatted text"),
  until: parsedFlag(
    `Stream until ${UNTIL_USAGE} (default turn-end)`,
    parseUntilCondition,
    "cond",
    completeChoices(UNTIL_COMPLETIONS),
  ),
  timeout: secondsFlag(),
  detach: booleanFlag("Submit and exit without streaming"),
  priority: enumFlag("Queue placement (now|next|later)", PRIORITIES),
  image: variadicStringFlag("Attach an image file (repeatable)", "path"),
  noQuery: booleanFlag(
    "Append to the transcript without triggering a turn (implies --detach)",
  ),
};

type PromptFlags = InferFlags<typeof promptFlags>;

type ImageMediaType = ImageBlockParam["source"] extends infer S
  ? S extends { media_type: infer M }
    ? M
    : never
  : never;

const IMAGE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function imageBlock(path: string): Promise<ImageBlockParam> {
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
  if (mediaType === undefined) {
    throw new UsageError(
      `--image ${path}: unsupported extension (expected ` +
        `${Object.keys(IMAGE_MEDIA_TYPES).join("|")})`,
    );
  }
  const data = (await readFile(path)).toString("base64");
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  };
}

/** Opens a short-lived connection, submits, and returns the acceptance
 *  receipt's queue id — undefined for `/compact`, which bypasses the queue
 *  model. The daemon is ours, so a malformed receipt is an internal error. */
async function submitPrompt(
  agent: AgentRecord,
  flags: PromptFlags,
  text: string,
): Promise<number | undefined> {
  const images = await Promise.all(flags.image.map(imageBlock));
  const content: string | ContentBlockParam[] =
    images.length === 0 ? text : [...images, { type: "text", text }];
  const client = await connectWithRetry(
    sdkSocketPath(agent.agentDir),
    SOCKET_CONNECT_DEADLINE_MS,
  );
  try {
    const data = await client.request({
      type: "prompt",
      content,
      ...(flags.priority !== undefined && { priority: flags.priority }),
      ...(flags.noQuery && { shouldQuery: false }),
    });
    if (data === undefined) {
      return undefined;
    }
    const id = (data as { id?: unknown }).id;
    if (typeof id !== "number") {
      throw new Error(`malformed prompt receipt: ${JSON.stringify(data)}`);
    }
    return id;
  } finally {
    client.close();
  }
}

/** Whether this event announces the dequeue of our own message. */
function opensGate(event: AgentEvent, promptId: number | undefined): boolean {
  return (
    promptId !== undefined &&
    event.kind === "userMessageDequeued" &&
    event.ids.includes(promptId)
  );
}

/** Messages/entries leg: AgentObserver (history "skip") + EntrySink +
 *  UntilSettlement, output and condition checks gated by a closure boolean
 *  flipped by our dequeue event. `submitPromptFn` is deferred until after the
 *  subscription is established, so the dequeue cannot be missed. The gate
 *  starts open when it returns no receipt (the `/compact` path). */
async function promptObserved(
  context: CommandContext,
  agent: AgentRecord,
  type: "messages" | "entries",
  json: boolean,
  submitPromptFn: () => Promise<number | undefined>,
  condition: UntilCondition,
  timeoutMs: number | undefined,
): Promise<void> {
  const sink = entrySink(context, type, json);
  const observer = new AgentObserver(agent, { history: "skip" });
  const settlement = new UntilSettlement(
    condition,
    () => observer.sessionFilePath,
  );
  let promptId: number | undefined;
  let gateOpen = false;
  const subscribeThenSubmit: StreamClient<
    AgentObservation,
    AgentObservationState
  > = {
    subscribe: async () => {
      const subscription = await observer.subscribe();
      promptId = await submitPromptFn();
      gateOpen = promptId === undefined;
      return subscription;
    },
  };
  try {
    const { outcome } = await Promise.race([
      runStream(
        subscribeThenSubmit,
        {
          // The seed predates our submission by construction: the turn we
          // caused is ahead of it, so the condition is never met at the seed.
          onSeed: () => false,
          onEvent: (observation, state) => {
            if (!gateOpen) {
              if (observation.source === "entry") {
                // Dropped from output, but still recorded as consumed so the
                // catch-up never waits for an entry that already streamed
                // past (the steer-path caveat); cannot settle — no condition
                // has fired before the gate opens.
                return settlement.observe(observation, state);
              }
              gateOpen = opensGate(observation.event, promptId);
              return false;
            }
            if (observation.source === "entry") {
              sink.push(observation.entry);
            }
            return settlement.observe(observation, state);
          },
          quietMs: untilQuietMs(condition),
        },
        timeoutMs,
      ),
      settlement.expiry,
    ]);
    if (outcome === "closed") {
      throw observer.failure ?? new Error("stream closed before condition met");
    }
    if (outcome === "timeout") {
      throw new UntilTimeoutError(
        `condition not met within ${timeoutMs! / 1000}s`,
      );
    }
    sink.end();
  } finally {
    settlement.dispose();
    observer.close();
  }
}

/** Events leg: a plain sdk.sock subscription with the same gate. No seed
 *  snapshot and no cursor — the window opens at our dequeue event, inclusive
 *  (`tail --type events` is the snapshot-bearing surface). */
async function promptEvents(
  context: CommandContext,
  agent: AgentRecord,
  json: boolean,
  submitPromptFn: () => Promise<number | undefined>,
  condition: UntilCondition,
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
  let promptId: number | undefined;
  let gateOpen = false;
  try {
    const { outcome } = await runStream(
      {
        subscribe: async () => {
          const subscription = await client.subscribe();
          promptId = await submitPromptFn();
          gateOpen = promptId === undefined;
          return subscription;
        },
      },
      {
        onSeed: () => false,
        onEvent: (event, state) => {
          if (!gateOpen) {
            if (!opensGate(event, promptId)) {
              return false;
            }
            gateOpen = true;
          }
          write({ event });
          return untilMetByEvent(condition, event, state);
        },
        quietMs: untilQuietMs(condition),
      },
      timeoutMs,
    );
    if (outcome === "closed") {
      throw new Error("sdk socket closed before condition met");
    }
    if (outcome === "timeout") {
      throw new UntilTimeoutError(
        `condition not met within ${timeoutMs! / 1000}s`,
      );
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

async function promptCommand(
  this: CommandContext,
  flags: PromptFlags,
  text: string,
): Promise<void> {
  const type = flags.type ?? "messages";
  const condition: UntilCondition = flags.until ?? { kind: "turn-end" };
  const timeoutMs =
    flags.timeout === undefined ? undefined : secondsToTimerMs(flags.timeout);
  const detach = flags.detach || flags.noQuery;
  if (
    detach &&
    (flags.type !== undefined ||
      flags.json ||
      flags.until !== undefined ||
      flags.timeout !== undefined)
  ) {
    throw new UsageError(
      "--detach (or --no-query, which implies it) cannot combine with " +
        "--type/--json/--until/--timeout",
    );
  }
  const agent = await ensureAgentRunning(oneTarget(this).id);
  if (detach) {
    await submitPrompt(agent, flags, text);
    return;
  }
  if (type === "events") {
    await promptEvents(
      this,
      agent,
      flags.json,
      () => submitPrompt(agent, flags, text),
      condition,
      timeoutMs,
    );
    return;
  }
  await promptObserved(
    this,
    agent,
    type,
    flags.json,
    () => submitPrompt(agent, flags, text),
    condition,
    timeoutMs,
  );
}

export const promptRoute = {
  prompt: commandOneTarget<PromptFlags, [string]>({
    common: true,
    docs: { brief: "send a turn to the agent and stream it" },
    parameters: {
      flags: promptFlags,
      aliases: { d: "detach" },
      positional: {
        kind: "tuple",
        parameters: [stringArg("Turn text", "text")],
      },
    },
    audited: true,
    func: promptCommand,
  }),
} as const;
