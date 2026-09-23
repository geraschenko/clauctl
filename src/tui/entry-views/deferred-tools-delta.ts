// `deferred_tools_delta`: `{addedNames[], addedLines[], removedNames[]}` —
// the model sees `addedLines`.

import type { AttachmentView } from "./attachment-view.ts";
import { stringList } from "./payload.ts";

interface DeferredToolsDeltaPayload {
  addedNames?: unknown;
  addedLines?: unknown;
  removedNames?: unknown;
}

export const deferredToolsDeltaView: AttachmentView<DeferredToolsDeltaPayload> =
  {
    summary(payload) {
      return `+${stringList(payload, "addedNames").length} -${stringList(payload, "removedNames").length}`;
    },
    size(payload) {
      let size = 0;
      for (const line of stringList(payload, "addedLines")) {
        size += line.length;
      }
      return size;
    },
  };
