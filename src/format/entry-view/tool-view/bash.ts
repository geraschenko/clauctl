// Bash rendering: the model's `description` as the header, the command
// beneath it (a decided divergence from claude, which shows the raw
// command wrapped to two lines — docs/specs/tui-rendering-parity.md);
// results use the generic collapse rule, except that the CLI's
// empty-output sentinel displays as "(No output)" (claude 2.1.250, tools
// capture). Not in READ_ONLY_TOOLS, so Bash never folds — claude folds
// read-only-looking commands, we deliberately don't (spec-approved
// divergence).

import type { BashInput } from "./generated.ts";
import { stringArg } from "./args.ts";
import { defaultToolView } from "./default-tool-view.ts";
import type { ToolView } from "./tool-view.ts";

/** The exact text the CLI's Bash tool stores as the tool_result of a
 *  command with no output. */
const EMPTY_OUTPUT_SENTINEL = "(Bash completed with no output)";

export const bashView: ToolView<BashInput> = {
  header(args) {
    return {
      description: stringArg(args, "description"),
      arg: stringArg(args, "command"),
    };
  },
  resultSummary(args, result, context) {
    if (!result.isError && result.content.trim() === EMPTY_OUTPUT_SENTINEL) {
      return "(No output)";
    }
    return defaultToolView.resultSummary(args, result, context);
  },
  foldLabel(count) {
    return `ran ${count} command${count === 1 ? "" : "s"}`;
  },
};
