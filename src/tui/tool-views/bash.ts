// claude 2.1.211's Bash rendering: the command as the header arg (the
// component wraps it to at most two lines); results use the generic
// first-3-visual-lines summary. Never readOnly — claude folds
// read-only-looking commands, we deliberately don't (spec-approved
// divergence).

import type { BashInput } from "./generated.ts";
import { stringArg } from "./args.ts";
import type { ToolView } from "./tool-view.ts";

export const bashView: ToolView<BashInput> = {
  readOnly: false,
  headerArg(args, _cwd) {
    return stringArg(args, "command");
  },
  resultSummary() {
    return undefined;
  },
  foldLabel(count) {
    return `ran ${count} command${count === 1 ? "" : "s"}`;
  },
};
