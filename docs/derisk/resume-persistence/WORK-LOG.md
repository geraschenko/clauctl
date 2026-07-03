# Work log — resume-persistence derisk

Resume anchor for a post-compaction agent. The authoritative plan is the
**"Revised framing (2026-06-29)"** section of `README.md` (reviewer-APPROVED). This file
only tracks live state the README doesn't carry.

## Status (as of 2026-07-02) — COMPLETE

- **DONE and reviewer-APPROVED.** All deliverables landed: **E1** (precedence),
  **equivalence audit** (types-only), **E2** (no-Options fields), and the filled per-field
  table + conclusion in `README.md` ("RESULTS (2026-07-02)").
- Reviewer `8eb2f26b` approved after one CHANGES-REQUESTED round (3 wording fixes applied)
  and has been **archived**.

## Key facts not in README.md

- **Reviewer handle:** pictl agent `8eb2f26b` (tag `resume-derisk-reviewer`), cwd this
  repo. Talk to it with `pictl prompt -t 8eb2f26b - <<'EOF' … EOF`. Use it to review
  experiment results before finalizing the table. Archive when done:
  `pictl archive -t 8eb2f26b`. Reviewer skill: `/home/anton/git/geraschenko/pictl/skills/pictl/reviewer.md`.
- **Scratch config dir decision:** use `CLAUDE_CONFIG_DIR=/tmp/clauctl-resume-derisk/`
  for the live sessions (NEVER the real `~/.claude`); copy small session JSONLs into this
  experiment folder as evidence. Env must be `{ ...process.env, CLAUDE_CONFIG_DIR }` since
  `Options.env` replaces the subprocess env entirely.
- **Harness:** not yet written. Model it on `docs/derisk/clear-vs-session-experiment/exp.mjs`
  (single long-lived `query({ prompt: <AsyncIterable> })`, input held open, advance on
  `result`). Import `query` from the pinned SDK
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, v0.3.195). Use the SDK-bundled
  `claude` binary (do NOT set `pathToClaudeCodeExecutable` to the system binary).
- **Model for throwaway sessions:** sonnet or haiku to keep credits down (pending user
  confirmation of exact id).
- **Observation channels:** `system/init` carries `model`, `permissionMode`, `mcp_servers`
  only. `settings`/`thinking`/mcp-override need behavioral or jsonl probes. Introspection
  methods on the `Query` generator: `initializationResult()`, `getContextUsage()`,
  `supportedModels()`, `mcpServerStatus()`, `accountInfo()`.

## Harness

- `e1.mjs` (this dir) — parametrized by field (`model` | `permissionMode`). Runs Phase A
  (spawn at spawn-default, mutate → X via control method, capture session_id, kill),
  Phase B0 control (resume, tested field OMITTED → what resume restores on its own),
  Phase B precedence (resume + explicit Y → confirm Y wins). Writes
  `/tmp/clauctl-resume-derisk/e1-<field>.json`. Non-tested field held fixed via
  `otherFixed` so it never contaminates the observation.

## AUTH — resolved

Scratch config had no credentials → turns returned synthetic `"Not logged in"`. **Fixed:
copied `~/.claude/.credentials.json` → `/tmp/clauctl-resume-derisk/.credentials.json`**
(reads real `~/.claude`, writes only scratch; does NOT pollute real `~/.claude`). All
runs below are authenticated (real replies confirmed in transcripts). **Auth matters even
for config-level observation** — see the model flip below.

## MCP test vehicle

Use the official reference server **`@modelcontextprotocol/server-everything`** (offline,
deterministic `echo` tool; npx-cached). Launch: `npx -y @modelcontextprotocol/server-everything`
(stdio). No dummy server needed. `@upstash/context7-mcp` is also cached but is
network/auth-dependent — avoid.

## Harness files (this dir)

- `harness.mjs` — shared: `makeSession()` (manually-driven streaming session; `send()`
  resolves on `result`; control methods on `.q`), `baseEnv()` (scratch CLAUDE_CONFIG_DIR),
  `everythingServer` (stdio, alwaysLoad), `CONFIG_DIR`, `HAIKU`.
- `e1.mjs <model|permissionMode|mcpServers>` — E1 (DONE).
- `e2.mjs <override|disable|both>` — E2. `disable` DONE. `override` IN PROGRESS (see below).

## RESOLVED — the override blocker was disable-pollution, NOT tool-search deferral

