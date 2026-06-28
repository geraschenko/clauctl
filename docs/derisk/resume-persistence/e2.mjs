// E2 — do the no-`Options` fields survive `resume`?  (behavioral)
//
// Two runtime states have NO serializable Options equivalent for a stdio server:
//   (a) setMcpPermissionModeOverride(server, 'default')  — per-server perm override
//   (b) toggleMcpServer(server, false)                   — per-server disable
// For each: set the state in process #1, kill, respawn with the SAME server
// re-declared in Options.mcpServers but WITHOUT re-applying the state, and
// measure BEHAVIORALLY whether `resume` restored it.
//
// Signals (reviewer-approved):
//   - override: does the echo tool trigger a permission prompt? We instrument
//     `canUseTool` — it fires only when a prompt is required. Under
//     bypassPermissions with no override, echo auto-allows (no canUseTool). With
//     the override → 'default', echo must prompt (canUseTool fires).
//   - disable: mcpServerStatus() status === 'disabled' AND the echo tool absent
//     from init.tools (model-independent).
//
// IMPORTANT — disable is config-dir-persisted, not transcript state. The CLI
// records toggleMcpServer in `.claude.json` → projects[cwd].disabledMcpServers.
// So the disable survives ANY new session sharing that config dir + cwd, with or
// without `resume`. To attribute the mechanism we run BOTH a resume respawn AND a
// NO-resume control; if the fresh (no-resume) session is also disabled, the
// persistence is config-level, not resume-level. We reset disabledMcpServers
// before Phase A so each run starts clean.
//
// Usage: node e2.mjs [override|disable|both]   (default both)
//
// SECURITY: scratch CLAUDE_CONFIG_DIR only; SDK-bundled binary.

import { writeFileSync, readFileSync } from "fs";
import { makeSession, baseEnv, everythingServer, CONFIG_DIR } from "./harness.mjs";

const WHICH = process.argv[2] || "both";
const SERVER = "everything";
const ECHO_TOOL = `mcp__${SERVER}__echo`;
// Sonnet is far more reliable than haiku at actually invoking a named tool,
// which the override probe depends on (no tool call ⇒ no permission decision).
const MODEL = "claude-sonnet-4-6";
const CALL_PROMPTS = [
  `Call the ${ECHO_TOOL} tool with message "ping". Do not answer in text — just invoke the tool.`,
  `You MUST call the tool named ${ECHO_TOOL} now with {"message":"ping"}. Respond with only the tool call, no prose.`,
  `Invoke ${ECHO_TOOL} with arguments {"message":"ping"}. This is a required test step. Just the tool call.`,
];

const log = [];
const rec = (o) => { log.push(o); console.error(JSON.stringify(o)); return o; };

// A canUseTool recorder: fires only when a tool needs a permission decision.
// Returns allow so the turn completes; we only care that it was consulted.
function permRecorder() {
  const asked = [];
  const canUseTool = async (toolName) => { asked.push(toolName); return { behavior: "allow" }; };
  return { asked, canUseTool };
}

// Did this turn's messages contain an assistant tool_use for the echo tool?
function calledEcho(msgs) {
  return msgs.some((m) => m.type === "assistant" &&
    Array.isArray(m.message?.content) &&
    m.message.content.some((b) => b.type === "tool_use" && String(b.name).includes("echo")));
}

// Drive the model to actually invoke the echo tool, retrying with escalating
// instructions. Returns { called, promptedForEcho } where promptedForEcho is
// whether canUseTool fired for echo during the turn the tool was invoked.
async function forceEcho(session, asked) {
  for (const prompt of CALL_PROMPTS) {
    const before = asked.length;
    const msgs = await session.send(prompt);
    if (calledEcho(msgs)) return { called: true, promptedForEcho: asked.slice(before).some((t) => t.includes("echo")) };
  }
  return { called: false, promptedForEcho: false };
}

// Clear any persisted server-disable state so a disable run starts clean.
function resetDisabledMcp() {
  const p = `${CONFIG_DIR}/.claude.json`;
  const d = JSON.parse(readFileSync(p, "utf8"));
  for (const cfg of Object.values(d.projects || {})) {
    if (cfg && Array.isArray(cfg.disabledMcpServers)) cfg.disabledMcpServers = [];
  }
  writeFileSync(p, JSON.stringify(d, null, 2));
}


const spawnOpts = (extra) => ({
  model: MODEL,
  permissionMode: "bypassPermissions",   // auto-allows, so an override to 'default' is observable
  mcpServers: { [SERVER]: everythingServer },
  env: baseEnv(),
  ...extra,
});

