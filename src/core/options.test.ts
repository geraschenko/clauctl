import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseClaudeFlags } from "./options.ts";
import { UsageError } from "./generated/util.ts";

test("no flags → empty options", () => {
  assert.deepEqual(parseClaudeFlags([]), { persistedOptions: {} });
});

test("first-class scalar flags", () => {
  const { persistedOptions } = parseClaudeFlags([
    "--model",
    "opus",
    "--fallback-model",
    "sonnet",
    "--permission-mode",
    "acceptEdits",
    "--agent",
    "reviewer",
    "--effort",
    "high",
    "--max-turns",
    "10",
    "--max-budget-usd",
    "2.5",
    "--task-budget",
    "100000",
  ]);
  assert.deepEqual(persistedOptions, {
    model: "opus",
    fallbackModel: "sonnet",
    permissionMode: "acceptEdits",
    agent: "reviewer",
    effort: "high",
    maxTurns: 10,
    maxBudgetUsd: 2.5,
    taskBudget: { total: 100000 },
  });
});

test("--flag=value syntax", () => {
  const { persistedOptions } = parseClaudeFlags(["--model=opus"]);
  assert.deepEqual(persistedOptions, { model: "opus" });
});

test("comma lists split; both tool-flag spellings accepted", () => {
  const { persistedOptions } = parseClaudeFlags([
    "--allowedTools",
    "Read,Bash",
    "--disallowed-tools",
    "WebSearch",
    "--tools",
    "",
  ]);
  assert.deepEqual(persistedOptions, {
    allowedTools: ["Read", "Bash"],
    disallowedTools: ["WebSearch"],
    tools: [],
  });
});

test("--add-dir is repeatable", () => {
  const { persistedOptions } = parseClaudeFlags([
    "--add-dir",
    "/a",
    "--add-dir",
    "/b",
  ]);
  assert.deepEqual(persistedOptions.additionalDirectories, ["/a", "/b"]);
});

test("thinking flags compose into one ThinkingConfig", () => {
  assert.deepEqual(
    parseClaudeFlags(["--thinking", "disabled"]).persistedOptions.thinking,
    { type: "disabled" },
  );
  assert.deepEqual(
    parseClaudeFlags(["--max-thinking-tokens", "5000"]).persistedOptions
      .thinking,
    { type: "enabled", budgetTokens: 5000 },
  );
  assert.deepEqual(
    parseClaudeFlags(["--thinking-display", "omitted"]).persistedOptions
      .thinking,
    { type: "adaptive", display: "omitted" },
  );
});

test("--system-prompt vs --append-system-prompt", () => {
  assert.equal(
    parseClaudeFlags(["--system-prompt", "be terse"]).persistedOptions
      .systemPrompt,
    "be terse",
  );
  assert.deepEqual(
    parseClaudeFlags(["--append-system-prompt", "and rhyme"]).persistedOptions
      .systemPrompt,
    { type: "preset", preset: "claude_code", append: "and rhyme" },
  );
});

test("skip-permissions spellings set allowDangerouslySkipPermissions", () => {
  for (const flag of [
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
  ]) {
    assert.equal(
      parseClaudeFlags([flag]).persistedOptions.allowDangerouslySkipPermissions,
      true,
    );
  }
});

test("--resume goes to the ParsedClaudeFlags, not persistedOptions", () => {
  const parsed = parseClaudeFlags(["--resume", "sess-123"]);
  assert.equal(parsed.resume, "sess-123");
  assert.deepEqual(parsed.persistedOptions, {});
});

test("unmodeled flags fall through to extraArgs", () => {
  const { persistedOptions } = parseClaudeFlags([
    "--ide",
    "--chrome-executable",
    "/usr/bin/chromium",
    "--future-flag=inline",
  ]);
  assert.deepEqual(persistedOptions.extraArgs, {
    ide: null,
    "chrome-executable": "/usr/bin/chromium",
    "future-flag": "inline",
  });
});

test("extraArgs: a following flag-like token is not consumed as a value", () => {
  const { persistedOptions } = parseClaudeFlags(["--ide", "--model", "opus"]);
  assert.deepEqual(persistedOptions.extraArgs, { ide: null });
  assert.equal(persistedOptions.model, "opus");
});

test("repeated unmodeled flag is an error, not a silent drop", () => {
  assert.throws(
    () => parseClaudeFlags(["--ide", "--ide"]),
    /given more than once/,
  );
});

test("clauctl-owned flags are rejected", () => {
  for (const flag of [
    "--output-format",
    "--verbose",
    "--continue",
    "--session-id",
    "-p",
  ]) {
    assert.throws(
      () => parseClaudeFlags([flag]),
      (error: unknown) =>
        error instanceof UsageError && /owned by clauctl/.test(error.message),
      `expected '${flag}' to be rejected`,
    );
  }
});

test("positional arguments are rejected", () => {
  assert.throws(
    () => parseClaudeFlags(["hello"]),
    /unexpected positional argument 'hello'/,
  );
});

test("missing value for a first-class flag is an error", () => {
  assert.throws(() => parseClaudeFlags(["--model"]), /--model expects a value/);
});

test("invalid enum and number values are errors", () => {
  assert.throws(() => parseClaudeFlags(["--permission-mode", "yolo"]));
  assert.throws(
    () => parseClaudeFlags(["--max-turns", "many"]),
    /non-negative number/,
  );
});

test("--mcp-config accepts inline JSON, wrapped or bare", () => {
  const server = { type: "stdio", command: "srv" };
  const wrapped = JSON.stringify({ mcpServers: { a: server } });
  const bare = JSON.stringify({ b: server });
  assert.deepEqual(
    parseClaudeFlags(["--mcp-config", wrapped]).persistedOptions.mcpServers,
    { a: server },
  );
  assert.deepEqual(
    parseClaudeFlags(["--mcp-config", bare]).persistedOptions.mcpServers,
    { b: server },
  );
  // Two configs merge.
  assert.deepEqual(
    parseClaudeFlags(["--mcp-config", wrapped, "--mcp-config", bare])
      .persistedOptions.mcpServers,
    { a: server, b: server },
  );
});

let mcpDir: string;

before(async () => {
  mcpDir = await mkdtemp(join(tmpdir(), "clauctl-options-test-"));
});

after(async () => {
  await rm(mcpDir, { recursive: true, force: true });
});

test("--mcp-config accepts a file path", async () => {
  const path = join(mcpDir, "mcp.json");
  await writeFile(
    path,
    JSON.stringify({ mcpServers: { srv: { type: "stdio", command: "x" } } }),
  );
  assert.deepEqual(
    parseClaudeFlags(["--mcp-config", path]).persistedOptions.mcpServers,
    { srv: { type: "stdio", command: "x" } },
  );
});

test("--mcp-config with invalid JSON is a UsageError", () => {
  assert.throws(
    () => parseClaudeFlags(["--mcp-config", "{nope"]),
    /--mcp-config is not valid JSON/,
  );
});
