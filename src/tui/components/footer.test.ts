import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import {
  INITIAL_AGENT_STATE,
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
} as AgentState["lastUsage"];

test("cwd line: ~-abbreviated cwd with the provider's branch", () => {
  const lines = footerLines({
    ...INITIAL_AGENT_STATE,
    cwd: `${process.env.HOME}/repo`,
  });
  assert.equal(plain(lines[0]!), "~/repo (main)");
});

test("status line: colored mode left, context • model • effort right-aligned", () => {
  const line = footerLines(
    {
      ...INITIAL_AGENT_STATE,
      permissionMode: "default",
      model: "claude-opus-4-8",
      lastUsage: usage,
      effortLevel: "high",
    },
    80,
  )[1]!;
  const text = plain(line);
  assert.equal(text.length, 80);
  assert.ok(text.startsWith("⏸ manual mode on"));
  // 86k of the 200k window is 43%.
  assert.ok(text.endsWith("86k (43%) • claude-opus-4-8 • high"));
  assert.ok(line.includes("\u001b[38;5;246m⏸ manual mode on"));
});

test("per-mode indicators use claude's captured labels and colors", () => {
  const modeLine = (mode: AgentState["permissionMode"]): string =>
    footerLines({ ...INITIAL_AGENT_STATE, permissionMode: mode })[1]!;
  assert.ok(
    modeLine("acceptEdits").includes("\u001b[38;5;147m⏵⏵ accept edits on"),
  );
  assert.ok(modeLine("plan").includes("\u001b[38;5;73m⏸ plan mode on"));
  assert.ok(modeLine("auto").includes("\u001b[38;5;220m⏵⏵ auto mode on"));
  assert.ok(modeLine("dontAsk").includes("\u001b[38;5;211m⏵⏵ don't ask on"));
});

test("unresolved segments: usage/effort omitted, unset mode/model called out", () => {
  const line = footerLines(INITIAL_AGENT_STATE)[1]!;
  const text = plain(line);
  assert.ok(text.startsWith("? unset mode"));
  assert.ok(line.includes("[38;5;220m? unset mode"));
  assert.ok(text.endsWith("  unset model"));
  assert.ok(!text.includes("•"));
});

test("1M-suffixed models use the 1M context window", () => {
  const text = plain(
    footerLines({
      ...INITIAL_AGENT_STATE,
      model: "claude-sonnet-5[1m]",
      lastUsage: usage,
    })[1]!,
  );
  assert.ok(text.includes("86k (9%) • claude-sonnet-5[1m]"));
});

test("no provider: cwd line renders without a branch", () => {
  const footer = new FooterComponent(undefined);
  footer.setState({ ...INITIAL_AGENT_STATE, cwd: "/srv/work" });
  assert.equal(plain(footer.render(80)[0]!), "/srv/work");
});

test("formatTokens compacts counts like pi", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_234), "1.2k");
  assert.equal(formatTokens(86_000), "86k");
  assert.equal(formatTokens(1_200_000), "1.2M");
});
