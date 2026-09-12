/**
 * The composed observation client (docs/specs/tail-parity.md): sdk.sock plus
 * the session entry stream as one StreamClient — the interface we wish the
 * Claude Agent SDK provided. The sdk side is subscribed first so no init can
 * be missed; the entry side follows the session file resolved from the seed
 * (else the agent record's last session, else it idles until the first init
 * announces one). A system/init announcing a new session_id rolls the entry
 * side over to the new file, carrying the canonical filter so cross-file
 * re-persistence stays first-wins deduplicated. Socket close is conclusive
 * idleness: the observer drains the file bytes already visible, delivers
 * them, then closes the merged stream — the consumer classifies the close.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { initialAgentState, type AgentState } from "./agent-state.ts";
import { AsyncQueue } from "./generated/streaming/async-queue.ts";
import type {
  StreamClient,
  StreamEvent,
  StreamSubscription,
} from "./generated/streaming/driver.ts";
import { sdkSocketPath, type AgentRecord } from "./registry.ts";
import {
  connectWithRetry,
  SdkSocketClient,
  type AgentEvent,
  type AgentEventSubscription,
} from "./sdk-socket.ts";
import {
  SessionEntryClient,
  type CanonicalEntryFilter,
  type EntryClientOptions,
  type EntryStreamState,
} from "./session/entry-stream.ts";
import {
  awaitFileExists,
  SESSION_FILE_TIMEOUT_MS,
} from "./session/await-file-exists.ts";
import { projectKey, type SessionEntry } from "./session/file.ts";
import { SOCKET_CONNECT_DEADLINE_MS } from "./generated/constants.ts";

export type AgentObservation =
  | Readonly<{ source: "entry"; entry: SessionEntry }>
  | Readonly<{ source: "sdk"; event: AgentEvent }>;

export interface AgentObservationState {
  /** Folded via nextAgentState from the subscription seed. */
  readonly sdk: AgentState;
  /** leaf + seenUuids; the dedup set is carried across rollovers. */
  readonly entries: EntryStreamState;
}

/** The session_id a stream event announces a (possibly new) session with. */
function announcedSessionId(event: AgentEvent): string | undefined {
  return event.kind === "sdkMessage" &&
    event.message.type === "system" &&
    event.message.subtype === "init"
    ? event.message.session_id
    : undefined;
}

export class AgentObserver implements StreamClient<
  AgentObservation,
  AgentObservationState
