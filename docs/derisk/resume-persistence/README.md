# Derisking experiment: which `Options` does `resume` restore, and which does it drop?

> **Implementing clauctl?** Read [`FINDINGS.md`](./FINDINGS.md) — the implementation-facing
> summary (per-field verdicts + how to persist/re-apply each). This README keeps the full
> methodology and evidence for how those conclusions were reached.

> **Handoff brief for a fresh-context agent.** Read `docs/overview.md` and
> `docs/specs/lifecycle-and-sdk-commands.md` (the "Persist mutable runtime state" and
> "agent.json Options handling" sections) first. This experiment **gates the exact
> agent.json merge set** but does not block scaffolding — Phase 1 can proceed against
> the provisional merge map and tighten it once these findings land.

## Why this matters

clauctl's respawn recipe is **persisted (merged) `Options` + `resume:
currentSessionId`** in a _fresh_ process (after a crash or daemon restart). For this
to feel like "the session was running the whole time," respawn must reproduce the
agent's **current** runtime state, including anything a client changed mid-session via
a `Query` control method (`setModel`, `setPermissionMode`, `setMcpServers`,
`applyFlagSettings`, `setMaxThinkingTokens`, `setMcpPermissionModeOverride`, …).

The open question is **how much of that state `resume` restores on its own**. The
transcript JSONL clearly carries the conversation, but it is unknown which _session
configuration_ travels with it. Anecdotally:

- **`model` changes appear to persist** across `resume`.
- **`permissionMode` changes appear NOT to persist** across `resume`.

We need a precise, per-field answer, because it determines clauctl's obligations:

- **Field that `resume` DROPS and that has an `Options` equivalent** → clauctl
  **must** merge the current value into the persisted `Options` and re-pass it on
  respawn (e.g. `permissionMode`). This is the load-bearing case.
- **Field that `resume` RESTORES** → merging is harmless/redundant; nice to confirm so
  we don't fight `resume` (e.g. is there a conflict if we _also_ pass `model`?).
- **Field with NO `Options` equivalent** (`setMcpPermissionModeOverride`,
  `toggleMcpServer`/`reconnectMcpServer`, `setMaxThinkingTokens`'s `thinkingDisplay`)
  → if `resume` drops it, clauctl must **re-apply via the control method** after
  respawn, or accept the loss. Determine which.

The deliverable is a **per-field table** that becomes the authoritative merge/re-apply
list in `docs/specs/lifecycle-and-sdk-commands.md`.

## Revised framing (2026-06-29) — the override insight collapses this experiment

> **Read this before the original "Experiment shape" below.** Working through the
> design surfaced a flaw in the original premise and a correction to the field table.
> The sections after this one are the original brief, kept for context; where they
> conflict, **this section wins**.

### The flaw: Phase B as written is conflated

The original Phase B respawns with `resume: currentSessionId` **plus the original spawn
`Options`** and asks "what did `resume` restore?". But **a field passed explicitly to
`query` is expected to override whatever `resume` would have restored from the
transcript** — and that override is the very mechanism clauctl's merge strategy relies on.
So for any field the original spawn set explicitly, Phase B measures *the option we
passed*, not *what `resume` restores* — the two are conflated and the phase answers the
wrong question.

That override is a **hypothesis, not an established fact** — proving it is the new job of
E1 below. It is *not* "almost certainly universal"; it is exactly the load-bearing thing
to test.

### The backbone: merge works iff precedence AND equivalence both hold

clauctl persists **merged** `Options` (it folds every mid-session mutation into the
stored `Options`) and respawns with **that + `resume`**, passing the **current, mutated**
value as an explicit option. For that to faithfully reproduce field `F`'s runtime state,
**two independent facts** must hold — and the original brief silently conflated them:

- **(a) Precedence** — an explicit option overrides resumed transcript state. This is
  *shared across all fields* and is tested once, on a few representatives (E1).
- **(b) Equivalence** — `F`'s mutated runtime state is *faithfully expressible* as an
  `Options` value. This is *per-field* and mostly a types/normalization question. Several
  control methods map to `Options` only lossily (see the equivalence audit below).

"Field has an `Options` equivalent → merge, full stop" is therefore **too strong**: merge
works only when *both* (a) and (b) hold. If (a) holds but (b) is lossy, clauctl must
normalize carefully; if (b) is absent entirely, the field falls to E2.

**Scope of the precedence claim:** clauctl ships **no managed-settings layer** and runs
against a scratch `CLAUDE_CONFIG_DIR`, so E1's claim is "explicit options win over resumed
session state **in an unmanaged config environment**." Managed/policy precedence can defeat
explicit options and is explicitly **out of scope** here.

### Correction to the field table

Verifying `sdk.d.ts` (v0.3.195) against the original table:

- thinking `display` **has** an `Options` equivalent — `Options.thinking.display`
  (`ThinkingAdaptive.display` / `ThinkingEnabled.display`, `sdk.d.ts:6481,6504`). The
  original "no Options equiv → re-apply/accept loss" row is **wrong**.
- `maxThinkingTokens` maps to `Options.thinking` (`budgetTokens`) / the deprecated
  `Options.maxThinkingTokens`. Merge case (lossy — see audit).
- `toggleMcpServer(server, false)` has **no** `Options` equivalent — `McpStdioServerConfig`
  (and the other server configs) carry no `enabled` field; the disabled/enabled state lives
  only in the `mcp_toggle` control request (`sdk.d.ts:3345`). So the no-`Options` set is
  **at least two** fields, not one. (`reconnectMcpServer` is an *action*, not persisted
  state — excluded.)

Re-derived table (equivalence column filled by the audit, not yet by experiment):

| field | mutated via | `Options` equivalent? | clauctl handling |
| ----- | ----------- | --------------------- | ---------------- |
| `permissionMode` | `setPermissionMode` | yes (`permissionMode`) | merge |
| `model` | `setModel` | yes (`model`) | merge |
| `maxThinkingTokens` | `setMaxThinkingTokens` | yes, **lossy** (`thinking`/`maxThinkingTokens`) | merge + normalize |
| thinking `display` | `setMaxThinkingTokens` | yes, **lossy** (`thinking.display`) | merge + normalize |
| flag `settings` | `applyFlagSettings` | yes, **lossy** (`settings`) | merge + normalize |
| `mcpServers` | `setMcpServers` | yes, dynamic-only (`mcpServers`) | merge |
| **mcp perm override** | `setMcpPermissionModeOverride` | **no** (workaround?) | E2: re-apply / accept loss / workaround |
| **mcp server disable** | `toggleMcpServer(…, false)` | **no** | E2: re-apply / accept loss |

### Agreed experiment (~8–12 sessions, not 100–200)

Three parts. **E1 runs first** to lock the precedence fact before any MCP work.

**E1 — precedence (~4–6 sessions).** Mutate field → X mid-session, kill, respawn with
`resume` + an explicit *different* Y; confirm result = Y. Representatives spanning option
shapes:

- `model` — scalar; observe `init.model`.
- `permissionMode` — scalar/security; observe `init.permissionMode` **and** a behavioral
  plan-mode probe (does a tool actually block?), because forward behavior — not just the
  reported value — is what must be correct.
- `mcpServers` — replace-shaped; Phase A declares dynamic server `mcp-x`, respawn passes
  `Options.mcpServers = { mcp-y }`. **Pass = `mcp-y` present AND `mcp-x` absent** (tests
  replace precedence, not mere omission).

Pass criterion: result reflects Y in every case. **Any case where the transcript's X wins
is a RISK-6 flag** (surprising, version-fragile).

**Equivalence audit (no sessions — types only).** Per mergeable field, document the exact
normalization from control-method args → `Options` shape, flagging lossy edges:

- `applyFlagSettings` shallow-merges top-level keys and accepts `null`-to-clear; if the
  original `Options.settings` is a **path string**, folding an object mutation into it is
  non-trivial.
- `setMaxThinkingTokens(n, display)` → `Options.thinking`: `null` clears the limit, an
  omitted `display` means "keep session-start display", and Opus-4.6 collapses the budget
  to on/off.
- `setMcpServers` replaces only **dynamic** servers; `Options.mcpServers` is equivalent for
  that layer, not for settings-file servers.

Output: a per-field `equivalence: clean | lossy(notes)` determination.

**E2 — no-`Options` fields (~4–6 sessions), behavioral.** With a throwaway stdio MCP
server, for both `setMcpPermissionModeOverride` and `toggleMcpServer(…, false)`: set the
state, kill, respawn with `resume` + the server re-declared in `Options.mcpServers` but
*without* the override/disable. Measure via **behavior** (does the tool prompt? is it
absent?) whether `resume` restored the state on its own. Then probe the workaround:
`McpServerToolPolicy.permission_policy` (`always_allow|always_ask|always_deny`,
`sdk.d.ts:1064`) is `Options`-expressible but is *per-tool static policy*, not a clean
equivalent of the *per-server runtime* override — test whether it reproduces the same
effect. Output per field: **re-apply after respawn** | **accept loss** | **workaround
exists**.

### Out of scope — persistence timing / crash window

This experiment proves that *if* clauctl's persisted merged `Options` are accurate at crash
time, respawn fidelity works. It does **not** address whether clauctl always has the latest
mutation persisted when the process dies. The transactional ordering of "persist merged
state" vs "control-method success" (persist before send? persist only on resolve? SDK
succeeds but daemon crashes before persisting?) is a **clauctl design concern**, not an
SDK-resume question, and is left to the lifecycle spec. This experiment assumes persisted
state is accurate.

## RESULTS (2026-07-02) — filled per-field table + conclusion

All sessions ran authenticated against a scratch `CLAUDE_CONFIG_DIR`
(`/tmp/clauctl-resume-derisk/`), SDK-bundled `claude`, pinned v0.3.195, in streaming-input
mode. Artifacts: `e1-*.json`, `e2-*.json` in the scratch dir; harness `harness.mjs`,
`e1.mjs`, `e2.mjs` here. Precedence (E1) was proven on three representatives spanning option
shapes and, being field-agnostic, is taken as shared; equivalence is per-field (types
audit); the two no-`Options` fields were tested behaviorally (E2).

| field | mutated via | `resume` restores alone? | `Options` equivalence | clauctl action |
| ----- | ----------- | ------------------------ | --------------------- | -------------- |
| `model` | `setModel` | **YES** — carries (E1) | clean | merge (redundant, harmless) |
| `permissionMode` | `setPermissionMode` | **NO** — drops (E1) | clean¹ | **merge (load-bearing)** |
| `mcpServers` (dynamic) | `setMcpServers` | **NO** — drops (E1) | clean, dynamic layer only² | **merge (load-bearing)** |
| `maxThinkingTokens` | `setMaxThinkingTokens` | untested³ | **lossy**⁴ | merge + normalize |
| thinking `display` | `setMaxThinkingTokens` | untested³ | **lossy**⁴ | merge + normalize |
| flag `settings` | `applyFlagSettings` | untested³ | **lossy**⁵ | merge + normalize |
| mcp perm override | `setMcpPermissionModeOverride` | **NO** — drops (E2, behavioral + no trace in config/transcripts) | **none** | **re-apply via control method after respawn** |
| mcp server disable | `toggleMcpServer(…, false)` | N/A — **config-dir persisted**⁶ | **none** | free if config dir reused; to re-enable must `toggleMcpServer(true)` (Options can't) |

¹ Re-passing `bypassPermissions` also needs the spawn-time dangerous-skip flag; clauctl
already sets it where it uses bypass. ² `setMcpServers` replaces only the dynamic layer, not
settings-file/`.mcp.json` servers; persist the dynamic set clauctl manages, not the union
from `mcpServerStatus()`. A *disabled* server isn't expressible here (no `enabled` on the
server config) — that's the disable row. ³ Resume-alone behavior not individually run;
irrelevant to the decision — with precedence (E1, field-agnostic) + equivalence holding,
merge is correct whether or not resume also restores it (at worst redundant). ⁴ `null` clear
needs `thinking` (not the deprecated `number`-only field); on Opus 4.6+ a nonzero budget
collapses to adaptive on/off so the exact budget doesn't round-trip; `display` exists only on
`adaptive`/`enabled`; no read-back API — clauctl tracks what it applied. ⁵ If persisted
`Options.settings` is a path string, folding an object mutation in is non-trivial; shallow
top-level merge with `null`-to-clear; no read-back API. ⁶ Written to `.claude.json` →
`projects[cwd].disabledMcpServers`; survives a **no-resume** fresh session in the same config
dir+cwd (E2 control), so the mechanism is config persistence, not resume; a config-level
disable also overrides an `Options.mcpServers` re-declaration.

The `McpServerToolPolicy.permission_policy` workaround (probed per the E2 plan) is **not** a
general replacement for the override: `sdk.d.ts` exposes it on http/sse server configs, not
`McpStdioServerConfig`, so it is unavailable for stdio servers; it was not behaviorally tested
here and does not change the required **re-apply** action for the mcp permission override.

**Conclusion.** clauctl **MUST merge** into `agent.json` on change: **`permissionMode`** and
**dynamic `mcpServers`** because `resume` drops them (both clean); plus **`maxThinkingTokens`
/ thinking `display` / flag `settings`** because precedence (E1) + `Options` equivalence make
merge the robust forward-state strategy even though resume-alone behavior was not tested for
them — merge **with normalization** (lossy edges in ⁴⁵). It **may merge redundantly** (resume already
restores it): **`model`** — harmless, and worth passing so clauctl controls it explicitly.
Fields with **no `Options` path**: the **mcp permission override** must be **re-applied via
`setMcpPermissionModeOverride` after every respawn** (it is ephemeral in-process — dropped on
respawn, persisted nowhere); the **mcp server disable** needs no action if clauctl reuses the
config dir (it persists in `.claude.json` independent of resume), but to *re-enable* a server
clauctl must call `toggleMcpServer(server, true)` — re-declaring it in `Options.mcpServers`
will **not** override a config-level disable. **RISK-6 (version-fragile) flag:** that `model`
carries but `permissionMode` does not is an undocumented SDK asymmetry that could flip on a
version bump; clauctl's merge-everything strategy is robust to such flips (merge stays correct
even if a dropped field starts carrying), so this is a low-severity watch item, not a blocker.

---

The original multi-field Phase B/C below is superseded by E1+E2; the original Phase A
mutation/observation mechanics still inform how each value is read back.

## CRITICAL constraint — do NOT pollute the real `~/.claude`

Every spawn in this experiment **must** set a custom **`CLAUDE_CONFIG_DIR`** pointing
at a scratch directory inside this experiment folder (or `/tmp/clauctl-resume-derisk/`),
**not** the user's real `~/.claude`. The SDK reads `CLAUDE_CONFIG_DIR` from the
subprocess env; note that `Options.env`, **when set, REPLACES the subprocess env
entirely** — so spread `process.env` and then override:

```js
env: { ...process.env, CLAUDE_CONFIG_DIR: '/abs/path/to/scratch-config' }
```

Session transcripts will then be written under
`$CLAUDE_CONFIG_DIR/projects/<cwd>/<session_id>.jsonl`. **The respawn must reuse the
same `CLAUDE_CONFIG_DIR`**, or `resume` will not find the transcript. Do not write
anything under the real `~/.claude` at any point.

## Setup

- Pinned SDK at `node_modules/@anthropic-ai/claude-agent-sdk` (version **0.3.195**).
- **Use the SDK-bundled `claude` binary** — do not point
  `pathToClaudeCodeExecutable` at the system binary; keeps results tied to the pinned
  version that clauctl ships against.
- `permissionMode: 'auto'` for the _initial_ planting turn (cheap, no
  prompts). Note: this means you must change the mode to something observably
  different (e.g. `'default'` or `'plan'`) during the run to test persistence — see
  below.
- Model the harness on `docs/derisk/clear-vs-session-experiment/exp.mjs`: a single
  long-lived `query({ prompt: <AsyncIterable of SDKUserMessage> })`, input iterable
  held open, advancing on `result`. The `Query` generator also exposes the control
  methods and the introspection methods you'll use to _observe_ state.

## Experiment shape

**Phase A — establish & mutate state (process #1).**

1. Spawn a streaming session (custom `CLAUDE_CONFIG_DIR`). Plant one trivial turn so a
   transcript exists and capture `currentSessionId` from the `system/init`.
2. Mutate as many runtime controls as cheaply observable, recording the value set:
   - `setModel(<a model different from the spawn default>)`
   - `setPermissionMode('plan')` (or any mode ≠ the spawn mode)
   - `setMaxThinkingTokens(<n>, <display>)`
   - `applyFlagSettings({ ... })` (a flag-layer setting with an observable effect)
   - `setMcpServers({...})` and/or `setMcpPermissionModeOverride(server, 'default')`
     if a cheap throwaway MCP server is available (optional — note if skipped)
3. **Observe the live state** via the introspection methods so you have a "before"
   baseline from the _same_ process: `initializationResult()` /
   `getContextUsage()` / `supportedModels()` / `mcpServerStatus()` / `accountInfo()`.
   Record exactly which method surfaces each mutated field (this also tells clauctl
   how `status` should read each value back). NOTE: the session jsonl files
   often have clearer information than the SDK messages. For example, if you
   cannot observe the new persmission mode in the SDK messages, check the jsonl
   files.
4. **Kill the process** (not `/clear` — a real cold kill; e.g. `query.close()` or
   killing the child). Confirm the child `claude` is gone.

**Phase B — cold respawn WITHOUT re-passing the mutated Options (process #2).**

5. Start a fresh `query()` with **`resume: currentSessionId`**, the **same
   `CLAUDE_CONFIG_DIR`**, and the **original spawn `Options` only** — deliberately do
   **not** re-pass the mutated `model`/`permissionMode`/etc. This isolates what
   `resume` restores on its own.
6. Immediately re-observe the same fields via the same introspection methods (or
   jsonl files; this may require sending an additional prompt). For each
   field: **restored to the Phase-A value, or reverted to the spawn default?**

**Phase C — confirm the merge fix (optional but valuable).**

7. Repeat Phase B but this time **do** pass the mutated values in the spawn `Options`
   (the merge strategy). Confirm each previously-dropped field now comes up correct,
   and that fields `resume` already restores don't conflict when also passed.

## What to capture (in this directory)

- The harness (`exp.mjs` or similar), inlined like the `/clear` experiment.
- The live event/introspection logs for Phase A, B, and (if run) C.
- The session JSONL(s) from the scratch `CLAUDE_CONFIG_DIR` (copied in), if small.
- The **per-field results table** (the headline deliverable):

  | Options field | mutated via | restored by `resume`? | has Options equiv? | clauctl action |
  | ------------- | ----------- | --------------------- | ------------------ | -------------- |
  | `permissionMode` | `setPermissionMode` | ? | yes | merge (expected) |
  | `model` | `setModel` | ? (expected yes) | yes | merge (redundant) |
  | `maxThinkingTokens` | `setMaxThinkingTokens` | ? | yes | merge |
  | thinking `display` | `setMaxThinkingTokens` | ? | no | re-apply / accept loss |
  | flag `settings` | `applyFlagSettings` | ? | yes (`settings`) | merge |
  | `mcpServers` | `setMcpServers` | ? | yes | merge |
  | mcp perm override | `setMcpPermissionModeOverride` | ? | no | re-apply / accept loss |

  (`clauctl action` ∈ {merge into persisted Options, re-apply via control method after
  respawn, accept loss}.)

## Constraints

- Keep artifacts to support your conclusions in this directory; the
  scratch `CLAUDE_CONFIG_DIR` must live in this folder or
  `/tmp/clauctl-resume-derisk/` — never the real `~/.claude`.
- This spends real credits — don't be wasteful. You can use sonnet or haiku to
  make things cheaper. However, it is expected that you'll have to run dozens
  (maybe even 100-200) actual short sessions to produce this table, and it's
  important that the table is actually correct.

## Report back (evidence-first)

The filled-in per-field table, plus a one-paragraph conclusion: **the exact set of
fields clauctl MUST merge into `agent.json` on change** (because `resume` drops them),
**the set it may merge redundantly** (because `resume` restores them), and **the set
with no Options path** that must be re-applied via a control method after respawn or
accepted as lost. Note any field whose persistence is surprising or version-fragile
(it may change on an SDK bump — that feeds RISK-6).
