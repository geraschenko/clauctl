// Permission-prompt derisk probe: capture exactly what the SDK hands a
// `canUseTool` callback (suggestions, flags, bridge text fields) for the
// asks the TUI dialog must render, plus what auto mode escalates. Every ask
// is DENIED so no tool actually runs. Output: out/<scenario>.json.
//
// Scratch config + telemetry policy come from tests/sdk/harness.ts
// (docs/derisk/AGENTS.md).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  tool,
} from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { assertVersions, baseEnv, makeConfigDir } from "../../../tests/sdk/harness.ts";

const versions = assertVersions();
const EXP_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(EXP_DIR, "out");
const HAIKU = "claude-haiku-4-5-20251001";
const SCENARIO_TIMEOUT_MS = 120_000;

const OUTSIDE_DIR = "/tmp/clauctl-permprobe-outside";
const VICTIM_DIR = "/tmp/clauctl-permprobe-victim";
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE_DIR, "secret.txt"), "outside secret\n");
fs.mkdirSync(VICTIM_DIR, { recursive: true });

const mcpServer = createSdkMcpServer({
  name: "probe",
  tools: [
    tool("greet", "Greets a person by name", { name: z.string() }, async ({ name }) => ({
      content: [{ type: "text", text: `hello ${name}` }],
    })),
  ],
});

const SCENARIOS = [
  { name: "bash", prompt: "Use the Bash tool to run `ls -la` and report the output." },
  { name: "bash-safety-default", prompt: `Use the Bash tool to run \`rm -rf ${VICTIM_DIR}\`.` },
  { name: "bash-safety-auto", permissionMode: "auto", prompt: `Use the Bash tool to run \`rm -rf ${VICTIM_DIR}\`.` },
  { name: "bash-plain-auto", permissionMode: "auto", prompt: "Use the Bash tool to run `ls -la` and report the output." },
  { name: "edit", setup: (cwd) => fs.writeFileSync(path.join(cwd, "a.txt"), "hello world\n"), prompt: (cwd) => `Use the Edit tool to replace 'hello' with 'goodbye' in ${cwd}/a.txt.` },
  { name: "write", prompt: (cwd) => `Use the Write tool to create ${cwd}/b.txt containing the single line 'hi'.` },
  { name: "read-outside", prompt: `Use the Read tool to read ${OUTSIDE_DIR}/secret.txt.` },
  { name: "webfetch", prompt: "Use the WebFetch tool to fetch https://example.com and tell me its title." },
  { name: "mcp", mcp: true, prompt: "Call the mcp__probe__greet tool with name 'Anton' and report the result." },
  { name: "plan", permissionMode: "plan", prompt: "Make a one-line plan to create a file c.txt, then call ExitPlanMode to get my approval." },
  { name: "subagent", prompt: `Use the Agent tool to launch a subagent whose only job is to run \`rm -rf ${VICTIM_DIR}\` with the Bash tool and report back.` },
  { name: "askuser", prompt: "Use the AskUserQuestion tool to ask me whether I prefer cats or dogs." },
];

async function runScenario(scenario) {
  const configDir = makeConfigDir(`permprobe-${scenario.name}`);
  const cwd = fs.mkdtempSync("/tmp/clauctl-permprobe-cwd-");
  scenario.setup?.(cwd);
  const record = { scenario: scenario.name, versions, cwd, asks: [], denials: [], messages: [] };
  const q = query({
    prompt: typeof scenario.prompt === "function" ? scenario.prompt(cwd) : scenario.prompt,
    options: {
      env: baseEnv(configDir),
      cwd,
      model: HAIKU,
      maxTurns: 3,
      ...(scenario.permissionMode && { permissionMode: scenario.permissionMode }),
      ...(scenario.mcp && { mcpServers: { probe: mcpServer } }),
      canUseTool: async (toolName, input, options) => {
        const { signal, ...rest } = options;
        record.asks.push({ toolName, input, options: rest, signalAborted: signal.aborted });
        return { behavior: "deny", message: "probe: denied by harness" };
      },
    },
  });
  const timer = setTimeout(() => q.close(), SCENARIO_TIMEOUT_MS);
  try {
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "permission_denied") record.denials.push(message);
      if (message.type === "result") record.result = { subtype: message.subtype, permission_denials: message.permission_denials };
      record.messages.push({ type: message.type, subtype: message.subtype });
    }
  } catch (error) {
    record.error = String(error);
  } finally {
    clearTimeout(timer);
    q.close();
  }
  fs.writeFileSync(path.join(OUT_DIR, `${scenario.name}.json`), JSON.stringify(record, null, 2));
  console.log(`${scenario.name}: asks=${record.asks.length} denials=${record.denials.length} result=${record.result?.subtype ?? record.error}`);
}

const only = process.argv.slice(2);
const selected = only.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
for (const scenario of selected) await runScenario(scenario);
