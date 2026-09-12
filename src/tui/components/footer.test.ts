import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { NonNullableUsage } from "@anthropic-ai/claude-agent-sdk";
import type { UUID } from "node:crypto";
import {
  freshSessionState,
  initialAgentState,
  type AgentState,
} from "../../core/agent-state.ts";
import { FooterComponent, formatTokens } from "./footer.ts";

const provider: ReadonlyFooterDataProvider = {
  getGitBranch: () => "main",
  getExtensionStatuses: () => new Map(),
  getAvailableProviderCount: () => 0,
  onBranchChange: () => () => {},
};

function plain(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function footerLines(state: AgentState, width = 80): string[] {
  const footer = new FooterComponent(provider);
  footer.setState(state);
  return footer.render(width);
}

const usage = {
  input_tokens: 1_000,
  output_tokens: 1,
  cache_read_input_tokens: 84_000,
  cache_creation_input_tokens: 1_000,
} as NonNullableUsage;

/** `base` with a query file whose last assistant reported `usage`. */
function withUsage(base: AgentState): AgentState {
  const sessionId = "aaaaaaaa-0000-4000-8000-000000000001" as UUID;
  return {
    ...base,
    querySessionId: sessionId,
    sessions: { [sessionId]: { ...freshSessionState(), lastUsage: usage } },
  };
}

test("cwd line: ~-abbreviated cwd with the provider's branch", () => {
  const lines = footerLines({
    ...initialAgentState(),
    cwd: `${process.env.HOME}/repo`,
  });
  assert.equal(plain(lines[0]!), "~/repo (main)");
});

test("status line: colored mode left, context • model • effort right-aligned", () => {
  const line = footerLines(
    withUsage({
      ...initialAgentState(),
      permissionMode: "default",
      model: "claude-opus-4-8",
      effortLevel: "high",
    }),
    80,
  )[1]!;
  const text = plain(line);
  assert.equal(text.length, 80);
  assert.ok(text.startsWith("⏸ manual"));
  // 86k of the 200k window is 43%.
  assert.ok(text.endsWith("86k (43%) • claude-opus-4-8 • high"));
  assert.ok(line.includes("\u001b[38;5;246m⏸ manual"));
});

test("per-mode indicators use claude's glyphs and colors with our labels", () => {
  const modeLine = (mode: AgentState["permissionMode"]): string =>
    footerLines({ ...initialAgentState(), permissionMode: mode })[1]!;
  assert.ok(
    modeLine("acceptEdits").includes("\u001b[38;5;147m⏵⏵ accept edits"),
  );
  assert.ok(modeLine("plan").includes("\u001b[38;5;73m⏸ plan"));
  assert.ok(modeLine("auto").includes("\u001b[38;5;220m⏵⏵ auto"));
  assert.ok(modeLine("dontAsk").includes("\u001b[38;5;211m⏵⏵ don't ask"));
});

test("unresolved segments: usage/effort omitted, unset mode/model called out", () => {
  const line = footerLines(initialAgentState())[1]!;
  const text = plain(line);
  assert.ok(text.startsWith("? unset mode"));
  assert.ok(line.includes("[38;5;220m? unset mode"));
  assert.ok(text.endsWith("  unset model"));
  assert.ok(!text.includes("•"));
});

test("1M-suffixed models use the 1M context window", () => {
  const text = plain(
    footerLines(
      withUsage({ ...initialAgentState(), model: "claude-sonnet-5[1m]" }),
    )[1]!,
  );
  assert.ok(text.includes("86k (9%) • claude-sonnet-5[1m]"));
});

test("no provider: cwd line renders without a branch", () => {
  const footer = new FooterComponent(undefined);
  footer.setState({ ...initialAgentState(), cwd: "/srv/work" });
  assert.equal(plain(footer.render(80)[0]!), "/srv/work");
});

test("formatTokens compacts counts like pi", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_234), "1.2k");
  assert.equal(formatTokens(86_000), "86k");
  assert.equal(formatTokens(1_200_000), "1.2M");
});
