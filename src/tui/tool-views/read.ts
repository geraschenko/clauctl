// claude 2.1.211's Read rendering: "Read N lines" from the structured
// result's file.numLines; the only readOnly view, so Reads fold into
// "Thought for Ns, read 2 files" lines.

import { claudeStyle } from "../claude-style.ts";
import type { ReadInput } from "./generated.ts";
import { abbreviatePath, stringArg } from "./args.ts";
import type { ToolView } from "./tool-view.ts";

function readLineCount(structured: unknown): number | undefined {
  if (typeof structured !== "object" || structured === null) {
    return undefined;
  }
  const file = (structured as { file?: unknown }).file;
  if (typeof file !== "object" || file === null) {
    return undefined;
  }
  const numLines = (file as { numLines?: unknown }).numLines;
  return typeof numLines === "number" ? numLines : undefined;
}

export const readView: ToolView<ReadInput> = {
  readOnly: true,
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
    const count = readLineCount(result.structured);
    if (count === undefined) {
      return undefined;
    }
    return `Read ${claudeStyle.bold(String(count))} line${count === 1 ? "" : "s"}`;
  },
  foldLabel(count) {
    return `read ${claudeStyle.bold(String(count))} file${count === 1 ? "" : "s"}`;
  },
};
