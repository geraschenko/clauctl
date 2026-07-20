import { buildRouteMap } from "@stricli/core";
import {
  commandNoTarget,
  enumFlag,
  parsedFlag,
  stringArg,
  type InferFlags,
} from "../core/generated/cli.ts";
import { readInputFile } from "../core/generated/read-input.ts";
import type { CommandContext } from "../core/generated/targets.ts";
import { UsageError } from "../core/generated/util.ts";
import { formatTailRecords } from "./events.ts";
import {
  parseSessionEntries,
  parseSessionSnapshot,
  parseTailRecords,
} from "./input.ts";
import { formatSessionEntries } from "./messages.ts";
import { FILTER_MODES, formatSessionSnapshot } from "./tree.ts";
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
    toolResults: flags.toolResults ?? "summary",
    maxToolArgChars: flags.maxToolArgChars ?? 120,
    maxErrorLines: flags.maxErrorLines ?? 10,
  };
}

const filePositional = {
  kind: "tuple",
  parameters: [
    { ...stringArg("Input file or - for stdin", "file"), optional: true },
  ],
} as const;

async function formatMessages(
  this: CommandContext,
  flags: FormatFlags,
  file?: string,
): Promise<void> {
  const input = await readInputFile(this, file);
  this.process.stdout.write(
    formatSessionEntries(parseSessionEntries(input), formatOptions(flags)),
  );
}

async function formatEvents(
  this: CommandContext,
  flags: FormatFlags,
  file?: string,
): Promise<void> {
  const input = await readInputFile(this, file);
  this.process.stdout.write(
    formatTailRecords(parseTailRecords(input), formatOptions(flags)),
  );
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
    formatSessionSnapshot(parseSessionSnapshot(input), {
      filter: flags.filter ?? "conversation",
      width: flags.width ?? 120,
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
            brief: "format get-messages or session-file JSONL as plain text",
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
        tree: commandNoTarget<TreeFlags, [string | undefined]>({
          common: true,
          docs: {
            brief:
              "format get-entries output or session-file JSONL as an indented tree",
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
