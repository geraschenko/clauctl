// E1 — precedence: does an explicit Option override resumed transcript state?
//
// For a given field, Phase A spawns a session, mutates the field to X via a
// control method, and kills the process. Phase B respawns with `resume` + the
// SAME CLAUDE_CONFIG_DIR + an explicit *different* value Y. Pass = observed Y.
//
// Usage: node e1.mjs <field>   field ∈ { model, permissionMode }
//
// SECURITY: never touches the real ~/.claude — every spawn sets a scratch
// CLAUDE_CONFIG_DIR. Uses the SDK-bundled `claude` binary (no
// pathToClaudeCodeExecutable override).

import { writeFileSync } from "fs";
import { makeSession, baseEnv, everythingServer, CONFIG_DIR, HAIKU } from "./harness.mjs";

const FIELD = process.argv[2] || "model";

// Per-field config: the two competing values and how to mutate/observe.
// X = value planted in process #1 (via control method); Y = explicit Option in
// process #2. X, Y, and the spawn default are all chosen to be mutually
// distinct so the observed value is unambiguous.
// `otherFixed` is the baseline for the NON-tested field, held constant across
// all phases so it never contaminates the observation. The tested field is set
// ONLY where we intend to: its spawn default in Phase A, nothing in the control
// (B0), and the explicit Y in Phase B.
const FIELDS = {
  model: {
    spawnDefault: HAIKU,
    X: "claude-sonnet-4-6",           // planted via setModel in process #1
    Y: HAIKU,                          // explicit Options.model in process #2
    otherFixed: { permissionMode: "bypassPermissions" },
    spawnDefaultOption: { model: HAIKU },
    mutate: (q, v) => q.setModel(v),
    observe: (init) => init.model,
    respawnOption: (v) => ({ model: v }),
  },
  permissionMode: {
    spawnDefault: "bypassPermissions",
    X: "plan",                         // planted via setPermissionMode in #1
    Y: "acceptEdits",                  // explicit Options.permissionMode in #2
    // No-tool text turns never trigger a permission prompt, so omitting
    // permissionMode in the control is safe even though it defaults to 'default'.
    otherFixed: { model: HAIKU },
    spawnDefaultOption: { permissionMode: "bypassPermissions" },
    mutate: (q, v) => q.setPermissionMode(v),
    observe: (init) => init.permissionMode,
    respawnOption: (v) => ({ permissionMode: v }),
  },
  mcpServers: {
    // X/Y are dynamic-server SETS keyed by name; observe returns the sorted
    // names present in init.mcp_servers. Precedence pass tests REPLACE (Y in,
    // X out), not mere omission.
    X: { "mcp-x": everythingServer },
    Y: { "mcp-y": everythingServer },
    otherFixed: { model: HAIKU, permissionMode: "bypassPermissions" },
    spawnDefaultOption: {},                       // process #1 starts with no dynamic servers
    mutate: (q, v) => q.setMcpServers(v),
    // Filter to servers WE declared. The account's claude.ai integrations
    // (Gmail/Drive/Calendar) auto-connect whenever a dynamic server is loaded
    // and are re-synced from the OAuth profile server-side (can't be stripped
    // from the scratch config); they're inherited noise, irrelevant to the
    // mcp-x/mcp-y precedence verdict.
    observe: (init) => (init.mcp_servers || []).map((s) => s.name).filter((n) => n.startsWith("mcp-")).sort(),
    respawnOption: (v) => ({ mcpServers: v }),
    // resume "carries" the mutation iff mcp-x is still present with no explicit option
    resumeCarriesX: (o) => o.includes("mcp-x"),
    // precedence holds iff explicit Y replaced X: mcp-y present AND mcp-x absent
    precedencePass: (o) => o.includes("mcp-y") && !o.includes("mcp-x"),
    fmt: (o) => `[${o.join(",")}]`,
  },
};

const cfg = FIELDS[FIELD];
if (!cfg) throw new Error(`unknown field: ${FIELD}`);
// Scalar defaults; mcpServers overrides these with set-aware predicates.
cfg.precedencePass = cfg.precedencePass || ((o) => o === cfg.Y);
cfg.resumeCarriesX = cfg.resumeCarriesX || ((o) => o === cfg.X);
cfg.fmt = cfg.fmt || ((o) => String(o));

const log = [];
const rec = (o) => { log.push(o); console.error(JSON.stringify(o)); };

// --- Phase A: plant, mutate to X, capture session_id, kill ---------------
rec({ phase: "A", field: FIELD, spawnDefault: cfg.spawnDefault, X: cfg.X, Y: cfg.Y });

// Process #1 spawns at the field's spawn default, so the mutation to X is an
// observable change.
const a = makeSession({
  ...cfg.otherFixed,
  ...cfg.spawnDefaultOption,
  env: baseEnv(),
});

await a.send("Reply with exactly: OK");
rec({ phase: "A", step: "after_plant", init: cfg.observe(a.lastInit()) });

await cfg.mutate(a.q, cfg.X);
// force a fresh init so the mutated value is observable in-process
await a.send("Reply with exactly: OK2");
const aInitAfter = a.lastInit();
rec({ phase: "A", step: "after_mutate", observed: cfg.observe(aInitAfter), expectedX: cfg.X });

const sessionId = aInitAfter.session_id;
rec({ phase: "A", step: "captured_session", sessionId });

a.close();
await new Promise((r) => setTimeout(r, 500));  // let child exit + transcript flush

// --- Phase B0 (control): resume WITHOUT re-passing the field --------------
// Isolates what `resume` restores on its own. If it comes back as X, `resume`
// carries the field (merge is redundant); if it reverts to the spawn default,
// `resume` drops it (merge is load-bearing).
const b0 = makeSession({
  ...cfg.otherFixed,   // tested field deliberately OMITTED
  resume: sessionId,
  env: baseEnv(),
});
await b0.send("Reply with exactly: OK-control");
const restoredByResume = cfg.observe(b0.lastInit());
const resumeRestoresX = cfg.resumeCarriesX(restoredByResume);
rec({ phase: "B0-control", restoredByResume: cfg.fmt(restoredByResume), resumeRestoresX });
b0.close();
await new Promise((r) => setTimeout(r, 500));

// --- Phase B (precedence): resume + explicit Y, observe ------------------
rec({ phase: "B", resume: sessionId, explicit: cfg.respawnOption(cfg.Y) });

const b = makeSession({
  ...cfg.otherFixed,
  resume: sessionId,
  env: baseEnv(),
  ...cfg.respawnOption(cfg.Y),
});

await b.send("Reply with exactly: OK3");
const bInit = b.lastInit();
const observedB = cfg.observe(bInit);
rec({ phase: "B", step: "observed", observed: cfg.fmt(observedB), sessionId: bInit.session_id });

const precedenceHolds = cfg.precedencePass(observedB);
rec({ phase: "RESULT", field: FIELD, precedenceHolds, resumeRestoresX, observedY: cfg.fmt(observedB), restoredByResume: cfg.fmt(restoredByResume) });

b.close();

writeFileSync(`${CONFIG_DIR}/e1-${FIELD}.json`, JSON.stringify(log, null, 2));
console.log(`\n=== E1 ${FIELD}: precedence=${precedenceHolds ? "PASS" : "FAIL"} (explicit Y → observed ${cfg.fmt(observedB)}); ` +
  `resume-alone restored ${cfg.fmt(restoredByResume)} (${resumeRestoresX ? "resume CARRIES field" : "resume DROPS field"}) ===`);
process.exit(0);
