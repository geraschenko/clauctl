// SDK expectation: the `suggestions` a `canUseTool` ask carries per tool —
// what the permission dialog's row 2 ("Yes, and don't ask again …") is
// derived from (docs/specs/permission-prompt.md, "Row 2 label"). Each case
// makes haiku raise exactly one ask, records the ask's options and denies
// it; nothing is ever approved. The shapes asserted here were first
// observed with claude 2.1.280 (scripts/tui-parity/out/*.dialog.ask.json).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type CanUseTool,
  type Options,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { assertVersions, baseEnv, makeConfigDir, REPO_DIR } from "./harness.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const ASK_RULE_COMMAND = "echo sdk-ask-rule";
const MCP_GREET_SERVER = join(
  REPO_DIR,
  "scripts/tui-parity/mcp-greet-server.ts",
);

interface ObservedAsk {
  toolName: string;
  options: Parameters<CanUseTool>[2];
}

/** Run `prompt` in a scratch cwd and return the first ask's options. */
async function observeAsk(
  caseName: string,
  prompt: string,
  extraOptions: Partial<Options> = {},
  settings?: Record<string, unknown>,
): Promise<ObservedAsk> {
  assertVersions();
  const configDir = makeConfigDir(
    `permission-suggestions-${caseName}`,
    settings,
  );
  const cwd = mkdtempSync(join(tmpdir(), "clauctl-sdktest-"));
  let observed: ObservedAsk | undefined;
  const q = query({
    prompt,
    options: {
      env: baseEnv(configDir),
      cwd,
      model: HAIKU,
      // WebFetch, MCP tools and ExitPlanMode are deferred: a ToolSearch turn
      // (plan mode: plus the plan-file Write) precedes the ask.
      maxTurns: 4,
      canUseTool: (toolName, _input, options) => {
        observed ??= { toolName, options };
        return Promise.resolve({
          behavior: "deny",
          message: "denied by the sdk test",
        });
      },
      ...extraOptions,
    },
  });
  try {
    for await (const msg of q) {
      if (observed !== undefined) break;
      if (msg.type === "result") break;
    }
  } finally {
    q.close();
    rmSync(cwd, { recursive: true, force: true });
  }
  if (observed === undefined) {
    throw new Error(`${caseName}: the turn ended without a permission ask`);
  }
  return observed;
}

function outsideDir(name: string): string {
  const dir = `/tmp/clauctl-sdktest-${name}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("Bash outside cwd: full-command rule, directory, and acceptEdits mode", async () => {
  const victim = outsideDir("victim");
  const { toolName, options } = await observeAsk(
    "bash-outside",
    `Use the Bash tool to run \`rm -rf ${victim}\`.`,
  );
  assert.equal(toolName, "Bash");
  assert.deepEqual(options.suggestions, [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: `rm -rf ${victim}` }],
      behavior: "allow",
      destination: "localSettings",
    },
    { type: "addDirectories", directories: [victim], destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ]);
});

test("Bash without a path: one full-command rule in localSettings", async () => {
  const { toolName, options } = await observeAsk(
    "bash-plain",
    "Use the Bash tool to run `curl -sI https://example.com` and report the status line.",
  );
  assert.equal(toolName, "Bash");
  assert.deepEqual(options.suggestions, [
    {
      type: "addRules",
      rules: [
        { toolName: "Bash", ruleContent: "curl -sI https://example.com" },
      ],
      behavior: "allow",
      destination: "localSettings",
    },
  ]);
  assert.equal(options.decisionReason, "This command requires approval");
});

test("permissions.ask rule: suggestions absent (the broker normalizes to [])", async () => {
  const { toolName, options } = await observeAsk(
    "ask-rule",
    `Use the Bash tool to run \`${ASK_RULE_COMMAND}\` and report the output.`,
    {},
    { permissions: { ask: [`Bash(${ASK_RULE_COMMAND})`] } },
  );
  assert.equal(toolName, "Bash");
  assert.equal(options.suggestions, undefined);
});

test("Read outside cwd: a session directory rule `//dir/**`", async () => {
  const outside = outsideDir("outside");
  const { toolName, options } = await observeAsk(
    "read-outside",
    `Use the Read tool to read ${outside}/secret.txt.`,
  );
  assert.equal(toolName, "Read");
  assert.deepEqual(options.suggestions, [
    {
      type: "addRules",
      rules: [{ toolName: "Read", ruleContent: `/${outside}/**` }],
      behavior: "allow",
      destination: "session",
    },
  ]);
  assert.equal(
    options.decisionReason,
    "Path is outside allowed working directories",
  );
});

test("WebFetch: a domain rule", async () => {
  const { toolName, options } = await observeAsk(
    "webfetch",
    "Use the WebFetch tool to fetch https://example.com and tell me its title.",
  );
  assert.equal(toolName, "WebFetch");
  assert.deepEqual(options.suggestions, [
    {
      type: "addRules",
      rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }],
      behavior: "allow",
      destination: "localSettings",
    },
  ]);
});

test("MCP tool: a tool-name-only rule and the server in mcpServer", async () => {
  const { toolName, options } = await observeAsk(
    "mcp",
    "Call the mcp__probe__greet tool with name 'Anton' and report the result.",
    {
      mcpServers: {
        probe: { command: process.execPath, args: [MCP_GREET_SERVER] },
      },
    },
  );
  assert.equal(toolName, "mcp__probe__greet");
  assert.deepEqual(options.suggestions, [
    {
      type: "addRules",
      rules: [{ toolName: "mcp__probe__greet" }],
      behavior: "allow",
      destination: "localSettings",
    },
  ]);
  assert.equal(options.mcpServer?.name, "probe");
});

test("ExitPlanMode: suggestions absent", async () => {
  const { toolName, options } = await observeAsk(
    "plan",
    "Make a one-line plan to create a file c.txt, then call ExitPlanMode to get my approval.",
    { permissionMode: "plan" },
  );
  assert.equal(toolName, "ExitPlanMode");
  assert.equal(options.suggestions, undefined);
});
