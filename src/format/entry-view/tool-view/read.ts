// claude 2.1.211's Read rendering: "Read N lines" from the structured
// result's file.numLines; Read is in READ_ONLY_TOOLS, so Reads fold into
// "Thought for Ns, read 2 files" lines. The header path carries the
// requested line range (a decided divergence from claude, which shows the
// bare path — docs/specs/tui-rendering-parity.md).

import type { FileReadOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { ReadInput } from "./generated.ts";
import { abbreviatePath, stringArg } from "./args.ts";
import { defaultToolView } from "./default-tool-view.ts";
import type { ToolView } from "./tool-view.ts";

function numberArg(args: unknown, key: string): number | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

/** `:<offset>-<offset+limit-1>` (1-based, inclusive end), `:<offset>-`
 *  without a limit, `:1-<limit>` without an offset, "" with neither. */
function lineRangeSuffix(args: unknown): string {
  const offset = numberArg(args, "offset");
  const limit = numberArg(args, "limit");
  if (offset === undefined && limit === undefined) {
    return "";
  }
  const start = offset ?? 1;
  return limit === undefined ? `:${start}-` : `:${start}-${start + limit - 1}`;
}

/** numLines from the SDK's FileReadOutput (its "text" variant). The cast is
 *  Partial and the fields read are runtime-checked — the wire payload is
 *  untrusted. */
function readLineCount(structured: unknown): number | undefined {
  const output = structured as
    Partial<Extract<FileReadOutput, { type: "text" }>> | null | undefined;
  if (output?.type !== "text") {
    return undefined;
  }
  const numLines = output.file?.numLines;
  return typeof numLines === "number" ? numLines : undefined;
}

export const readView: ToolView<ReadInput> = {
  header(args, context) {
    const path = stringArg(args, "file_path");
    return path === undefined
      ? {}
      : { arg: `${abbreviatePath(path, context.cwd)}${lineRangeSuffix(args)}` };
  },
  headerLink(args) {
    return stringArg(args, "file_path");
  },
  resultSummary(args, result, context) {
    const count = result.isError
      ? undefined
      : readLineCount(result.toolUseResult);
    if (count === undefined) {
      return defaultToolView.resultSummary(args, result, context);
    }
    return `Read ${context.style.bold(String(count))} line${count === 1 ? "" : "s"}`;
  },
  foldLabel(count, style) {
    return `read ${style.bold(String(count))} file${count === 1 ? "" : "s"}`;
  },
};