Earlier this was recorded as a "tool-search deferral" obstacle (a `ToolSearch` tool appears
because the child has ~45–65 tools). That was a **misdiagnosis**. Corrected 2026-07-02:
`mcp__everything__echo` is ALWAYS in the model's top-level tool list — the model itself
reported "the search returned no deferred tools; echo is already loaded." The real reason
echo was never invoked in the override runs: **echo was config-disabled** by leftover
`disabledMcpServers` pollution from the E2 disable runs, and `runOverride` never called
`resetDisabledMcp()`. Fix: added `resetDisabledMcp()` at the top of `runOverride`. After
that, echo invokes on the first prompt and the behavioral signal is clean. (Also: the
scratch `.credentials.json` had expired — OAuth tokens time out — and was re-copied from
`~/.claude`; watch for "Not logged in" on any future run and refresh.)

## Results

- **E1 — precedence (model, permissionMode): DONE, authenticated, stable (3 runs).**
  Precedence **HOLDS** for both (explicit Y always wins: model→haiku, permissionMode→acceptEdits).
  Resume-alone (control) differs per field:
  - **`model`: resume CARRIES it** — resume-alone restores the mutated `claude-sonnet-4-6`
    (== X). ⇒ merge is **redundant but harmless**. (Matches the README anecdote; the SDK
    behaves like `claude --resume` here.)
  - **`permissionMode`: resume DROPS it** — resume-alone reverts to `default` (!= X=plan),
    even authenticated. Transcript records permissionMode per-message (`plan` present) yet
    it's not restored → recorded-but-not-restored. ⇒ merge is **load-bearing**.
  - **⚠ Methodology note (not a finding):** an earlier UNauthenticated run showed
    model→`claude-opus-4-8` on resume ("drops"). That was an **artifact** — the errored
    session fell to CLI default before the resume path ran. Corrected once authed. Lesson:
    always run authed, even for init-only observations.
  - **`mcpServers` (replace-shaped): DONE.** Phase A adds dynamic `mcp-x` via
    `setMcpServers`. Resume-alone → `[]` (**resume DROPS** dynamically-added servers).
    Phase B with explicit `Options.mcpServers={mcp-y}` → `[mcp-y]`, mcp-x absent
    (**replace precedence HOLDS**). ⇒ merge is **load-bearing**.
    - Note: the account's claude.ai integrations (Gmail/Drive/Calendar) auto-connect
      alongside any loaded dynamic server and re-sync from the OAuth profile server-side
      (can't strip from scratch config). Filtered to `mcp-*` in observe(); inherited
      noise, irrelevant to the verdict.
  - **E1 VERDICT: precedence hypothesis PROVEN for all 3 option shapes** (scalar,
    security-scalar, replace). Explicit option always wins in the unmanaged scratch env.
- **Equivalence audit (types-only, sdk.d.ts v0.3.195): DONE.** Per mergeable field,
  control-method args → `Options` normalization. `clean` = faithful round-trip;
  `lossy(...)` = normalization or fidelity caveat.
  - **`model` — clean.** `setModel(model?: string)` ↔ `Options.model?: string` (identical).
    `setModel(undefined)` ("use default") ↔ omit `Options.model`. No loss.
  - **`permissionMode` — clean (one spawn-flag edge).** `setPermissionMode(PermissionMode)`
    ↔ `Options.permissionMode?: PermissionMode` (same enum, `sdk.d.ts:1664`). Edge: to
    re-pass `bypassPermissions` the respawn Options must ALSO carry the dangerous-skip flag
    (`bypassPermissions` "requires allowDangerouslySkipPermissions", `sdk.d.ts:1660`);
    clauctl already sets this where it uses bypass, so not lossy in practice.
  - **`mcpServers` — clean for the dynamic layer only.** `setMcpServers(Record<string,
    McpServerConfig>)` ↔ `Options.mcpServers?: Record<string,McpServerConfig>` (same type).
    But `setMcpServers` replaces only the **dynamic** server layer, not settings-file /
    `.mcp.json` servers; the value clauctl persists must be the dynamic set it manages, not
    the union reported by `mcpServerStatus()`. Also `McpStdioServerConfig` has no `enabled`
    field, so a _disabled_ server is NOT expressible here — that's the E2 disable case.
  - **`maxThinkingTokens` / thinking `display` — lossy.** `setMaxThinkingTokens(n: number|
    null, display?: 'summarized'|'omitted'|null)` maps to `Options.thinking?: ThinkingConfig`
    (preferred) or the deprecated `Options.maxThinkingTokens?: number`. Edges:
    (1) `n=null` (clear limit) can't be expressed by the deprecated `number`-only field —
    must use `thinking` (omit / `{type:'adaptive'}`). (2) `n=0` → `{type:'disabled'}`;
    `n>0` → `{type:'enabled', budgetTokens:n}` — BUT on **Opus 4.6+** any nonzero collapses
    to adaptive on/off (the exact budget is ignored, `sdk.d.ts:2248-2251,1594-1596`), so the
    budget number does **not** round-trip on adaptive-only models. (3) `display` lives only
    on `adaptive`/`enabled`, never `disabled`; `display=null` = "API default" (express by
    omitting), a concrete value → `thinking.display`. (4) No introspection method returns the
    live (budget, display) pair cleanly ⇒ clauctl must track what it applied, not read it back.
  - **flag `settings` — lossy.** `applyFlagSettings({[K in keyof Settings]?: Settings[K]|
    null})` ↔ `Options.settings?: string | Settings` (`sdk.d.ts:1800`), landing in the SAME
    "flag settings" precedence layer (above user/project/local, below managed) so precedence
    is preserved. Edges: (1) if the persisted `Options.settings` is a **path string**, folding
    an object-shaped mutation in requires loading+merging the file or converting to an inline
    object — non-trivial. (2) `applyFlagSettings` shallow-merges top-level keys and uses
    `null`-to-clear; clauctl must reproduce the _cumulative_ shallow-merge (nulls removed),
    which it must track itself (no read-back API).
- **E2 — no-Options fields:**
  - **disable (`toggleMcpServer(server,false)`): DONE.** Mechanism = **config-dir
    persistence**, NOT resume. State is written to `.claude.json` →
    `projects[cwd].disabledMcpServers=[server]`. Verified with a 3-way probe: after
    kill, BOTH a resume respawn AND a **no-resume fresh** session (same config dir+cwd,
    server re-declared) show `status:'disabled'` + echo absent from `init.tools`. Also:
    re-declaring the server in `Options.mcpServers` does **NOT** re-enable it — the
    config-level disable overrides the Options declaration. ⇒ clauctl gets disable
    persistence for free IF it reuses the config dir; to re-enable it must
    `toggleMcpServer(true)` or edit `.claude.json` (Options won't do it).
    - Note: the cwd project key in `.claude.json` resolves to the git main path
      (`/home/anton/git/geraschenko/clauctl`), not the treehouse worktree path — likely
      worktree→main resolution. Tangential but noted.
  - **override (`setMcpPermissionModeOverride`): DONE — resume DROPS it.**
    Confirmed two independent ways:
    - **Behavioral (`e2-override.json`, all validity gates passed):** under
      `bypassPermissions`, baseline echo auto-allows (`canUseTool` silent). After
      `setMcpPermissionModeOverride('everything','default')`, echo routes through
      `canUseTool` (prompt fires) — override took effect in-process. After kill +
      `resume` with the SAME server re-declared but the override NOT re-applied, echo
      auto-allows again (`canUseTool` silent) → **override dropped**.
    - **Config inspection:** the override leaves **zero trace** — `grep -ri override`
      across the entire scratch config dir AND all 30 session transcripts finds nothing
      (only an incidental "overrides all triggers" in a tool description). `.claude.json`
      is byte-identical before/after (warning=null so the call was accepted). Unlike
      disable, there is NO config-dir persistence.
    - ⇒ override is **ephemeral in-process**, dropped on any respawn → clauctl **must
      re-apply via `setMcpPermissionModeOverride` after every respawn** (re-apply is
      load-bearing; no config or transcript mechanism does it for free).
  - **Workaround probe (McpServerToolPolicy.permission_policy):** STRUCTURAL FINDING —
    `tools?:McpServerToolPolicy[]` exists on **http/sse** server configs but **NOT**
    `McpStdioServerConfig` (command/args/env/timeout/alwaysLoad only). So the per-tool
    `permission_policy` (`always_allow|always_ask|always_deny`) workaround is
    **transport-limited**: unavailable for stdio servers; would need the server run as
    http/sse to test. Not yet behaviorally tested.

## NEXT STEPS (post-compaction)

1. ~~Finish E2 override~~ — DONE (resume DROPS override; behavioral + config-inspection).
2. Task #3 equivalence audit (types-only, no sessions): per mergeable E1 field, document
   control-method-args → Options normalization + lossy edges (see README "Equivalence
   audit" section).
3. Task #5: fill the per-field table in README, get reviewer (`8eb2f26b`) approval, then
   `pictl archive -t 8eb2f26b`.

## Reviewer status

Reviewer `8eb2f26b` ACCEPTED E1 (bound wording to "tested version + unmanaged config") and
APPROVED the E2 design with 5 conditions (all incorporated): override needs a mode where it
matters (used bypassPermissions); distinguish prompt vs denial (used canUseTool-fires);
disable via status+behavior (used mcpServerStatus + init.tools); same server name on resume
(done); permission_policy is per-tool (noted, and found transport-limited). Reviewer has NOT
yet seen E2 results.
