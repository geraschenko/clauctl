# Findings: which `Options` does `resume` restore, and how must clauctl persist them?

> Implementation-facing summary for clauctl's `agent.json` merge/re-apply logic.
> Verified against SDK **0.3.195** (bundled `claude`), streaming-input mode, authenticated
> sessions on an isolated `CLAUDE_CONFIG_DIR`. **Full methodology, experiment code, and
> per-field evidence live in [`README.md`](./README.md)** ("RESULTS (2026-07-02)" plus the
> E1 / E2 / equivalence-audit sections) and [`WORK-LOG.md`](./WORK-LOG.md). This file only
> states the conclusions and how to act on them.

## TL;DR

clauctl's respawn recipe is **persisted (merged) `Options` + `resume: sessionId`** in a fresh
process. `resume` restores the _conversation_ but only some _session config_. To make respawn
faithful, clauctl handles each mutable field by one of three mechanisms:

- **merge** — fold the current value into the stored `Options` and re-pass on respawn.
- **re-apply** — call the control method again _after_ the respawned session initializes
  (no `Options` path exists).
- **config-dir** — state already persists in `.claude.json`; free as long as respawn reuses
  the same config dir **and** cwd.

| field                  | mutated via                    | `resume` alone restores it? | mechanism             | notes                                                                                   |
| ---------------------- | ------------------------------ | --------------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `model`                | `setModel`                     | **yes** (carries)           | merge (redundant)     | pass it anyway so clauctl owns it explicitly                                            |
| `permissionMode`       | `setPermissionMode`            | **no** (drops)              | **merge**             | clean; `bypassPermissions` also needs the spawn dangerous-skip flag                     |
| `mcpServers` (dynamic) | `setMcpServers`                | **no** (drops)              | **merge**             | persist only the **dynamic** set clauctl manages, not settings-file/`.mcp.json` servers |
| `maxThinkingTokens`    | `setMaxThinkingTokens`         | untested¹                   | **merge + normalize** | lossy — see [Normalizing the lossy fields](#normalizing-the-lossy-fields)               |
| thinking `display`     | `setMaxThinkingTokens`         | untested¹                   | **merge + normalize** | lossy                                                                                   |
| flag `settings`        | `applyFlagSettings`            | untested¹                   | **merge + normalize** | lossy                                                                                   |
| mcp perm override      | `setMcpPermissionModeOverride` | **no** (drops)              | **re-apply**          | ephemeral in-process; persisted nowhere                                                 |
| mcp server disable     | `toggleMcpServer(x, false)`    | N/A                         | **config-dir**        | persists in `.claude.json`; to _re-enable_ you must `toggleMcpServer(x, true)`          |

¹ Resume-alone behavior wasn't run for these three. It doesn't affect the decision:
precedence is field-agnostic (proven in E1) and each has an `Options` equivalent, so merge is
the correct forward-state strategy whether or not `resume` also restores it (at worst
redundant).

**The backbone:** merge reproduces a field iff **(a) precedence** — an explicit `Option`
overrides whatever `resume` would restore — **and (b) equivalence** — the mutated runtime
state is faithfully expressible as an `Options` value. (a) was proven once on representatives
(E1); (b) is per-field (equivalence audit). This holds **in clauctl's unmanaged config
environment** (no managed-settings tier); managed/policy precedence can defeat explicit
options and is out of scope.

## How clauctl keeps the stored value current (the observability split)

The merge mechanism needs the field's **current** value at persist time. There are two
sources, and picking the wrong one for a field silently loses state:

- **Readable from the `init` message** (`SDKSystemMessage`, `sdk.d.ts:4080`) on every
  (re)spawn: **`model`**, **`permissionMode`**, **`mcp_servers`** (name + status — so the
  disabled state is visible here too), `tools`, `cwd`. clauctl can read these back after any
  spawn.
- **NOT in `init`, and there is no read-back API**: **thinking budget/display**, **flag
  `settings`**, **mcp permission override**. For these, clauctl — which _is_ the SDK client
  issuing the control calls — must **persist-on-mutation**: whenever it calls
  `setMaxThinkingTokens` / `applyFlagSettings` / `setMcpPermissionModeOverride`, record the
  arguments and fold them into `agent.json` at that moment. Never try to read them back.

Practical rule: **record the args of every state-mutating control call as you make it.** That
single discipline covers both groups and removes any dependence on introspection.

## Respawn requirements (must all hold together)

1. **Reuse the same `CLAUDE_CONFIG_DIR`.** Required for `resume` to find the transcript
   _and_ for the disable state to persist (`.claude.json` lives in the config dir).
2. **Reuse the same cwd.** The disable state is keyed `projects[<cwd>].disabledMcpServers`.
   Respawning under a different cwd silently loses the disable. (Observed gotcha: the project
   key resolved to the git **main** path, not the worktree path — worktree→main resolution —
   so "same cwd" means the path the CLI resolves to, not necessarily the literal spawn dir.)
3. **Re-pass merged `Options`** with the current values for every _merge_ field.
4. **Re-apply the mcp permission override after init.** It's a streaming-mode `Query` control
   method, so call `setMcpPermissionModeOverride(server, mode)` once the respawned session has
   initialized, per server, keyed by the exact registered server name.

## Normalizing the lossy fields

- **`maxThinkingTokens` / thinking `display`** → prefer `Options.thinking` (`ThinkingConfig`),
  not the deprecated `Options.maxThinkingTokens` (a bare `number`, can't express "clear"):
  - `setMaxThinkingTokens(null, …)` (clear limit) → omit `thinking` or use
    `{ type: 'adaptive' }`.
  - `n === 0` → `{ type: 'disabled' }`; `n > 0` → `{ type: 'enabled', budgetTokens: n }`,
    **but on Opus 4.6+ any nonzero collapses to adaptive on/off** — the exact budget does
    **not** round-trip on adaptive-only models. Store the budget you set, but don't expect
    fidelity there.
  - `display` exists only on `adaptive`/`enabled`, never `disabled`. A concrete value →
    `thinking.display`; `display === null` (API default) → omit it.
- **flag `settings`** (`applyFlagSettings`) → `Options.settings` lands in the **same**
  flag-settings precedence layer, so precedence is preserved. Two edges:
  - `applyFlagSettings` **shallow-merges** top-level keys and uses `null`-to-clear.
    Reproduce the **cumulative** shallow-merge (nulls removed) — clauctl must track this
    itself (no read-back).
  - If the stored `Options.settings` is a **path string**, folding an object mutation into it
    is non-trivial: load + merge + re-serialize, or convert the stored value to an inline
    object.

## Risks & gotchas

- **RISK-6 (version-fragile):** that `model` carries across `resume` but `permissionMode`
  does not is an **undocumented SDK asymmetry** that could flip on a version bump. clauctl's
  merge-everything strategy is robust to a flip (merge stays correct even if a dropped field
  starts carrying), so this is a low-severity watch item — re-check on SDK upgrades.
- **A config-level disable overrides `Options.mcpServers`.** Re-declaring a disabled server
  in `Options.mcpServers` will **not** re-enable it; only `toggleMcpServer(x, true)` (or
  editing `.claude.json`) does.
- **The `permission_policy` workaround is not a general substitute** for the override:
  `McpServerToolPolicy.permission_policy` exists on http/sse server configs, **not**
  `McpStdioServerConfig`, so it's unavailable for stdio servers and doesn't change the
  required re-apply action. (Structural only; not behaviorally tested.)
- **Persistence timing is out of scope.** These findings assume the merged `Options` are
  accurate at crash time. Whether clauctl always persists the latest mutation _before_ the
  process dies (persist before send? on resolve?) is a clauctl lifecycle concern, not an
  SDK-resume question.

## Scope / completeness

The eight rows cover **every `Query` control method in `sdk.d.ts` v0.3.195 that mutates
persistable session configuration** (`setModel`, `setPermissionMode`, `setMcpServers`,
`setMaxThinkingTokens`, `applyFlagSettings`, `setMcpPermissionModeOverride`,
`toggleMcpServer`). The remaining methods are read-only introspection
(`initializationResult`, `supportedModels`, `mcpServerStatus`, `getContextUsage`,
`accountInfo`, …) or transient actions (`interrupt`, `reconnectMcpServer`, `reloadPlugins`,
`reloadSkills`, `stopTask`, `streamInput`) — none carry persistable state. `seedReadState`
(file-read tracking) has no `Options` equivalent and is a separate respawn-seeding primitive,
out of scope here.

**Untested edges (stated as such):** resume-alone behavior for `maxThinkingTokens` / thinking
`display` / flag `settings`; managed-settings precedence; the `permission_policy` workaround's
runtime behavior. All findings are for SDK 0.3.195 and may shift on a version bump.
