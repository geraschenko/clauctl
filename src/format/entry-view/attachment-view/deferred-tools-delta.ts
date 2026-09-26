// `deferred_tools_delta`: `{addedNames[], removedNames[], …}`.

import type { AttachmentView } from "./attachment-view.ts";
import { stringList } from "../payload.ts";

interface DeferredToolsDeltaPayload {
  addedNames?: unknown;
  removedNames?: unknown;
}

export const deferredToolsDeltaView: AttachmentView<DeferredToolsDeltaPayload> =
  {
    summary(payload) {
      return `+${stringList(payload, "addedNames").length} -${stringList(payload, "removedNames").length}`;
    },
  };
