// `token_usage`: `{used, total, remaining}` — the wire text without its
// `<system-reminder>` wrapper.

import type { AttachmentView } from "./attachment-view.ts";
import { numberField } from "../payload.ts";

interface TokenUsagePayload {
  used?: number;
  total?: number;
  remaining?: number;
}

export const tokenUsageView: AttachmentView<TokenUsagePayload> = {
  summary(payload) {
    const used = numberField(payload, "used");
    const total = numberField(payload, "total");
    const remaining = numberField(payload, "remaining");
    return used === undefined || total === undefined || remaining === undefined
      ? ""
      : `${used}/${total}; ${remaining} remaining`;
  },
};
