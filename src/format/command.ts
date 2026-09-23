import { buildRouteMap } from "@stricli/core";
import {
  booleanFlag,
  commandNoTarget,
  enumFlag,
  parsedFlag,
  stringArg,
  type InferFlags,
} from "../core/generated/cli.ts";
import { DEFAULT_FORMAT_WIDTH } from "../core/generated/constants.ts";
import { readInputFile } from "../core/generated/read-input.ts";
import type { CommandContext } from "../core/generated/targets.ts";
import { UsageError } from "../core/generated/util.ts";
import { CanonicalEntryFilter } from "../core/session/entry-stream.ts";
import { projectEntries } from "../core/session/messages.ts";
// TDC: format also shouldn't depend on tui--I think we previously decided it should be the other way around when necessary. Make that an eslint rule too. Edit: actually, it looks like we previously allowed format to depend on tui, but that still feels backwards to me. The tui code has to do with interactivity with text, and format only has to do with text, so it seems like the dependency should be in the other direction. What do you think?
import { trackToolNames } from "../tui/entry-views/entry-view.ts";
import {
  DEFAULT_ENTRY_FORMAT_OPTIONS,
  formatEntryLine,
  type EntryFormatOptions,
} from "./entries.ts";
import { EventFormatter } from "./events.ts";
import {
  decodeFormatInput,
  inputChunks,
  parseSnapshotDocument,
} from "./input.ts";
import {
  DEFAULT_MESSAGE_FORMAT_OPTIONS,
  MessageFormatter,
} from "./messages.ts";
import { FILTER_MODES, formatSnapshotDocument } from "./tree.ts";
import type { MessageFormatOptions } from "./types.ts";

function parsePositiveInteger(input: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`invalid positive integer value: ${input}`);
  }
  return value;
}

const formatFlags = {
  toolResults: enumFlag("Tool result display (summary|none|full)", [
    "summary",
    "none",
    "full",
  ]),
  maxToolArgChars: parsedFlag(
    "Maximum tool argument characters",
    parsePositiveInteger,
    "num",
  ),
  maxErrorLines: parsedFlag(
    "Maximum failed tool result snippet lines",
    parsePositiveInteger,
    "num",
  ),
};
type FormatFlags = InferFlags<typeof formatFlags>;

function formatOptions(flags: FormatFlags): MessageFormatOptions {
  return {
    toolResults:
      flags.toolResults ?? DEFAULT_MESSAGE_FORMAT_OPTIONS.toolResults,
    maxToolArgChars:
      flags.maxToolArgChars ?? DEFAULT_MESSAGE_FORMAT_OPTIONS.maxToolArgChars,
    maxErrorLines:
      flags.maxErrorLines ?? DEFAULT_MESSAGE_FORMAT_OPTIONS.maxErrorLines,
  };
}

const filePositional = {
  kind: "tuple",
  parameters: [
    { ...stringArg("Input file or - for stdin", "file"), optional: true },
  ],
} as const;

/** The stream-level kind-mismatch errors (per-record shape errors live in
 *  decodeFormatInput). */
function rejectEvents(): never {
  throw new UsageError("input looks like events; use `clauctl format events`");
}

function rejectMessages(): never {
  throw new UsageError(
    "input looks like canonical message output; use `clauctl format messages`",
  );
}

function rejectEntries(): never {
  throw new UsageError(
    "input looks like session-entry output; use `clauctl format messages` or `clauctl format entries`",
  );
}

async function formatMessages(
  this: CommandContext,
  flags: FormatFlags,
  file?: string,
): Promise<void> {
  const input = await decodeFormatInput(inputChunks(this, file));
  if (input.kind === "empty") {
    return;
  }
  if (input.kind === "events") {
    rejectEvents();
  }
  const records =
    input.kind === "entries" ? projectEntries(input.records) : input.records;
  const formatter = new MessageFormatter(formatOptions(flags));
  for await (const record of records) {
    writeChunk(this, formatter.push(record));
  }
  writeChunk(this, formatter.end());
}

