// `skill_listing`: `{content, skillCount, isInitial, names[]}`.

import { isRecord } from "../../../core/generated/util.ts";
import type { AttachmentView } from "./attachment-view.ts";
import { numberField } from "../payload.ts";

interface SkillListingPayload {
  skillCount?: number;
  names?: unknown;
}

export const skillListingView: AttachmentView<SkillListingPayload> = {
  summary(payload) {
    const names = isRecord(payload) ? payload.names : undefined;
    const count =
      numberField(payload, "skillCount") ??
      (Array.isArray(names) ? names.length : 0);
    return `${count} skill${count === 1 ? "" : "s"}`;
  },
};
