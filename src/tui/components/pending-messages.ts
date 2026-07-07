/**
 * Ours (no pi counterpart): the grey queued-message area rendered just above
 * the editor. Entries appear on `userMessageQueued` and are taken out on
 * `userMessageDequeued`, at which point interactive-mode re-adds them to the
 * transcript as ordinary user messages — the dequeue's stream position is the
 * correct transcript position (phase-2 queue model).
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme.ts";

interface PendingEntry {
  id: number;
  text: string;
}

export class PendingMessagesComponent extends Container {
  private entries: PendingEntry[] = [];

  add(id: number, text: string): void {
    this.entries.push({ id, text });
    this.rebuild();
  }

  /** Remove the given ids; returns their texts in the order requested. */
  take(ids: number[]): string[] {
    const taken: string[] = [];
    for (const id of ids) {
      const index = this.entries.findIndex((entry) => entry.id === id);
      if (index !== -1) {
        taken.push(this.entries[index].text);
        this.entries.splice(index, 1);
      }
    }
    this.rebuild();
    return taken;
  }

  private rebuild(): void {
    this.clear();
    if (this.entries.length === 0) {
      return;
    }
    this.addChild(new Spacer(1));
    for (const entry of this.entries) {
      this.addChild(
        new Text(theme.fg("pendingText", entry.text), 1, 0, (text: string) =>
          theme.bg("pendingBg", text),
        ),
      );
    }
  }
}
