// Permission-prompt derisk probe (spec "Blocking verification item"): does a
// background subagent's ask arrive after the top-level `result`, and what
// does the CLI emit once such an ask is resolved? Streaming-input mode like
// the daemon (the Query stays open across turns). The ask is held until a
// `result` has been seen (or a deadline), then DENIED; every observation is
// timestamped in arrival order. With `--push`, a second prompt is pushed
// 1 s after the ask arrives and the ask is held until that prompt's result
// (or the deadline): does the CLI run a prompt while a subagent's ask is
// pending? Output: out/subagent-bg[-push].json.
//
// Scratch config + telemetry policy come from tests/sdk/harness.ts
// (docs/derisk/AGENTS.md).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { assertVersions, baseEnv, makeConfigDir } from "../../../tests/sdk/harness.ts";

const versions = assertVersions();
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const HAIKU = "claude-haiku-4-5-20251001";
const VICTIM_DIR = "/tmp/clauctl-permprobe-victim";
const HOLD_AFTER_RESULT_MS = 5_000;
const HOLD_DEADLINE_MS = 90_000;
const QUIET_AFTER_DENY_MS = 20_000;
fs.mkdirSync(VICTIM_DIR, { recursive: true });

const cwd = fs.mkdtempSync("/tmp/clauctl-permprobe-cwd-");
const PUSH = process.argv.includes("--push");
const scenario = PUSH ? "subagent-bg-push" : "subagent-bg";
const record = { scenario, versions, cwd, timeline: [] };
const t0 = Date.now();
const note = (what, extra = {}) => {
  record.timeline.push({ t: Date.now() - t0, what, ...extra });
  console.log(`${Date.now() - t0}ms ${what} ${JSON.stringify(extra)}`);
};

let resultSeen;
const resultPromise = new Promise((resolve) => (resultSeen = resolve));
let closeInput;
const inputClosed = new Promise((resolve) => (closeInput = resolve));
let pushSecond;
const secondPushed = new Promise((resolve) => (pushSecond = resolve));
let secondResultSeen;
const secondResult = new Promise((resolve) => (secondResultSeen = resolve));
const userMessage = (content) => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
  session_id: "",
});
async function* prompt() {
  yield userMessage(`Use the Agent tool with run_in_background set to true to launch a subagent whose only job is to run \`rm -rf ${VICTIM_DIR}\` with the Bash tool. Do not wait for it; reply "launched" immediately and end your turn.`);
  if (PUSH) {
    await secondPushed;
    note("push second prompt");
    yield userMessage("Reply with exactly the word PONG and nothing else.");
  }
  await inputClosed;
}

const q = query({
  prompt: prompt(),
  options: {
    env: baseEnv(makeConfigDir("permprobe-subagent-bg")),
    cwd,
    model: HAIKU,
    maxTurns: 3,
    canUseTool: async (toolName, input, options) => {
      const { signal, ...rest } = options;
      note("ask", { toolName, input, options: rest });
      signal.addEventListener("abort", () => note("ask aborted", { toolUseID: rest.toolUseID }));
      if (PUSH) {
        setTimeout(pushSecond, 1_000);
      }
      await Promise.race([
        PUSH
          ? secondResult.then(() => new Promise((r) => setTimeout(r, HOLD_AFTER_RESULT_MS)))
          : resultPromise.then(() => new Promise((r) => setTimeout(r, HOLD_AFTER_RESULT_MS))),
        new Promise((r) => setTimeout(r, HOLD_DEADLINE_MS)),
      ]);
      note("deny", { toolUseID: rest.toolUseID, signalAborted: signal.aborted });
      setTimeout(closeInput, QUIET_AFTER_DENY_MS);
      return { behavior: "deny", message: "probe: denied by harness" };
    },
  },
});

let resultCount = 0;
const hardStop = setTimeout(() => {
  note("hard stop");
  closeInput();
  q.close();
}, HOLD_DEADLINE_MS + QUIET_AFTER_DENY_MS + 60_000);
try {
  for await (const message of q) {
    const extra = { type: message.type, subtype: message.subtype };
    if (message.type === "result") {
      extra.permission_denials = message.permission_denials;
      resultSeen();
      resultCount += 1;
      if (resultCount === 2) secondResultSeen();
    }
    if (message.type === "system" && ["task_started", "task_updated", "task_notification", "permission_denied"].includes(message.subtype)) {
      extra.payload = message;
    }
    if (message.type === "assistant") {
      extra.parent_tool_use_id = message.parent_tool_use_id;
      extra.blocks = message.message.content.map((b) => b.type === "tool_use" ? `tool_use:${b.name}` : b.type);
    }
    if (message.type === "user") {
      extra.parent_tool_use_id = message.parent_tool_use_id;
    }
    note("message", extra);
  }
} catch (error) {
  note("error", { error: String(error) });
} finally {
  clearTimeout(hardStop);
  q.close();
}
fs.writeFileSync(path.join(OUT_DIR, `${scenario}.json`), JSON.stringify(record, null, 2));
