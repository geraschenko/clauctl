// claude 2.1.250's WebSearch rendering: header `Web Search("query")` (the
// query quoted) and collapsed summary "Did 1 search in 4s" from the
// structured result's searchCount and durationSeconds (format captured in
// scripts/tui-parity/out/web-search.claude.txt; the one attested duration,
// 3.96s → "4s", pins rounding over floor). Deliberately not in
// READ_ONLY_TOOLS — see that set's doc comment.

import type { WebSearchOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { WebSearchInput } from "./generated.ts";
import { stringArg } from "./args.ts";
import { defaultToolView } from "./default-tool-view.ts";
import type { ToolView } from "./tool-view.ts";

export const webSearchView: ToolView<WebSearchInput> = {
  displayName: "Web Search",
  header(args) {
    const query = stringArg(args, "query");
    return query === undefined ? {} : { arg: `"${query}"` };
  },
  resultSummary(args, result, context) {
    const structured = result.isError
      ? undefined
      : (result.toolUseResult as Partial<WebSearchOutput> | null | undefined);
    const duration = structured?.durationSeconds;
    const count = structured?.searchCount;
    if (typeof duration !== "number" || typeof count !== "number") {
      return defaultToolView.resultSummary(args, result, context);
    }
    return `Did ${count} search${count === 1 ? "" : "es"} in ${Math.round(duration)}s`;
  },
};
