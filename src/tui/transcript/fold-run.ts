import {
  type Component,
  Container,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { READ_ONLY_TOOLS, toolViewFor } from "../../format/entry-view/index.ts";
import { ANSI_STYLE } from "../../format/style.ts";
import { displayThinkingSeconds, hasThinking } from "./thinking.ts";
import type { TranscriptItem } from "./transcript-item.ts";

export function isFoldable(item: TranscriptItem): boolean {
  switch (item.kind) {
    case "plain":
    case "userTurn":
      return false;
    case "tool":
      return (
        READ_ONLY_TOOLS.has(item.name) &&
        item.result !== undefined &&
        !item.result.isError &&
        item.hasHookContext === undefined
      );
    case "assistant": {
      if (item.rendered === undefined) {
        return false; // streaming
      }
      const visibleText = item.rendered.content.some(
        (block) => block.type === "text" && block.text.trim() !== "",
      );
      const visibleStop =
        item.rendered.stopReason === "length" ||
        item.rendered.stopReason === "error" ||
        item.rendered.stopReason === "aborted";
      return !visibleText && !visibleStop;
    }
  }
}

/**
 * One fold run as a single line — "Thought for 4s, read 2 files, searched
 * for 1 pattern (ctrl+o to expand)" — grey with bold numbers, capitalized
 * when there is no thinking clause; undefined when the run has nothing to
 * say (only empty assistant messages). A fold run is a maximal consecutive
 * sequence of finalized thinking-only assistant messages and
 * READ_ONLY_TOOLS calls with non-error results; text blocks, other tools,
 * errors, and visible user turns end runs.
 */
export function foldRunComponent(run: TranscriptItem[]): Component | undefined {
  let thinkingSeconds = 0;
  let sawThinking = false;
  let sawDuration = false;
  const toolCounts = new Map<string, number>();
  for (const item of run) {
    if (item.kind === "assistant" && item.rendered !== undefined) {
      if (hasThinking(item.rendered)) {
        sawThinking = true;
        if (item.thinkingSeconds !== undefined) {
          sawDuration = true;
          thinkingSeconds += item.thinkingSeconds;
        }
      }
    } else if (item.kind === "tool") {
      toolCounts.set(item.name, (toolCounts.get(item.name) ?? 0) + 1);
    }
  }
  const parts: string[] = [];
  if (sawThinking) {
    parts.push(
      sawDuration
        ? `Thought for ${ANSI_STYLE.bold(`${displayThinkingSeconds(thinkingSeconds)}s`)}`
        : "Thought",
    );
  }
  for (const [name, count] of toolCounts) {
    // Foldable tools without a bespoke view (claude's fold phrasing for
    // them is unattested in the parity captures) get a generic clause.
    parts.push(
      toolViewFor(name).foldLabel?.(count, ANSI_STYLE) ??
        `used ${name} ${count} time${count === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) {
    return undefined;
  }
  let line = parts.join(", ");
  if (!sawThinking) {
    line = line.charAt(0).toUpperCase() + line.slice(1);
  }
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(
    new Text(` ${ANSI_STYLE.grey(`${line} (ctrl+o to expand)`)}`, 1, 0),
  );
  return container;
}
