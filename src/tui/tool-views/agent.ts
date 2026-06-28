// claude 2.1.211's Agent (subagent) rendering: the description as the
// header arg and "Done (2 tool uses · 16.8k tokens · 14s)" from the
// structured result's totals. The minute-range duration format is
// unobserved in captures; "Nm Ss" is our reading of it.

import type { AgentOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { AgentInput } from "./generated.ts";
import { stringArg } from "./args.ts";
import type { ToolView } from "./tool-view.ts";

interface AgentTotals {
  toolUses: number;
  tokens: number;
  durationMs: number;
}

/** Totals from the SDK's AgentOutput (its "completed" variant). The cast is
 *  Partial and the fields read are runtime-checked — the wire payload is
 *  untrusted. */
function agentTotals(structured: unknown): AgentTotals | undefined {
  const output = structured as
    Partial<Extract<AgentOutput, { status: "completed" }>> | null | undefined;
  const totalToolUseCount = output?.totalToolUseCount;
  const totalTokens = output?.totalTokens;
  const totalDurationMs = output?.totalDurationMs;
  if (
    typeof totalToolUseCount !== "number" ||
    typeof totalTokens !== "number" ||
    typeof totalDurationMs !== "number"
  ) {
    return undefined;
  }
  return {
    toolUses: totalToolUseCount,
    tokens: totalTokens,
    durationMs: totalDurationMs,
  };
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const agentView: ToolView<AgentInput> = {
  readOnly: false,
  headerArg(args, _cwd) {
    return stringArg(args, "description");
  },
  resultSummary(_args, result) {
    if (result.isError) {
      return undefined;
    }
    const totals = agentTotals(result.toolUseResult);
    if (totals === undefined) {
      return undefined;
    }
    return (
      `Done (${totals.toolUses} tool use${totals.toolUses === 1 ? "" : "s"}` +
      ` · ${formatTokenCount(totals.tokens)} tokens` +
      ` · ${formatDuration(totals.durationMs)})`
    );
  },
  foldLabel(count) {
    return `ran ${count} agent${count === 1 ? "" : "s"}`;
  },
};
