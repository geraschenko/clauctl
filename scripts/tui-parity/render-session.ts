/**
 * Direct render of a session file: the attach TUI's replay pipeline
 * (readSessionEntries → buildTree + toDisplayTree → nearestVisibleNode →
 * pathToLeaf, cf. interactive-mode.ts replay) fed through the exact
 * TranscriptRenderer the attach TUI uses, without tmux or a live agent.
 * The leaf is the context tree's, matching what get-entries reports for a
 * freshly started daemon. Output is the
 * transcript container only — no footer, editor, status or pending area.
 */

import { Container } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { buildTree } from "../../src/core/tree/build-tree.ts";
import { toContextTree } from "../../src/core/tree/context-tree.ts";
import { toDisplayTree } from "../../src/core/tree/display-tree.ts";
import { pathToLeaf } from "../../src/core/tree/nodes.ts";
import {
  entriesByUuid,
  readSessionEntries,
} from "../../src/core/session/file.ts";
import { TranscriptRenderer } from "../../src/tui/transcript.ts";

export function renderSessionFile(
  sessionFilePath: string,
  width: number,
): string[] {
  initTheme("dark");
  const entries = readSessionEntries(sessionFilePath);
  const onInvalid = (message: string): void => {
    console.error(`warning: ${sessionFilePath}: ${message}`);
  };
  const byUuid = entriesByUuid(entries);
  const fullTree = buildTree(entries, onInvalid);
  const contextTree = toContextTree(fullTree, byUuid);
  const displayTree = toDisplayTree(fullTree, contextTree, byUuid);
  const leaf = contextTree.leaf;
  const leafNode =
    leaf === null ? null : (displayTree.nearestVisibleNode(leaf) ?? null);
  const container = new Container();
  const renderer = new TranscriptRenderer(container);
  for (const ref of pathToLeaf(displayTree.parentMap, byUuid, leafNode)) {
    renderer.appendEntry(byUuid.get(ref.uuid)!);
  }
  return container.render(width);
}
