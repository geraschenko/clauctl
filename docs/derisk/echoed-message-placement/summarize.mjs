// Compact one-line outcome for a captured run: result count, executed-as-turn
// markers in chain order, steer (queued_command) markers, busy-turn tool count, and
// whether the busy turn was interrupted (no DONE). Usage: node summarize.mjs <label> [sessionFile]
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const CAPTURES = join(dirname(fileURLToPath(import.meta.url)), "captures");
const label = process.argv[2];
const file = process.argv[3] || readdirSync(CAPTURES).find((f) => f.startsWith(`${label}-session-`));
const L = readFileSync(join(CAPTURES, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const MARK = /\bword (ALPHA|BRAVO|CHARLIE|ZULU)\b/g;
const exec = []; // executed as real user turns
const steer = []; // queued_command attachments (demoted next/none messages)
let busyTools = 0;
let sawDONE = false;
for (const l of L) {
  if (l.type === "user" && typeof l.message?.content === "string") {
    const ms = [...l.message.content.matchAll(MARK)].map((m) => m[1]);
    if (ms.length) exec.push(ms.length > 1 ? `{${ms.join("+")}}` : ms[0]);
  }
  if (l.attachment?.type === "queued_command") {
    const m = l.attachment.prompt.match(/\bword (\w+)\b/);
    if (m) steer.push(m[1]);
  }
  if (l.type === "assistant") {
    const c = l.message?.content || [];
    // tool calls in the FIRST turn (before any injected marker turn) approximate busy-turn tools
    busyTools += c.filter((b) => b.type === "tool_use").length;
    if (c.filter((b) => b.type === "text").map((b) => b.text).join("").includes("DONE")) sawDONE = true;
  }
}
console.log(
  `${label.padEnd(16)} exec:[${exec.join(" -> ") || "-"}]  steer:[${steer.join(",") || "-"}]  totalToolCalls:${busyTools}  busyReachedDONE:${sawDONE}`,
);
