// claude 2.1.211's Edit rendering: header "Update(path)", collapsed summary
// "Added N lines, removed M lines" (singular/plural, zero parts omitted)
// counted from the structured result's structuredPatch, and the rendered
// diff as the expanded form (the one expandedBody implementation).

import {
  generateDiffString,
  renderDiff,
} from "@earendil-works/pi-coding-agent";
import type { FileEditOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { claudeStyle } from "../claude-style.ts";
import type { EditInput } from "./generated.ts";
import { abbreviatePath, stringArg } from "./args.ts";
import type { ToolView } from "./tool-view.ts";

/** +/- line counts from the SDK's FileEditOutput structuredPatch (unified
 *  hunks: {lines: [" ctx", "-old", "+new"]}); undefined on any unexpected
 *  shape — the cast is Partial and the fields read are runtime-checked
 *  because the wire payload is untrusted. */
function structuredPatchCounts(
  structured: unknown,
): { added: number; removed: number } | undefined {
  const patch = (structured as Partial<FileEditOutput> | null | undefined)
    ?.structuredPatch;
  if (!Array.isArray(patch)) {
    return undefined;
  }
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    const lines = hunk?.lines;
    if (!Array.isArray(lines)) {
      return undefined;
    }
    for (const line of lines) {
      if (typeof line !== "string") {
        return undefined;
      }
      if (line.startsWith("+")) {
        added++;
      } else if (line.startsWith("-")) {
        removed++;
      }
    }
  }
  return { added, removed };
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
    const counts = structuredPatchCounts(result.toolUseResult);
    if (counts === undefined || (counts.added === 0 && counts.removed === 0)) {
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
  foldLabel(count) {
    return `edited ${claudeStyle.bold(String(count))} file${count === 1 ? "" : "s"}`;
  },
  expandedBody(args, _result) {
    const oldString = stringArg(args, "old_string");
    const newString = stringArg(args, "new_string");
    if (oldString === undefined || newString === undefined) {
      return undefined;
    }
    return renderDiff(generateDiffString(oldString, newString).diff);
  },
};
