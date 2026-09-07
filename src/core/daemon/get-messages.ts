/**
 * get-messages correction machinery: the override slot that keeps the
 * daemon's get-messages answer equal to the loader's view of the session
 * file when the SDK's getSessionMessages would disagree (spec criterion 3,
 * docs/specs/session-tree-and-set-context.md).
 *
 * Probe ids in comments (e.g. P9 a/b) cite the experiments in
 * docs/derisk/compact-boundary-injection/FINDINGS.md that established each
 * behavior.
 */

import type { UUID } from "node:crypto";
import { loadedContextUuids, type OnInvalid } from "../tree/loader.ts";
import {
  entryToSessionMessage,
  type SessionEntry,
  type SessionMessageOnWire,
} from "../session/file.ts";
import type { TreeNodeRef } from "../tree/nodes.ts";

// TDC: can we simplify this comment (and maybe the type)? What exactly is the function of installedAtLeaf? Doesn't it always have to match `chain.last()`? If so, we can drop that field. The text is confusing to me ... "so the override stays fresh", "slot is dropped"? I thing the comment and type have some vestigial complexity.
/**
 * One override slot for get-messages, installed by each successful
 * set-context (a durable boundary append): getSessionMessages picks its tip
 * as the latest user/assistant leaf in file order, so it reports the wrong
 * chain when the file ends in a boundary. Pinned to the leaf occurrence it was
 * installed at — the POST-change leaf, the same value the contextChanged
 * event carries, so the override stays fresh once the event folds. The next
 * transcript write closes the synthesis window (getSessionMessages agrees
 * with the loader again), so the slot is dropped lazily when `leaf` moves.
 * Every transcript write moves `leaf`: the CLI echoes each appended
 * user/assistant entry on the stream with its transcript uuid, including
 * host-pushed input — the same echo that clears deliveredMessages
 * (agent-state.ts fold).
 */
export interface GetMessagesOverride {
  chain: UUID[];
  installedAtLeaf: TreeNodeRef | undefined;
}

// TDC: from this point down, do we still need this stuff? The context tree should replace all this, and instead of calling the SDK's getSessionMessages (which we think does not accurately represent what the assistant will see on the next call), we should *always* answer `get-messages` using the context tree. This also means that we can add `get-messages --at`. I know we put this in the non-goals of the spec, but I think it's best we implement this immediately, because otherwise this leftover complexity using the old way will confuse future developers. Maybe this is worth starting a new spec for, as it would completely remove the GetMessagesOverride type (this whole file).
/**
 * The synthesis window: the file's last boundary has no post-boundary
 * user/assistant entries besides its own summary. Returns the chain to
 * synthesize while the window is open, undefined otherwise. Being purely
 * file-derived, this also reconstructs the window at daemon startup.
 */
function synthesizeWindowChain(
  entries: SessionEntry[],
  onInvalid: OnInvalid,
): UUID[] | undefined {
  const boundaryIndex = entries.findLastIndex(
    (entry) => entry.subtype === "compact_boundary",
  );
  if (boundaryIndex === -1) {
    return undefined;
  }
  // The boundary's summary is its isCompactSummary child (either anchor
  // shape); any OTHER post-boundary user/assistant turn closes the window.
  // Parentage alone cannot identify the summary: after an empty-uuids wipe
  // the first real prompt also parents onto the boundary (P10; see file
  // comment).
  const boundaryUuid = entries[boundaryIndex]!.uuid;
  const windowClosed = entries
    .slice(boundaryIndex + 1)
    .some(
      (entry) =>
        (entry.type === "user" || entry.type === "assistant") &&
        !(entry.isCompactSummary === true && entry.parentUuid === boundaryUuid),
    );
  return windowClosed ? undefined : loadedContextUuids(entries, onInvalid);
}

/** The get-messages response for a synthesize override: the chain's entries
 *  mapped to SessionMessage shape via entryToSessionMessage
 *  (session/file.ts). Takes pre-read entries — the handler's one
 *  flush-synced read serves the flush gate and the synthesis. */
export function synthesizeMessages(
  entries: SessionEntry[],
  chain: UUID[],
): SessionMessageOnWire[] {
  const byUuid = new Map<UUID, SessionEntry>();
  for (const entry of entries) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
    }
  }
  const messages: SessionMessageOnWire[] = [];
  for (const uuid of chain) {
    const entry = byUuid.get(uuid);
    const message =
      entry === undefined ? undefined : entryToSessionMessage(entry);
    if (message !== undefined) {
      messages.push(message);
    }
  }
  return messages;
}

/** The override a daemon (re)starting inside the synthesis window must
 *  install to keep synthesizing; undefined when the window is closed (or the
 *  session file does not exist yet). */
export function startupOverride(
  startupEntries: SessionEntry[] | undefined,
  installedAtLeaf: TreeNodeRef | undefined,
  onInvalid: OnInvalid,
): GetMessagesOverride | undefined {
  if (startupEntries === undefined) {
    return undefined;
  }
  const chain = synthesizeWindowChain(startupEntries, onInvalid);
  if (chain === undefined) {
    return undefined;
  }
  return { chain, installedAtLeaf };
}
