/**
 * The committed corpus definition for the TUI parity harness
 * (docs/specs/tui-parity.md). Sessions are generated from these scenarios by
 * generate.ts; the session files themselves are never committed.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";

export interface Scenario {
  /** Slug; output filenames and the per-scenario workdir derive from it. */
  name: string;
  /** Which rendering features the scenario exercises. */
  description: string;
  /** Sent sequentially via SDK query(), each awaited to completion. */
  prompts: string[];
  /** SDK overrides (model, maxThinkingTokens, …). */
  options?: Partial<Options>;
}

export const scenarios: Scenario[] = [
  {
    name: "markdown",
    description: "plain assistant text: headings, lists, code blocks, tables",
    prompts: [
      "Reply with a short markdown sample: an h2 heading, a 3-item bullet " +
        "list, a 2-row table, a fenced ts code block, and a sentence with " +
        "**bold**, *italic*, and `inline code`. No tools.",
    ],
    options: { model: "haiku" },
  },
  {
    name: "thinking",
    description: "thinking blocks interleaved with text",
    prompts: [
      "Think step by step about why the sky is blue, then answer in two sentences.",
    ],
    options: { maxThinkingTokens: 4000 },
  },
  {
    name: "tools",
    description: "tool calls with short and long outputs, multi-turn",
    prompts: [
      "Create a file named notes.txt containing the line 'hello parity', " +
        "then read it back. Reply with one sentence.",
      "List the files in this directory recursively, then show the first 200 " +
        "lines of `find /usr/share/doc -maxdepth 1 | sort` output. Reply with " +
        "one sentence.",
    ],
    // dontAsk denies any tool not pre-allowed, so tool-using scenarios must
    // allowlist what their prompts need.
    options: { model: "haiku", allowedTools: ["Write", "Read", "Bash"] },
  },
  {
    name: "edit",
    description:
      "Edit diffs: mid-file single hunk, multi-hunk replace_all, long diff",
    // Prompt 1 pins the file's shape (params named a/b, NO error handling)
    // so the later edits have real work to do — a model that anticipates
    // them turns the edit prompts into no-ops. (generate.ts wipes the
    // workdir per generation for the same reason: a stale calc.py has the
    // edits already applied.)
    prompts: [
      "Create a file named calc.py: functions add, sub, mul, div, each " +
        "taking parameters named a and b with a one-line docstring, and a " +
        "main() that prints each function's result for one input pair. " +
        "No error handling anywhere. Reply with one sentence.",
      // Mid-file single hunk with file-anchored line numbers.
      "In calc.py, change div to raise ValueError on division by zero. " +
        "Use a single Edit call. Reply with one sentence.",
      "In calc.py, rename the first parameter of the four arithmetic " +
        "functions from a to `left` — one Edit call with replace_all if " +
        "possible. Reply with one sentence.",
      // Long diff (no truncation expected on replay).
      "Rewrite calc.py's main() to demo every function with three input " +
        "sets labeled 'Example 1'..'Example 3', printing labeled results — " +
        "make it at least 30 lines. Use a single Edit call replacing the " +
        "whole function. Reply with one sentence.",
      // Occurrences far enough apart that structuredPatch splits into
      // multiple hunks (unchanged gaps of ~8 lines > 2×3 context lines).
      "In calc.py, rename the word `Example` to `Case` everywhere it " +
        "appears (comments and strings), using one Edit call with " +
        "replace_all: true. Reply with one sentence.",
    ],
    // dontAsk denies any tool not pre-allowed (see the tools scenario).
    options: { model: "haiku", allowedTools: ["Write", "Read", "Edit"] },
  },
  {
    name: "subagent",
    description: "Task tool with nested subagent output",
    prompts: [
      "Use the Task tool with subagent_type general-purpose to count the " +
        "files in this directory. Reply with one sentence about the result.",
    ],
    options: { allowedTools: ["Task", "Bash", "Glob", "Read"] },
  },
  {
    name: "slash-command",
    description: "slash command output and compaction boundary",
    prompts: [
      "Reply with exactly one short sentence.",
      "/compact",
      "Reply with exactly one more short sentence.",
    ],
    options: { model: "haiku" },
  },
];
