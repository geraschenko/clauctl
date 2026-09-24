// `hook_success`: `{hookName, hookEvent, toolUseID, command, stdout,
// stderr, exitCode, durationMs, content}`; `stdout` may be absent while
// `content` carries the output.

import type { AttachmentView } from "./attachment-view.ts";
import { numberField, sourcePrefix, stringField } from "../payload.ts";
import { oneLinePrefix } from "../../../core/generated/text.ts";

interface HookSuccessPayload {
  hookEvent?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  content?: string;
}

export const hookSuccessView: AttachmentView<HookSuccessPayload> = {
  summary(payload, maxChars) {
    const head = `${stringField(payload, "hookEvent") ?? ""} exit ${numberField(payload, "exitCode") ?? "?"}`;
    const output =
      stringField(payload, "stdout") ?? stringField(payload, "content") ?? "";
    const firstLine = sourcePrefix(output, maxChars).split("\n", 1)[0]!.trim();
    return oneLinePrefix(
      firstLine === "" ? head : `${head}: ${firstLine}`,
      maxChars,
    );
  },
  size(payload) {
    return (
      (stringField(payload, "stdout")?.length ?? 0) +
      (stringField(payload, "stderr")?.length ?? 0)
    );
  },
};
