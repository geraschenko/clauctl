/**
 * Ours, claude-inspired (tui-rendering-parity spec, phase 6): a two-line footer
 * rendered straight from the folded AgentState plus the FooterDataProvider port
 * —
 *
 *   ~/repo (main)
 *   ⏸ manual                      86k (43%) • claude-opus-4-8 • high
 *
 * Line 1 is the ~-abbreviated cwd with the current git branch. Line 2 shows the
 * permission mode with claude 2.1.211's per-mode glyphs and colors (labels are
 * our own; see MODE_INDICATORS), and
 * right-aligns context usage • model • effort level. Display conventions (the
 * "? unset mode" / "unset model" fallbacks for a not-yet-observed mode/model)
 * live here, not in the event dispatch.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import {
  INITIAL_AGENT_STATE,
  type AgentState,
} from "../../core/agent-state.ts";
import { claudeStyle } from "../claude-style.ts";

/** Copied from pi's footer.ts (exported there but not through the package
 *  entrypoint): compact token counts, e.g. 1234 → "1.2k". */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** Copied from pi's footer.ts: ~-abbreviate cwd when it is inside home. */
export function formatCwdForFooter(
  cwd: string,
  home: string | undefined,
): string {
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Mode indicators with claude's glyphs and colors but our own shortened
 *  labels — a deliberate branding divergence (Agent SDK guidelines: no
 *  verbatim Claude Code visual elements). */
const MODE_INDICATORS: Record<
  PermissionMode,
  { label: string; color: (text: string) => string }
> = {
  default: { label: "⏸ manual", color: claudeStyle.manualMode },
  acceptEdits: { label: "⏵⏵ accept edits", color: claudeStyle.acceptEdits },
  plan: { label: "⏸ plan", color: claudeStyle.planMode },
  auto: { label: "⏵⏵ auto", color: claudeStyle.autoMode },
  dontAsk: { label: "⏵⏵ don't ask", color: claudeStyle.dontAsk },
  bypassPermissions: {
    label: "⏵⏵ bypass permissions",
    color: claudeStyle.bypassPermissions,
  },
};

/** The CLI's 1M-context beta models carry a "[1m]" model-id suffix; every
 *  other (or unknown) model assumes the standard 200k window, so a
 *  percentage always shows. */
function contextWindow(model: string | undefined): number {
  return model !== undefined && model.includes("[1m]") ? 1_000_000 : 200_000;
}

export class FooterComponent implements Component {
  private readonly dataProvider: ReadonlyFooterDataProvider | undefined;
  private state: AgentState = INITIAL_AGENT_STATE;

  constructor(dataProvider: ReadonlyFooterDataProvider | undefined) {
    this.dataProvider = dataProvider;
  }

  setState(state: AgentState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [this.cwdLine(width), this.statusLine(width)];
  }

  private cwdLine(width: number): string {
    let pwd =
      this.state.cwd === undefined
        ? ""
        : formatCwdForFooter(this.state.cwd, process.env.HOME);
    const branch = this.dataProvider?.getGitBranch();
    if (branch !== undefined && branch !== null) {
      pwd = `${pwd} (${branch})`;
    }
    return truncateToWidth(claudeStyle.grey(pwd), width, claudeStyle.grey("…"));
  }

  private statusLine(width: number): string {
    const mode =
      this.state.permissionMode === undefined
        ? { label: "? unset mode", color: claudeStyle.warning }
        : MODE_INDICATORS[this.state.permissionMode];
    let left = mode.color(mode.label);
    let leftWidth = visibleWidth(left);
    if (leftWidth > width) {
      left = truncateToWidth(left, width, "…");
      leftWidth = visibleWidth(left);
    }

    const rightParts: string[] = [];
    if (this.state.lastUsage !== undefined) {
      const tokens =
        this.state.lastUsage.input_tokens +
        this.state.lastUsage.cache_read_input_tokens +
        this.state.lastUsage.cache_creation_input_tokens;
      const percent = Math.round(
        (tokens / contextWindow(this.state.model)) * 100,
      );
      rightParts.push(`${formatTokens(tokens)} (${percent}%)`);
    }
    rightParts.push(this.state.model ?? "unset model");
    if (this.state.effortLevel !== undefined) {
      rightParts.push(this.state.effortLevel);
    }
    const right = claudeStyle.grey(rightParts.join(" • "));
    const rightWidth = visibleWidth(right);

    const minPadding = 2;
    if (leftWidth + minPadding + rightWidth <= width) {
      return left + " ".repeat(width - leftWidth - rightWidth) + right;
    }
    const availableForRight = width - leftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(right, availableForRight, "");
      const padding = width - leftWidth - visibleWidth(truncatedRight);
      return left + " ".repeat(Math.max(0, padding)) + truncatedRight;
    }
    return left;
  }
}