> {
  private readonly agent: AgentRecord;
  private readonly options: EntryClientOptions;
  private readonly merged = new AsyncQueue<
    StreamEvent<AgentObservation, AgentObservationState>
  >();
  private sdkClient: SdkSocketClient | undefined;
  private entryClient: SessionEntryClient | undefined;
  /** The running entry pump; awaited before the merged stream may end, so
   *  drained entries always reach the consumer. */
  private entryPump: Promise<void> = Promise.resolve();
  private carriedFilter: CanonicalEntryFilter | undefined;
  private sdkState: AgentState = initialAgentState();
  /** Starts empty: a fresh agent has no session file until its first init. */
  private entryState: EntryStreamState = { seenUuids: new Set() };
  private currentSessionId: string | undefined;
  private currentFilePath: string | undefined;
  private observerFailure: Error | undefined;
  private closed = false;

  constructor(agent: AgentRecord, options: EntryClientOptions) {
    this.agent = agent;
    this.options = options;
  }

  /** Entry-stream failure, rollover failure, or socket error; undefined for
   *  a clean close. */
  get failure(): Error | undefined {
    return this.observerFailure;
  }

  /** The session file currently followed; undefined until a fresh agent's
   *  first init announces one. */
  get sessionFilePath(): string | undefined {
    return this.currentFilePath;
  }

  async subscribe(): Promise<
    StreamSubscription<AgentObservation, AgentObservationState>
  > {
    try {
      this.sdkClient = await connectWithRetry(
        sdkSocketPath(this.agent.agentDir),
        SOCKET_CONNECT_DEADLINE_MS,
      );
      const sdkSubscription = await this.sdkClient.subscribe();
      this.sdkState = sdkSubscription.seed;
      const sessionId =
        sdkSubscription.seed.querySessionId ??
        this.agent.sessions.at(-1)?.sessionId;
      if (sessionId !== undefined) {
        await this.openEntryClient(sessionId, this.options);
      } else if (
        this.options.history === "emit" &&
        this.options.since !== undefined
      ) {
        throw new Error(
          `agent '${this.agent.id}' has no session file to resolve the since cursor against`,
        );
      }
      const seed: AgentObservationState = {
        sdk: this.sdkState,
        entries: this.entryState,
      };
      void this.pumpSdk(sdkSubscription);
      return { seed, events: this.merged };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.sdkClient?.close();
    this.entryClient?.close();
    this.merged.close();
  }

  private fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.observerFailure =
      error instanceof Error ? error : new Error(String(error));
    this.close();
  }

  private async pumpSdk(subscription: AgentEventSubscription): Promise<void> {
    try {
      for await (const { event, state } of subscription.events) {
        this.sdkState = state;
        this.merged.push({
          event: { source: "sdk", event },
          state: { sdk: state, entries: this.entryState },
        });
        const sessionId = announcedSessionId(event);
        if (sessionId !== undefined && sessionId !== this.currentSessionId) {
          await this.rollover(sessionId);
        }
      }
      // Socket close: drain the file bytes already visible, let the entry
      // pump deliver them, then end the merged stream.
      this.entryClient?.drainVisibleBytes();
      this.entryClient?.close();
      await this.entryPump;
      this.merged.close();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Switch the entry side to the announced session's file: close the old
   *  client, await the new file's existence, open with the carried filter
   *  (cross-file first-wins dedup) — history "emit", no since. */
  private async rollover(sessionId: string): Promise<void> {
    this.entryClient?.close();
    await this.entryPump;
    if (this.closed) {
      return;
    }
    await this.openEntryClient(sessionId, { history: "emit" });
  }

  private async openEntryClient(
    sessionId: string,
    options: EntryClientOptions,
  ): Promise<void> {
    const filePath = this.resolveSessionFile(sessionId);
    await awaitFileExists(filePath, SESSION_FILE_TIMEOUT_MS);
    const client = new SessionEntryClient(
      filePath,
      options,
      this.carriedFilter,
    );
    const subscription = await client.subscribe();
    this.entryClient = client;
    this.carriedFilter = client.filter;
    this.currentSessionId = sessionId;
    this.currentFilePath = filePath;
    this.entryState = subscription.seed;
    this.entryPump = this.pumpEntries(client, subscription);
  }

  private async pumpEntries(
    client: SessionEntryClient,
    subscription: StreamSubscription<SessionEntry, EntryStreamState>,
  ): Promise<void> {
    for await (const { event, state } of subscription.events) {
      this.entryState = state;
      this.merged.push({
        event: { source: "entry", entry: event },
        state: { sdk: this.sdkState, entries: state },
      });
    }
    // A clean close (rollover, observer close) ends the loop with no failure.
    if (client.failure !== undefined) {
      this.fail(client.failure);
    }
  }

  private resolveSessionFile(sessionId: string): string {
    const known = this.agent.sessions.find(
      (session) => session.sessionId === sessionId,
    );
    if (known !== undefined) {
      return known.sessionFile;
    }
    // The project directory never changes for an agent (same cwd), so a
    // session the record has not caught up with lives beside the last known
    // one. With no sessions at all, resolve the directory the way the daemon
    // resolves it for the CLI child (daemon.ts): CLAUDE_CONFIG_DIR from the
    // persisted env over ours, else ~/.claude.
    const lastKnown = this.agent.sessions.at(-1);
    const projectDir =
      lastKnown !== undefined
        ? dirname(lastKnown.sessionFile)
        : join(
            this.agent.persistedOptions.env?.CLAUDE_CONFIG_DIR ??
              process.env.CLAUDE_CONFIG_DIR ??
              join(homedir(), ".claude"),
            "projects",
            projectKey(this.agent.cwd),
          );
    return join(projectDir, `${sessionId}.jsonl`);
  }
}
