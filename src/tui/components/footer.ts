/**
 * Ours, pi-inspired (pi's footer renders session token/cost/context state
 * that lives in-process; ours reflects what an sdk.sock subscriber can know):
 * assistant activity, queue depth, and the model, on one dim line.
 */

import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AssistantState } from "../../core/assistant-state.ts";
import { theme } from "../theme.ts";

export class FooterComponent implements Component {
  private assistantState: AssistantState = { activity: "idle", queued: [] };
  private model?: string;
  private sessionId?: string;

  setAssistantState(state: AssistantState): void {
    this.assistantState = state;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const parts: string[] = [this.assistantState.activity];
    if (this.assistantState.queued.length > 0) {
      parts.push(`queued: ${this.assistantState.queued.length}`);
    }
    let left = parts.join(" • ");

    const rightParts: string[] = [];
    if (this.model !== undefined) {
      rightParts.push(this.model);
    }
    if (this.sessionId !== undefined) {
      rightParts.push(this.sessionId.slice(0, 8));
    }
    const right = rightParts.join(" • ");

    let leftWidth = visibleWidth(left);
    if (leftWidth > width) {
      left = truncateToWidth(left, width, "...");
      leftWidth = visibleWidth(left);
    }

    const minPadding = 2;
    const rightWidth = visibleWidth(right);
    let line: string;
    if (leftWidth + minPadding + rightWidth <= width) {
      line = left + " ".repeat(width - leftWidth - rightWidth) + right;
    } else {
      line = left;
    }
    return [theme.fg("dim", line)];
  }
}
