/**
 * Direct render of a session file: the attach TUI's replay pipeline
 * (readSessionEntries → buildTree + toDisplayTree → nearestVisibleRow →
 * pathToLeaf, cf. interactive-mode.ts replay) fed through the exact
 * TranscriptRenderer the attach TUI uses, without tmux or a live agent.
 * The leaf is the daemon-seeded one (seedFromEntries), matching what
 * get-entries would report for a freshly started daemon. Output is the
 * transcript container only — no footer, editor, status or pending area.
 * `pathUpToBoundary` does not apply: there is no live stream, so the whole
 * path renders.
 */

import { Container } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { buildTree } from "../../src/core/tree/build-tree.ts";
import { toDisplayTree } from "../../src/core/tree/display-tree.ts";
import { pathToLeaf } from "../../src/core/tree/nodes.ts";
import {
  entriesByUuid,
  readSessionEntries,
} from "../../src/core/session/file.ts";
import { seedFromEntries } from "../../src/core/session/seed.ts";
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
  const displayTree = toDisplayTree(fullTree, entries);
  const leaf = seedFromEntries(entries, onInvalid).leaf ?? null;
  const leafRow =
    leaf === null ? null : (displayTree.nearestVisibleRow(leaf) ?? null);
  const container = new Container();
  const renderer = new TranscriptRenderer(container);
  for (const ref of pathToLeaf(displayTree.parentMap, byUuid, leafRow)) {
    renderer.appendEntry(byUuid.get(ref.uuid)!);
  }
  return container.render(width);
}
