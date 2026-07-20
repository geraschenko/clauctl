// claude 2.1.211's Edit rendering: header "Update(path)", collapsed summary
// "Added N lines, removed M lines" (singular/plural, zero parts omitted),
// and the line-numbered diff as resultBody — both driven by the structured
// result's structuredPatch (formats captured in scripts/tui-parity/out/
// edit.claude.txt and session-44a0b993.claude.txt).

import type { FileEditOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { claudeStyle } from "../claude-style.ts";
import type { EditInput } from "./generated.ts";
import { abbreviatePath, stringArg } from "./args.ts";
import type { ToolView } from "./tool-view.ts";

interface PatchHunk {
  oldStart: number;
  newStart: number;
  /** Unified-diff lines: " ctx", "-old", "+new". */
  lines: string[];
}

/** The SDK's FileEditOutput structuredPatch, validated field by field;
 *  undefined on any unexpected shape — the cast is Partial and the wire
 *  payload is untrusted. */
function structuredPatchHunks(structured: unknown): PatchHunk[] | undefined {
  const patch = (structured as Partial<FileEditOutput> | null | undefined)
    ?.structuredPatch;
  if (!Array.isArray(patch)) {
    return undefined;
  }
  const hunks: PatchHunk[] = [];
  for (const hunk of patch) {
    const oldStart: unknown = hunk?.oldStart;
    const newStart: unknown = hunk?.newStart;
    const lines: unknown = hunk?.lines;
    if (
      typeof oldStart !== "number" ||
      typeof newStart !== "number" ||
      !Array.isArray(lines) ||
      lines.some((line) => typeof line !== "string")
    ) {
      return undefined;
    }
    hunks.push({ oldStart, newStart, lines: lines as string[] });
  }
  return hunks;
}

function structuredPatchCounts(hunks: PatchHunk[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        added++;
      } else if (line.startsWith("-")) {
        removed++;
      }
    }
  }
  return { added, removed };
}

interface DiffRow {
  /** File-anchored: old-file number for removed lines, new-file for
   *  added and context lines. */
  number: number;
  gutter: "-" | "+" | " ";
  text: string;
}

/** One hunk's display rows: within a change run, `-` lines grouped
 *  before `+` lines (buffered adds flush at the next context line). */
function hunkRows(hunk: PatchHunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let adds: DiffRow[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.lines) {
    const text = line.slice(1);
    if (line.startsWith("-")) {
      rows.push({ number: oldLine++, gutter: "-", text });
    } else if (line.startsWith("+")) {
      adds.push({ number: newLine++, gutter: "+", text });
    } else {
      rows.push(...adds);
      adds = [];
      rows.push({ number: newLine++, gutter: " ", text });
      oldLine++;
    }
  }
  rows.push(...adds);
  return rows;
}

/**
 * claude 2.1.211's diff layout: `<number> <gutter><content>` per row,
 * numbers right-aligned across the whole block to the widest number plus
 * one leading space; hunks separated by a grey `...` line; no length
 * truncation (claude's live-view truncation is out of scope). Colors
 * approximate claude's: dim numbers on context rows, whole change rows
 * red/green (claude's syntax highlighting and background bands are
 * ANSI-pass territory).
 */
function formatStructuredPatch(hunks: PatchHunk[]): string {
  const rowsPerHunk = hunks.map(hunkRows);
  const numberWidth =
    1 + String(Math.max(...rowsPerHunk.flat().map((row) => row.number))).length;
  const formatRow = (row: DiffRow): string => {
    const numberField = String(row.number).padStart(numberWidth);
    if (row.gutter === " ") {
      return claudeStyle.dim(numberField) + `  ${row.text}`.trimEnd();
    }
    const line = `${numberField} ${row.gutter}${row.text}`.trimEnd();
    return row.gutter === "-"
      ? claudeStyle.error(line)
      : claudeStyle.success(line);
  };
  return rowsPerHunk
    .map((rows) => rows.map(formatRow).join("\n"))
    .join(`\n${claudeStyle.grey("...")}\n`);
}

function countClause(verb: string, count: number): string {
  return `${verb} ${claudeStyle.bold(String(count))} line${count === 1 ? "" : "s"}`;
}

export const editView: ToolView<EditInput> = {
  displayName: "Update",
  readOnly: false,
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
    const hunks = structuredPatchHunks(result.toolUseResult);
    if (hunks === undefined) {
      return undefined;
    }
    const counts = structuredPatchCounts(hunks);
    if (counts.added === 0 && counts.removed === 0) {
      return undefined;
    }
    const parts: string[] = [];
    if (counts.added > 0) {
      parts.push(countClause("Added", counts.added));
    }
    if (counts.removed > 0) {
      parts.push(
        countClause(parts.length > 0 ? "removed" : "Removed", counts.removed),
      );
    }
    return parts.join(", ");
  },
  resultBody(_args, result) {
    if (result.isError) {
      return undefined;
    }
    const hunks = structuredPatchHunks(result.toolUseResult);
    if (hunks === undefined) {
      return undefined;
    }
    const counts = structuredPatchCounts(hunks);
    if (counts.added === 0 && counts.removed === 0) {
      return undefined;
    }
    return formatStructuredPatch(hunks);
  },
  foldLabel(count) {
    return `edited ${claudeStyle.bold(String(count))} file${count === 1 ? "" : "s"}`;
  },
};
