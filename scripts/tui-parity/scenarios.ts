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
    options: { model: "haiku" },
  },
  {
    name: "subagent",
    description: "Task tool with nested subagent output",
    prompts: [
      "Use the Task tool with subagent_type general-purpose to count the " +
        "files in this directory. Reply with one sentence about the result.",
    ],
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
