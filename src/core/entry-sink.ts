/**
 * Where canonical entries are rendered for the streaming commands (tail,
 * prompt): one push per entry, end() flushes (the cursor line for formatted
 * messages). Shared by every path that emits entries so they cannot diverge.
 * The messages legs run MessageProjector — the projectEntries streaming core;
 * the canonical filter has already been applied by whichever path feeds the
 * sink.
 */

import type { UUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_ENTRY_FORMAT_OPTIONS,
  formatEntryLine,
} from "../format/entries.ts";
import {
  DEFAULT_MESSAGE_FORMAT_OPTIONS,
  MessageFormatter,
} from "../format/messages.ts";
import type { CommandContext } from "./generated/targets.ts";
import type { AgentEvent } from "./protocol.ts";
import type { SessionEntry } from "./session/file.ts";
import { MessageProjector } from "./session/messages.ts";
import { completedEntry } from "./session/structural.ts";

export interface EntrySink {
  push(entry: SessionEntry): void;
  end(): void;
}

export function entrySink(
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

type SessionEntryEvent = Extract<AgentEvent, { kind: "sessionEntry" }>;

/** Feeds an EntrySink from the agent event stream, in file order. A
 *  shared-class user/assistant `sessionEntry` arrives structural (payload
 *  emptied) and is completed from its `sdkMessage` twin before it reaches
 *  the sink, whichever of the two arrives first; everything else passes as
 *  the wire carries it. Entries behind one still awaiting its twin wait
 *  with it, so the sink never sees the file out of order. `join` false
 *  (`--type entries`) passes every entry straight through. end() flushes
 *  whatever is still waiting as it is — a twin that never came is not
 *  worth losing the entry over. */
export class LiveEntryFeed {
  private readonly sink: EntrySink;
  private readonly join: boolean;
  private readonly twins = new Map<UUID, SDKMessage>();
  private readonly waiting: SessionEntryEvent[] = [];

  constructor(sink: EntrySink, join: boolean) {
    this.sink = sink;
    this.join = join;
  }

  recordTwin(message: SDKMessage): void {
    if (
      (message.type === "user" || message.type === "assistant") &&
      message.uuid !== undefined
    ) {
      this.twins.set(message.uuid as UUID, message);
      this.drain();
    }
  }

  push(event: SessionEntryEvent): void {
    this.waiting.push(event);
    this.drain();
  }

  end(): void {
    for (const event of this.waiting) {
      this.sink.push(event.entry);
    }
    this.waiting.length = 0;
    this.sink.end();
  }

  private drain(): void {
    while (this.waiting.length > 0) {
      const head = this.waiting[0]!;
      const uuid = head.entry.uuid;
      const needsTwin =
        this.join &&
        head.expectsSdkMessage &&
        uuid !== undefined &&
        (head.entry.type === "user" || head.entry.type === "assistant");
      if (!needsTwin) {
        this.waiting.shift();
        this.sink.push(head.entry);
        continue;
      }
      const twin = this.twins.get(uuid);
      if (twin === undefined) {
        return;
      }
      this.twins.delete(uuid);
      this.waiting.shift();
      this.sink.push(completedEntry(head.entry, twin));
    }
  }
}
