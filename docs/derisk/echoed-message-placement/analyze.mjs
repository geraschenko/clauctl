// Render a scenario's live event timeline and its session-JSONL canonical chain.
// Usage: node analyze.mjs <label>
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURES = join(HERE, "captures");
const label = process.argv[2];

// ---- live event timeline (focus on injection vs boundaries) ----
const log = JSON.parse(readFileSync(join(CAPTURES, `${label}-events.json`), "utf8"));
console.log(`\n===== ${label}: LIVE TIMELINE =====`);
for (const e of log) {
  const at = `${String(e.seq).padStart(3)} +${String(e.t_ms).padStart(6)}ms`;
  if (e.event === "INJECT") console.log(`${at}  >>> INJECT via ${e.via} priority=${e.priority} text=${JSON.stringify(e.text?.slice(0, 40))}`);
  else if (e.event === "BOUNDARY_tool_use_partial") console.log(`${at}  --- tool_use boundary`);
  else if (e.event === "RESULT_BOUNDARY") console.log(`${at}  === RESULT #${e.count}`);
  else if (e.event === "FOLLOWUP_SEND") console.log(`${at}  >>> FOLLOWUP turn: ${JSON.stringify(e.text)}`);
  else if (e.event === "DRAIN_IDLE_CLOSE" || e.event === "HARD_TIMEOUT") console.log(`${at}  [${e.event}]`);
  else if (e.event === "msg" && e.type === "assistant") {
    const t = (e.tool_uses || []).map((u) => u.input?.command || u.name);
    console.log(`${at}  assistant ${t.length ? `tool=${JSON.stringify(t)}` : ""}${e.text ? `TEXT=${JSON.stringify(e.text.slice(0, 50))}` : ""}`);
  } else if (e.event === "msg" && e.type === "user") {
    const c = e.content || "";
    const kind = c.includes("tool_use_id") ? "(tool_result)" : JSON.stringify(c.slice(0, 50));
    console.log(`${at}  user ${kind} priority=${e.priority}`);
  } else if (e.event === "ERROR") console.log(`${at}  ERROR ${e.message}`);
}

// ---- JSONL canonical chain ----
const files = readdirSync(CAPTURES).filter((f) => new RegExp(`^${label}-session(-\\d+)?\\.jsonl$`).test(f));
for (const f of files) {
  const lines = readFileSync(join(CAPTURES, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log(`\n===== ${f}: CANONICAL CHAIN (file order) =====`);
  let i = 0;
  for (const l of lines) {
    let desc = l.type;
    if (l.type === "queue-operation") desc = `queue-operation ${l.operation}${l.content ? ` content=${JSON.stringify(l.content.slice(0, 45))}` : ""}`;
    else if (l.type === "last-prompt") desc = `last-prompt leaf=${(l.leafUuid || "").slice(0, 8)}`;
    else if (l.type === "user") {
      const c = l.message?.content;
      if (typeof c === "string") desc = `user TEXT=${JSON.stringify(c.slice(0, 50))}`;
      else if (Array.isArray(c)) desc = `user [${c.map((b) => b.type).join(",")}]`;
    } else if (l.type === "assistant") {
      const c = l.message?.content || [];
      const t = c.filter((b) => b.type === "tool_use").map((b) => b.input?.command || b.name);
      const txt = c.filter((b) => b.type === "text").map((b) => b.text).join("");
      desc = `assistant ${t.length ? `tool=${JSON.stringify(t)} ` : ""}${txt ? `TEXT=${JSON.stringify(txt.slice(0, 40))}` : ""}`;
    }
    const prio = l.priority ? ` prio=${l.priority}` : "";
    console.log(`${String(i++).padStart(2)} ${(l.type || "?").padEnd(15)}| uuid=${(l.uuid || "--").slice(0, 8)} parent=${(l.parentUuid === null ? "null" : l.parentUuid || "--").toString().slice(0, 8)}${prio} | ${desc}`);
  }
}
