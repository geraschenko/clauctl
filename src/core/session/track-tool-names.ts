/** tool_use id → tool name, folded over a session's entries so tool_result
 *  entries can name their tool after filtering hides the call. Each owner
 *  (session model, entry sink, `format tree`) keeps its map incrementally as
 *  entries are ingested. */

import { isRecord } from "../generated/util.ts";
import type { SessionEntry } from "./file.ts";

export function trackToolNames(
  entry: SessionEntry,
  toolNames: Map<string, string>,
): void {
  const content = isRecord(entry.message) ? entry.message.content : undefined;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      toolNames.set(block.id, block.name);
    }
  }
}
