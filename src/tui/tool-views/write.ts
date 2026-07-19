// claude 2.1.211's Write rendering: success is a bare `⎿` (nothing after),
// errors a fixed message (the raw error text stays in the expanded form).

import type { WriteInput } from "./generated.ts";
import { abbreviatePath, stringArg } from "./args.ts";
import type { ToolView } from "./tool-view.ts";

export const writeView: ToolView<WriteInput> = {
  readOnly: false,
  headerArg(args, cwd) {
    const path = stringArg(args, "file_path");
    return path === undefined ? undefined : abbreviatePath(path, cwd);
  },
  headerLink(args) {
    return stringArg(args, "file_path");
  },
  resultSummary(_args, result) {
    return result.isError ? "Error writing file" : "";
  },
  foldLabel(count) {
    return `wrote ${count} file${count === 1 ? "" : "s"}`;
  },
};
