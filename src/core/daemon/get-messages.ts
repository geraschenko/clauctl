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
} from "../session-file.ts";
import type { TreeNodeRef } from "../tree/nodes.ts";

/**
 * One override slot for get-messages, replaced by each successful
 * set-context:
 * - filterTail (no-write rewind): the session file still contains the
 *   superseded tail of the active chain; subtract those uuids from
 *   getSessionMessages output.
 * - synthesize (durable boundary append): getSessionMessages picks its tip as
 *   the latest user/assistant leaf in file order, so it reports the wrong
 *   chain for any boundary whose preserved-uuids tip predates another
 *   dangling leaf (spec criterion 3 mechanism note); serve the chain straight
 *   from the session file instead.
 * Both variants are pinned to the leaf occurrence they were installed at —
 * the POST-change leaf, the same value the contextChanged event carries, so
 * the override stays fresh once the event folds. The next transcript write
 * closes the synthesis window (getSessionMessages agrees with the loader
 * again) and makes the tail filter inert, so the slot is dropped lazily when
 * `leaf` moves. Every transcript write moves `leaf`:
 * the CLI echoes each appended user/assistant entry on the stream with its
 * transcript uuid, including host-pushed input — the same echo that clears
 * deliveredMessages (agent-state.ts fold).
 */
export type GetMessagesOverride = (
  | { kind: "filterTail"; droppedUuids: Set<string> }
  | { kind: "synthesize"; chain: UUID[] }
) & { installedAtLeaf: TreeNodeRef | undefined };

/**
 * The synthesis window: the file's last boundary has no post-boundary
 * user/assistant entries besides its own summary. Returns the chain to
 * synthesize while the window is open, undefined otherwise. Being purely
 * file-derived, this also reconstructs the window at daemon startup — unlike
 * a no-write rewind, which the file carries no record of (criterion 8).
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
 *  (session-file.ts). Takes pre-read entries — the handler's one
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
  return { kind: "synthesize", chain, installedAtLeaf };
}
