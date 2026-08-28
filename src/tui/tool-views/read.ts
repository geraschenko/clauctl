// claude 2.1.211's Read rendering: "Read N lines" from the structured
// result's file.numLines; Read is in READ_ONLY_TOOLS, so Reads fold into
// "Thought for Ns, read 2 files" lines.

import type { FileReadOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { claudeStyle } from "../claude-style.ts";
import type { ReadInput } from "./generated.ts";
import { abbreviatePath, stringArg } from "./args.ts";
import type { ToolView } from "./tool-view.ts";

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
  headerArg(args, cwd) {
    const path = stringArg(args, "file_path");
    return path === undefined ? undefined : abbreviatePath(path, cwd);
  },
  headerLink(args) {
    return stringArg(args, "file_path");
  },
  resultSummary(_args, result) {
    if (result.isError) {
      return undefined;
    }
    const count = readLineCount(result.toolUseResult);
    if (count === undefined) {
      return undefined;
    }
    return `Read ${claudeStyle.bold(String(count))} line${count === 1 ? "" : "s"}`;
  },
  foldLabel(count) {
    return `read ${claudeStyle.bold(String(count))} file${count === 1 ? "" : "s"}`;
  },
};
