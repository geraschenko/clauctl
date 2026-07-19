/**
 * Direct render of a session file: the daemon's seeding pipeline
 * (readSessionEntries → buildTree + effectiveTreeNodeChain → pathToLeaf, cf.
 * request-handlers.ts get-tree) fed through the exact TranscriptRenderer the
 * attach TUI uses, without tmux or a live agent. Output is the transcript
 * container only — no footer, editor, status or pending area.
 * `pathUpToBoundary` does not apply: there is no live stream, so the whole
 * path renders.
 */

import { Container } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { buildTree } from "../../src/core/build-tree.ts";
import { effectiveTreeNodeChain } from "../../src/core/effective-chain.ts";
import { readSessionEntries } from "../../src/core/session-file.ts";
import { pathToLeaf } from "../../src/core/tree.ts";
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
  const tree = buildTree(entries, onInvalid);
  const leaf = effectiveTreeNodeChain(entries, onInvalid).at(-1) ?? null;
  const container = new Container();
  const renderer = new TranscriptRenderer(container);
  for (const node of pathToLeaf(tree, leaf)) {
    renderer.appendPathNode(node);
  }
  return container.render(width);
}
