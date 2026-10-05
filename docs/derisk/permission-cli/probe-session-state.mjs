// permission-cli derisk probe: does `system/session_state_changed` compute
// "input needed" for us? Logs every session_state transition interleaved with
// asks, results, task lifecycle, and tool results, per scenario:
//   main     — a main-agent Bash ask, held 3 s, then denied
//   bg-ask   — a background subagent's Bash ask, held until the top-level
//              result + 5 s, then denied
//   bg-noask — a background subagent that asks nothing (does `idle` wait for
//              it?)
//   parallel — a main-agent ask alongside a parallel Read: does the Read's
//              tool_result arrive while the ask pends?
// Usage: node probe-session-state.mjs <scenario>. Output: out/<scenario>.json.
// Scratch config + telemetry policy from tests/sdk/harness.ts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { assertVersions, baseEnv, makeConfigDir } from "../../../tests/sdk/harness.ts";

const versions = assertVersions();
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
fs.mkdirSync(OUT_DIR, { recursive: true });
const HAIKU = "claude-haiku-4-5-20251001";
const VICTIM_DIR = "/tmp/clauctl-permcli-victim";
fs.mkdirSync(VICTIM_DIR, { recursive: true });
const cwd = fs.mkdtempSync("/tmp/clauctl-permcli-cwd-");
fs.writeFileSync(path.join(cwd, "notes.txt"), "hello from notes\n");

const scenario = process.argv[2];
const PROMPTS = {
  main: `Run \`rm -rf ${VICTIM_DIR}\` with the Bash tool, then reply "done".`,
  "bg-ask": `Use the Agent tool with run_in_background set to true to launch a subagent whose only job is to run \`rm -rf ${VICTIM_DIR}\` with the Bash tool. Do not wait for it; reply "launched" immediately and end your turn.`,
  "bg-noask": `Use the Agent tool with run_in_background set to true to launch a subagent whose only job is to write a 300-word story about a lighthouse, using no tools. Do not wait for it; reply "launched" immediately and end your turn.`,
  parallel: `In a single message, call these two tools in parallel: Bash with \`rm -rf ${VICTIM_DIR}\`, and Read on ${path.join(cwd, "notes.txt")}. Then reply "done".`,
  "parallel-read-first": `In a single message, call these two tools in parallel, in this order: first Read on ${path.join(cwd, "notes.txt")}, then Bash with \`rm -rf ${VICTIM_DIR}\`. Then reply "done".`,
  "fg-ask": `Use the Agent tool (foreground, do NOT set run_in_background) to launch a subagent whose only job is to run \`rm -rf ${VICTIM_DIR}\` with the Bash tool. Wait for it, then reply "done".`,
};
if (!(scenario in PROMPTS)) throw new Error(`scenario: ${Object.keys(PROMPTS).join("|")}`);

const record = { scenario, versions, cwd, timeline: [] };
const t0 = Date.now();
const note = (what, extra = {}) => {
  record.timeline.push({ t: Date.now() - t0, what, ...extra });
  console.log(`${Date.now() - t0}ms ${what} ${JSON.stringify(extra)}`);
};

let firstResult;
const resultSeen = new Promise((r) => (firstResult = r));
let closeInput;
const inputClosed = new Promise((r) => (closeInput = r));
let lastActivity = Date.now();
async function* prompt() {
  yield { type: "user", message: { role: "user", content: PROMPTS[scenario] }, parent_tool_use_id: null, session_id: "" };
  await inputClosed;
}
// Close input after 25 s of silence, or 150 s overall.
const quietCheck = setInterval(() => {
  if (Date.now() - lastActivity > 25_000) closeInput();
}, 1_000);
const hardStop = setTimeout(() => closeInput(), 150_000);

const q = query({
  prompt: prompt(),
  options: {
    env: baseEnv(makeConfigDir(`permcli-${scenario}`)),
    cwd,
    model: HAIKU,
    maxTurns: 4,
    canUseTool: async (toolName, input, options) => {
      note("ask", { toolName, toolUseID: options.toolUseID, agentID: options.agentID });
      if (toolName === "Read") return { behavior: "allow", updatedInput: input };
      await (scenario === "bg-ask"
        ? resultSeen.then(() => new Promise((r) => setTimeout(r, 5_000)))
        : new Promise((r) => setTimeout(r, 3_000)));
      note("deny", { toolUseID: options.toolUseID });
      lastActivity = Date.now();
      return { behavior: "deny", message: "probe: denied" };
    },
  },
});

try {
  for await (const m of q) {
    lastActivity = Date.now();
    const extra = { type: m.type, subtype: m.subtype };
    if (m.type === "system" && m.subtype === "session_state_changed") extra.state = m.state;
    if (m.type === "result") firstResult();
    if (m.type === "system" && ["task_started", "task_updated", "task_notification"].includes(m.subtype)) {
      extra.task_id = m.task_id;
      extra.status = m.patch?.status ?? m.status;
      if (m.subtype === "task_started") extra.payload = m;
    }
    if (m.type === "assistant" || m.type === "user") {
      extra.parent_tool_use_id = m.parent_tool_use_id;
      const content = Array.isArray(m.message.content) ? m.message.content : [];
      extra.blocks = content.map((b) =>
        b.type === "tool_use" ? `tool_use:${b.name}:${b.id}` : b.type === "tool_result" ? `tool_result:${b.tool_use_id}` : b.type,
      );
    }
    if (m.type === "stream_event" || (m.type === "system" && m.subtype === "thinking_tokens")) continue;
    note("message", extra);
  }
} catch (error) {
  note("error", { error: String(error) });
} finally {
  clearInterval(quietCheck);
  clearTimeout(hardStop);
  q.close();
}
fs.writeFileSync(path.join(OUT_DIR, `${scenario}.json`), JSON.stringify(record, null, 2));