function writeChunk(context: CommandContext, chunk: string): void {
  if (chunk !== "") {
    context.process.stdout.write(chunk);
  }
}

async function formatEvents(
  this: CommandContext,
  flags: FormatFlags,
  file?: string,
): Promise<void> {
  const input = await decodeFormatInput(inputChunks(this, file));
  if (input.kind === "empty") {
    return;
  }
  if (input.kind === "entries") {
    rejectEntries();
  }
  if (input.kind === "messages") {
    rejectMessages();
  }
  const formatter = new EventFormatter(formatOptions(flags));
  for await (const record of input.records) {
    writeChunk(this, formatter.push(record));
  }
  writeChunk(this, formatter.end());
}

const entriesFlags = {
  timestamps: booleanFlag("Prefix each line with the entry timestamp"),
  full: booleanFlag("Append the raw entry JSON after the summary"),
  width: parsedFlag("Output width", parsePositiveInteger, "num"),
};
type EntriesFlags = InferFlags<typeof entriesFlags>;

async function formatEntries(
  this: CommandContext,
  flags: EntriesFlags,
  file?: string,
): Promise<void> {
  const input = await decodeFormatInput(inputChunks(this, file));
  if (input.kind === "empty") {
    return;
  }
  if (input.kind === "events") {
    rejectEvents();
  }
  if (input.kind === "messages") {
    rejectMessages();
  }
  const options: EntryFormatOptions = {
    timestamps: flags.timestamps ?? DEFAULT_ENTRY_FORMAT_OPTIONS.timestamps,
    full: flags.full ?? DEFAULT_ENTRY_FORMAT_OPTIONS.full,
    width: flags.width ?? DEFAULT_ENTRY_FORMAT_OPTIONS.width,
  };
  const filter = new CanonicalEntryFilter();
  const toolNames = new Map<string, string>();
  for await (const entry of input.records) {
    const accepted = filter.accept(entry);
    if (accepted === undefined) {
      continue;
    }
    this.process.stdout.write(
      `${formatEntryLine(accepted, options, toolNames)}\n`,
    );
    trackToolNames(accepted, toolNames);
  }
}

const treeFlags = {
  filter: enumFlag("Tree filter", FILTER_MODES),
  width: parsedFlag("Output width", parsePositiveInteger, "num"),
};
type TreeFlags = InferFlags<typeof treeFlags>;

async function formatTree(
  this: CommandContext,
  flags: TreeFlags,
  file?: string,
): Promise<void> {
  const input = await readInputFile(this, file);
  this.process.stdout.write(
    formatSnapshotDocument(parseSnapshotDocument(input), {
      filter: flags.filter ?? "conversation",
      width: flags.width ?? DEFAULT_FORMAT_WIDTH,
    }),
  );
}

export const formatRoute = {
  format: Object.assign(
    buildRouteMap({
      routes: {
        messages: commandNoTarget<FormatFlags, [string | undefined]>({
          common: true,
          docs: {
            brief:
              "format session-entry or canonical message JSONL as plain text",
          },
          parameters: { flags: formatFlags, positional: filePositional },
          func: formatMessages,
        }),
        events: commandNoTarget<FormatFlags, [string | undefined]>({
          common: true,
          docs: { brief: "format the tail stream as plain text" },
          parameters: { flags: formatFlags, positional: filePositional },
          func: formatEvents,
        }),
        entries: commandNoTarget<EntriesFlags, [string | undefined]>({
          common: true,
          docs: {
            brief:
              "format get-entries or session-file JSONL as one summary line per entry",
          },
          parameters: { flags: entriesFlags, positional: filePositional },
          func: formatEntries,
        }),
        tree: commandNoTarget<TreeFlags, [string | undefined]>({
          common: true,
          docs: {
            brief:
              "format get-entries output or session-file JSONL as a chronological DAG",
          },
          parameters: { flags: treeFlags, positional: filePositional },
          func: formatTree,
        }),
      },
      docs: { brief: "Format raw clauctl output as plain text" },
    }),
    { common: true as const },
  ),
} as const;
