/**
 * Ours, pi-inspired (pi's footer renders session token/cost/context state
 * that lives in-process; ours reflects what an sdk.sock subscriber can know):
 * assistant activity, queue depth, mode, model, and session, on one dim line.
 * Rendered straight from the folded AgentState — display conventions (the
 * "default" fallback for an unobserved model/mode) live here, not in the
 * event dispatch.
 */

import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  INITIAL_AGENT_STATE,
  type AgentState,
} from "../../core/agent-state.ts";
import { theme } from "../theme.ts";

export class FooterComponent implements Component {
  private state: AgentState = INITIAL_AGENT_STATE;

  setState(state: AgentState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const parts: string[] = [this.state.activity];
    if (this.state.queuedMessages.length > 0) {
      parts.push(`queued: ${this.state.queuedMessages.length}`);
    }
    let left = parts.join(" • ");

    // Unknown model/mode (no init yet, or a pre-extension daemon) display as
    // "default" — the same convention the shift+tab cycle and set-model with
    // no model use; the first init corrects both.
    const rightParts: string[] = [
      this.state.permissionMode ?? "default",
      this.state.model ?? "default",
    ];
    if (this.state.sessionId !== undefined) {
      rightParts.push(this.state.sessionId.slice(0, 8));
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
