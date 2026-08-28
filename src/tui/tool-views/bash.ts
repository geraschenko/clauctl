// claude's Bash rendering: the command as the header arg (the component
// wraps it to at most two lines); results use the generic
// first-3-visual-lines summary, except that the CLI's empty-output
// sentinel displays as "(No output)" (claude 2.1.250, tools capture). Not
// in READ_ONLY_TOOLS, so Bash never folds — claude folds read-only-looking
// commands, we deliberately don't (spec-approved divergence).

import type { BashInput } from "./generated.ts";
import { stringArg } from "./args.ts";
import type { ToolView } from "./tool-view.ts";

/** The exact text the CLI's Bash tool stores as the tool_result of a
 *  command with no output. */
const EMPTY_OUTPUT_SENTINEL = "(Bash completed with no output)";

export const bashView: ToolView<BashInput> = {
  headerArg(args, _cwd) {
    return stringArg(args, "command");
  },
  resultSummary(_args, result) {
    if (!result.isError && result.content.trim() === EMPTY_OUTPUT_SENTINEL) {
      return "(No output)";
    }
    return undefined;
  },
  foldLabel(count) {
    return `ran ${count} command${count === 1 ? "" : "s"}`;
  },
};
