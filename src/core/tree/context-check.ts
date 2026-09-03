/**
 * Verification of success criterion 1 in docs/specs/context-tree.md:
 * contextAt presents the same context as loadedContext at every settled
 * prefix of a session file. Shared by the unit test and scripts/check-context-at.ts.
 */

import type { UUID } from "node:crypto";
import { entriesByUuid, hasUuid, type SessionEntry } from "../session/file.ts";
import { buildTree } from "./build-tree.ts";
import { toContextTree } from "./context-tree.ts";
import { compactBoundaryOf, loadedContext } from "./loader.ts";
import { ToolGroup } from "./tool-group.ts";
import { formatTreeNodeRef, parseTreeNodeRef } from "./nodes.ts";

/** Lengths of the settled prefixes of `entries`: nothing in the prefix
 *  awaits a later entry — no tool call awaits its result (a group's calls
 *  stop waiting when the group ends; the loader judges them dead from
 *  then on) and no boundary awaits its anchor. Elsewhere the prefix is a
 *  mid-write state whose loaded context legitimately differs from the
 *  whole file's. */
export function* settledPrefixLengths(
  entries: SessionEntry[],
): Generator<number> {
  const pendingAnchors = new Set<UUID>();
  let group: ToolGroup | undefined;
  for (const [index, entry] of entries.entries()) {
    if (hasUuid(entry)) {
      pendingAnchors.delete(entry.uuid);
      if (group?.push(entry) === undefined) {
        group = entry.type === "assistant" ? new ToolGroup(entry) : undefined;
      }
      if (entry.subtype === "compact_boundary") {
        // An anchor other than the boundary itself is the up_to summary,
        // written right after it. Do not replace this with a seen-set: the
        // CLI re-persists boundary + summary pairs, and at the second copy
        // of the boundary its anchor has already been seen, which would
        // leave the prefix ending at that boundary wrongly settled.
        const anchorUuid =
          compactBoundaryOf(entry).preservedMessages.anchorUuid;
        if (anchorUuid !== entry.uuid) {
          pendingAnchors.add(anchorUuid);
        }
      }
    }
    if (!(group?.awaitingResults() ?? false) && pendingAnchors.size === 0) {
      yield index + 1;
    }
  }
}

export interface ContextMismatch {
  prefixLength: number;
  expected: string[];
  actual: string[];
}

/** `context` as the request builder presents it, up to tool_result block
 *  order: same-id assistant entries reassemble into one API message and
 *  their results merge into one user message, so within a group only the
 *  call order is observable. The loader orders a group's results by the
 *  tip (docs/specs/context-tree.md, Edge cases); the tree does not. */
function presentedOrder(
  context: string[],
  byUuid: ReadonlyMap<UUID, SessionEntry>,
): string[] {
  const presented: string[] = [];
  let group: ToolGroup | undefined;
  let groupResults: string[] = [];
  const flushResults = (): void => {
    presented.push(...groupResults.sort());
    groupResults = [];
  };
  for (const id of context) {
    const entry = byUuid.get(parseTreeNodeRef(id).uuid)!;
    if (!hasUuid(entry)) {
      throw new Error(`presentedOrder: ${id} names no uuid entry`);
    }
    if (group?.push(entry) !== undefined) {
      (entry.type === "assistant" ? presented : groupResults).push(id);
      continue;
    }
    flushResults();
    group = entry.type === "assistant" ? new ToolGroup(entry) : undefined;
    presented.push(id);
  }
  flushResults();
  return presented;
}

/** Every settled prefix where contextAt and loadedContext present
 *  different contexts, with the number of prefixes compared. A prefix
 *  whose loaded context is empty (it ends at a wipe boundary, or holds no
 *  user/assistant entry yet) has no tip to query and is not counted. */
export function contextAtMismatches(entries: SessionEntry[]): {
  checked: number;
  mismatches: ContextMismatch[];
} {
  const byUuid = entriesByUuid(entries);
  const contextTree = toContextTree(
    buildTree(entries, () => {}),
    byUuid,
  );
  let checked = 0;
  const mismatches: ContextMismatch[] = [];
  for (const prefixLength of settledPrefixLengths(entries)) {
    const expected = loadedContext(
      entries.slice(0, prefixLength),
      () => {},
    ).map(formatTreeNodeRef);
    const tip = expected.at(-1);
    if (tip === undefined) {
      continue;
    }
    checked++;
    const actual = contextTree
      .contextAt(parseTreeNodeRef(tip))
      .map(formatTreeNodeRef);
    const expectedPresented = presentedOrder(expected, byUuid);
    const actualPresented = presentedOrder(actual, byUuid);
    if (
      actualPresented.length !== expectedPresented.length ||
      actualPresented.some((id, index) => id !== expectedPresented[index])
    ) {
      mismatches.push({ prefixLength, expected, actual });
    }
  }
  return { checked, mismatches };
}
