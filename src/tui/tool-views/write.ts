// claude 2.1.280's Write rendering: success is "Wrote N lines to <path>"
// (the path cwd-relative, unlike the ~-abbreviated header) with the written
// content as a line-numbered resultBody preview, truncated past the first
// 10 lines by a "… +N lines (ctrl+o to expand)" marker; errors a fixed
// message (the raw error text stays in the expanded form). Formats captured
// in scripts/tui-parity/out/{readonly-fold,write-preview}.claude.txt.
// Colors approximate claude's: bold count and dim line numbers per the
// Edit view's conventions.

import { normalize, relative, resolve } from "node:path";
import type { FileWriteOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { claudeStyle } from "../claude-style.ts";
import type { WriteInput } from "./generated.ts";
import { abbreviatePath, stringArg } from "./args.ts";
import type { ToolView } from "./tool-view.ts";

/** The SDK's FileWriteOutput filePath/content, validated; undefined on any
 *  unexpected shape — the cast is Partial and the wire payload is
 *  untrusted. */
function writtenFile(
  structured: unknown,
): { filePath: string; lines: string[] } | undefined {
  const output = structured as Partial<FileWriteOutput> | null | undefined;
  const filePath: unknown = output?.filePath;
  const content: unknown = output?.content;
  if (typeof filePath !== "string" || typeof content !== "string") {
    return undefined;
  }
  // claude counts newline-terminated lines: a trailing newline adds no
  // empty row ("…line 40\n" is "Wrote 40 lines", write-preview capture).
  return { filePath, lines: content.replace(/\n$/, "").split("\n") };
}

/** Content lines claude previews before the "… +N lines" marker
 *  (write-preview capture: 10 of 40 shown). */
const PREVIEW_LINES = 10;

export const writeView: ToolView<WriteInput> = {
  headerArg(args, cwd) {
    const path = stringArg(args, "file_path");
    return path === undefined ? undefined : abbreviatePath(path, cwd);
  },
  headerLink(args) {
    return stringArg(args, "file_path");
  },
  resultSummary(_args, result, cwd) {
    if (result.isError) {
      return "Error writing file";
    }
    const written = writtenFile(result.toolUseResult);
    if (written === undefined) {
      return "";
    }
    const count = written.lines.length;
    // The CLI records filePath as the call gave it (absolute, "fruit.txt",
    // "./lines.txt"); resolving against the cwd before relativizing
    // reproduces claude's display for all three (readonly-fold and
    // write-preview captures) — bare relative() would wrongly resolve a
    // relative one against process.cwd().
    const path =
      cwd === undefined
        ? normalize(written.filePath)
        : relative(cwd, resolve(cwd, written.filePath));
    return `Wrote ${claudeStyle.bold(String(count))} line${count === 1 ? "" : "s"} to ${path}`;
  },
  resultBody(_args, result) {
    if (result.isError) {
      return undefined;
    }
    const lines = writtenFile(result.toolUseResult)?.lines;
    if (lines === undefined) {
      return undefined;
    }
    // Number field sized by the full count, not the shown maximum (the two
    // coincide in the captures; full count matches claude's Edit sizing).
    const numberWidth = 1 + String(lines.length).length;
    const body = lines
      .slice(0, PREVIEW_LINES)
      .map((text, index) =>
        `${claudeStyle.dim(String(index + 1).padStart(numberWidth))} ${text}`.trimEnd(),
      );
    const hidden = lines.length - PREVIEW_LINES;
    if (hidden > 0) {
      body.push(claudeStyle.dim(`… +${hidden} lines (ctrl+o to expand)`));
    }
    return body.join("\n");
  },
  foldLabel(count) {
    return `wrote ${count} file${count === 1 ? "" : "s"}`;
  },
};
