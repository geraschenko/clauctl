// `hook_additional_context`: `{content[], hookName, toolUseID, hookEvent}`,
// the context a PostToolUse/PostToolUseFailure hook handed the agent.

import {
  type AttachmentView,
  defaultAttachmentView,
} from "./attachment-view.ts";
import { hookContextDisplayText } from "../../../core/protocol/index.ts";
import { hookAdditionalContext } from "../../../core/session/file.ts";
import { oneLinePrefix } from "../../../core/generated/text.ts";

/** Allow feedback as the user typed it; another hook's context under its
 *  hook name. */
export const hookAdditionalContextView: AttachmentView<unknown> = {
  summary(payload, maxChars) {
    const hookContext = hookAdditionalContext(payload);
    return hookContext === undefined
      ? defaultAttachmentView.summary(payload, maxChars)
      : oneLinePrefix(
          hookContextDisplayText(hookContext.hookName, hookContext.context),
          maxChars,
        );
  },
};