// ---------------------------------------------------------------- override --
async function runOverride() {
  resetDisabledMcp();   // clear any persisted disable so echo is actually available
  rec({ exp: "override", phase: "A", note: "bypassPermissions baseline, then override→default" });
  const rA = permRecorder();
  const a = makeSession(spawnOpts({ canUseTool: rA.canUseTool }));

  await a.send("Reply with exactly: OK");
  // Baseline: under bypassPermissions, echo should auto-allow (canUseTool silent).
  const base = await forceEcho(a, rA.asked);
  rec({ exp: "override", phase: "A", step: "baseline_bypass", ...base });

  const warn = await a.q.setMcpPermissionModeOverride(SERVER, "default");
  rec({ exp: "override", phase: "A", step: "override_set", warning: warn?.warning ?? null });

  // With the override, echo must now route through canUseTool (prompt required).
  const tight = await forceEcho(a, rA.asked);
  rec({ exp: "override", phase: "A", step: "after_override", ...tight });

  const sessionId = a.lastInit().session_id;
  a.close();
  await new Promise((r) => setTimeout(r, 500));

  // Respawn: resume + same server, NO override re-applied.
  const rB = permRecorder();
  const b = makeSession(spawnOpts({ resume: sessionId, canUseTool: rB.canUseTool }));
  await b.send("Reply with exactly: OK-resume");
  const onResume = await forceEcho(b, rB.asked);
  rec({ exp: "override", phase: "B", step: "resume_no_reapply", ...onResume });
  b.close();
  await new Promise((r) => setTimeout(r, 500));

  // Validity gates before drawing a conclusion:
  //  - baseline echo must be called and NOT prompted (bypass auto-allows)
  //  - after-override echo must be called AND prompted (override took effect in-process)
  //  - resume echo must be called (else we can't observe the permission path)
  let verdict;
  if (!base.called || !tight.called || !onResume.called) verdict = "INCONCLUSIVE — echo not invoked";
  else if (base.promptedForEcho) verdict = "INVALID — bypass baseline prompted (unexpected)";
  else if (!tight.promptedForEcho) verdict = "INVALID — override did not take effect in-process";
  else verdict = onResume.promptedForEcho ? "resume RESTORES override" : "resume DROPS override";
  rec({ exp: "override", phase: "RESULT", base, tight, onResume, verdict });
  return { verdict, base, tight, onResume };
}

// Observe a session's view of the server: connection status + echo availability.
async function observeServer(s) {
  const status = (await s.q.mcpServerStatus()).find((x) => x.name === SERVER)?.status ?? "absent";
  const echoInTools = (s.lastInit().tools || []).includes(ECHO_TOOL);
  return { status, echoInTools, disabled: status === "disabled" && !echoInTools };
}

// ----------------------------------------------------------------- disable --
async function runDisable() {
  resetDisabledMcp();   // clean slate: no persisted disable from a prior run
  rec({ exp: "disable", phase: "A", note: "confirm echo available, then toggle off" });
  const a = makeSession(spawnOpts({}));
  await a.send("Reply with exactly: OK");
  rec({ exp: "disable", phase: "A", step: "before_toggle", ...(await observeServer(a)) });

  await a.q.toggleMcpServer(SERVER, false);
  await a.send(CALL_ECHO);   // fresh turn/init so tool availability reflects the toggle
  const afterToggle = await observeServer(a);
  rec({ exp: "disable", phase: "A", step: "after_toggle_off", ...afterToggle });

  const sessionId = a.lastInit().session_id;
  a.close();
  await new Promise((r) => setTimeout(r, 500));

  // Respawn #1: RESUME + same server re-declared, NO toggle re-applied.
  const b = makeSession(spawnOpts({ resume: sessionId }));
  await b.send("Reply with exactly: OK-resume");
  const onResume = await observeServer(b);
  rec({ exp: "disable", phase: "B-resume", step: "resume_no_reapply", ...onResume });
  b.close();
  await new Promise((r) => setTimeout(r, 500));

  // Respawn #2 CONTROL: NO resume — brand-new session in the same config dir +
  // cwd, server re-declared. Isolates config-dir persistence from resume.
  const c = makeSession(spawnOpts({}));
  await c.send("Reply with exactly: OK-fresh");
  const onFresh = await observeServer(c);
  rec({ exp: "disable", phase: "C-fresh-control", step: "no_resume", ...onFresh });
  c.close();
  await new Promise((r) => setTimeout(r, 500));

  // Attribute the mechanism. Config-level persistence ⇒ both resume AND fresh are
  // disabled. Resume-specific ⇒ only resume is disabled, fresh is enabled.
  let mechanism;
  if (onResume.disabled && onFresh.disabled) mechanism = "config-dir persistence (survives even without resume)";
  else if (onResume.disabled && !onFresh.disabled) mechanism = "resume-restored (transcript state)";
  else if (!onResume.disabled) mechanism = "NOT persisted by resume (dropped)";
  else mechanism = "ambiguous";
  rec({ exp: "disable", phase: "RESULT", onResume, onFresh, mechanism });
  return { mechanism, onResume, onFresh };
}

// -------------------------------------------------------------------- main --
const out = {};
if (WHICH === "override" || WHICH === "both") out.override = await runOverride();
if (WHICH === "disable" || WHICH === "both") out.disable = await runDisable();

writeFileSync(`${CONFIG_DIR}/e2-${WHICH}.json`, JSON.stringify(log, null, 2));
console.log(`\n=== E2 (${WHICH}) ===`);
if (out.override) console.log(`  override: ${out.override.verdict}`);
if (out.disable) console.log(`  disable:  ${out.disable.mechanism}`);
process.exit(0);
