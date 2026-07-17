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
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  effectiveChain,
  summaryOf,
  type OnInvalid,
} from "../effective-chain.ts";
import { readSessionEntries, type SessionEntry } from "../session-file.ts";

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
 * Both variants are pinned to the transcript leaf they were installed at:
 * the next transcript write closes the synthesis window (getSessionMessages
 * agrees with the loader again) and makes the tail filter inert, so the slot
 * is dropped lazily when `lastTranscriptUuid` moves. Every transcript write
 * moves `lastTranscriptUuid`: the CLI echoes each appended user/assistant
 * entry on the stream with its transcript uuid, including host-pushed input
 * — the same echo that clears deliveredMessages (agent-state.ts fold).
 */
export type GetMessagesOverride = (
  | { kind: "filterTail"; droppedUuids: Set<string> }
  | { kind: "synthesize"; chain: UUID[] }
) & { installedAtLeafUuid: string | undefined };

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
  const summaryUuid = summaryOf(entries, boundaryIndex)?.uuid;
  const windowClosed = entries
    .slice(boundaryIndex + 1)
    .some(
      (entry) =>
        (entry.type === "user" || entry.type === "assistant") &&
        entry.uuid !== summaryUuid,
    );
  return windowClosed ? undefined : effectiveChain(entries, onInvalid);
}

/** getSessionMessages' runtime objects also carry `timestamp`, absent from
 *  the SDK's declared SessionMessage type; synthesized output matches the
 *  wire shape. */
type SessionMessageOnWire = SessionMessage & { timestamp?: string };

/** The get-messages response for a synthesize override: the chain's entries
 *  mapped to SessionMessage shape, mirroring the SDK's own mapping and
 *  filters (user/assistant only, isMeta/isSidechain excluded,
 *  parent_tool_use_id always null in getSessionMessages output). */
export function synthesizeMessages(
  filePath: string,
  chain: UUID[],
): SessionMessageOnWire[] {
  const byUuid = new Map<UUID, SessionEntry>();
  for (const entry of readSessionEntries(filePath)) {
    if (entry.uuid !== undefined) {
      byUuid.set(entry.uuid, entry);
    }
  }
  const messages: SessionMessageOnWire[] = [];
  for (const uuid of chain) {
    const entry = byUuid.get(uuid);
    if (
      entry === undefined ||
      (entry.type !== "user" && entry.type !== "assistant") ||
      entry.isMeta === true ||
      entry.isSidechain === true
    ) {
      continue;
    }
    messages.push({
      type: entry.type,
      uuid,
      session_id: entry.sessionId as string,
      message: entry.message,
      parent_tool_use_id: null,
      // Synthesized messages are from the main transcript. SDK 0.3.211 made
      // this runtime field part of the declared SessionMessage contract.
      parent_agent_id: null,
      ...(typeof entry.timestamp === "string" && {
        timestamp: entry.timestamp,
      }),
    });
  }
  return messages;
}

/** The override a daemon (re)starting inside the synthesis window must
 *  install to keep synthesizing; undefined when the window is closed (or the
 *  session file does not exist yet). */
export function startupOverride(
  startupEntries: SessionEntry[] | undefined,
  installedAtLeafUuid: string | undefined,
  onInvalid: OnInvalid,
): GetMessagesOverride | undefined {
  if (startupEntries === undefined) {
    return undefined;
  }
  const chain = synthesizeWindowChain(startupEntries, onInvalid);
  if (chain === undefined) {
    return undefined;
  }
  return { kind: "synthesize", chain, installedAtLeafUuid };
}
