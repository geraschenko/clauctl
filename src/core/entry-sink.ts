/**
 * Where canonical entries are rendered for the streaming commands (tail,
 * prompt): one push per entry, end() flushes (the cursor line for formatted
 * messages). Shared by every path that emits entries so they cannot diverge.
 * The messages legs run MessageProjector — the projectEntries streaming core;
 * the canonical filter has already been applied by whichever path feeds the
 * sink.
 */

import {
  DEFAULT_ENTRY_FORMAT_OPTIONS,
  formatEntryLine,
} from "../format/entries.ts";
import {
  DEFAULT_MESSAGE_FORMAT_OPTIONS,
  MessageFormatter,
} from "../format/messages.ts";
import type { CommandContext } from "./generated/targets.ts";
import type { SessionEntry } from "./session/file.ts";
import { MessageProjector } from "./session/messages.ts";

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
